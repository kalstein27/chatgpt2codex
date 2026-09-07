import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { JsonOAuthClientsStore, JsonOAuthStore } from "./oauth-store.js";

/**
 * SingleUserOAuthProvider — OAuth 2.1 authorization-code + PKCE(S256) flow
 * gated by a single owner token and backed by the JSON-file store
 * (see ./oauth-store.ts).
 *
 * PRD refs: §7 (auth), §11 SR-04 (owner secret), SR-05 (/authorize hardening),
 * SR-12 (UI/OAuth hardening — CSP/Host allowlist applied by src/server/http.ts).
 */

export interface OAuthConfig {
  /**
   * Timing-safe verifier for the owner token submitted on the
   * `/authorize` form. Only the SHA-256 hash of the real token is ever held
   * in memory/disk (see src/auth/owner-token.ts) — this callback is how the
   * provider checks a candidate without needing the plaintext itself.
   */
  verifyOwnerToken: (candidate: string) => Promise<boolean>;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
  onOwnerTokenAttempt?: (event: {
    outcome: "failure" | "locked_out";
    clientIp: string;
    clientId: string;
    clientName?: string;
  }) => Promise<void> | void;
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

export interface PendingOAuthLocalApprovalSummary {
  requestId: string;
  status: "pending" | "approved" | "rejected" | "expired";
  clientName: string;
  scopes: string[];
  resource: string;
  redirectHost: string;
  createdAt: number;
  expiresAt: number;
}

interface PendingOAuthLocalApprovalRecord extends PendingOAuthLocalApprovalSummary {
  browserToken: string;
  browserTokenHash: string;
  requestKey: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  redirectUrl?: string;
}

export interface OAuthLocalApprovalPageSession {
  requestId: string;
  browserToken: string;
}

export interface OAuthLocalApprovalBrowserStatus {
  status: PendingOAuthLocalApprovalSummary["status"];
  redirectUrl?: string;
}

const CODE_TTL_MS = 5 * 60 * 1000;
const LOCAL_APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_LOCAL_APPROVALS = 32;

/** SR-05: bounded in-memory rate limiting for the owner-token prompt. */
const MAX_ATTEMPTS_BEFORE_BACKOFF = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_IPS = 1000;
const GLOBAL_FAILURE_WINDOW_MS = 60 * 1000;
const MAX_GLOBAL_FAILURES_PER_WINDOW = 60;

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type OAuthPageLocale = string;

interface OAuthPageCopy {
  title: string;
  badge: string;
  intro: string;
  client: string;
  scope: string;
  resource: string;
  label: string;
  placeholder: string;
  hint: string;
  button: string;
  expiredError: string;
  lockedError: string;
  rejectedError: string;
}

const SUPPORTED_OAUTH_LOCALES = new Set([
  "en",
  "ko",
  "ja",
  "zh-Hans",
  "zh-Hant",
  "es",
  "fr",
  "de",
  "pt-BR",
  "it",
  "nl",
  "pl",
  "ru",
  "tr",
  "vi",
  "id",
  "th",
  "ar",
  "hi",
  "uk",
]);

function normalizeOAuthLocale(candidate: string): OAuthPageLocale | undefined {
  const value = candidate.trim().replace("_", "-");
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower === "zh" || lower === "zh-cn" || lower === "zh-sg" || lower.startsWith("zh-hans")) return "zh-Hans";
  if (lower === "zh-tw" || lower === "zh-hk" || lower === "zh-mo" || lower.startsWith("zh-hant")) return "zh-Hant";
  if (lower === "pt-br") return "pt-BR";

  const primary = lower.split("-")[0] ?? "";
  const aliases: Record<string, OAuthPageLocale> = {
    en: "en",
    ko: "ko",
    ja: "ja",
    es: "es",
    fr: "fr",
    de: "de",
    pt: "pt-BR",
    it: "it",
    nl: "nl",
    pl: "pl",
    ru: "ru",
    tr: "tr",
    vi: "vi",
    id: "id",
    th: "th",
    ar: "ar",
    hi: "hi",
    uk: "uk",
  };
  const locale = aliases[primary];
  return locale && SUPPORTED_OAUTH_LOCALES.has(locale) ? locale : undefined;
}

function localeFromRequest(res: Response): OAuthPageLocale {
  const queryLocale = res.req.query?.ui_locales;
  const candidates: string[] = [];
  if (Array.isArray(queryLocale)) {
    for (const value of queryLocale) candidates.push(...String(value).split(/\s+/));
  } else if (queryLocale !== undefined) {
    candidates.push(...String(queryLocale).split(/\s+/));
  }

  const acceptLanguage = String(res.req.header("accept-language") ?? "");
  for (const item of acceptLanguage.split(",")) {
    const [language] = item.trim().split(";");
    if (language) candidates.push(language);
  }

  for (const candidate of candidates) {
    const locale = normalizeOAuthLocale(candidate);
    if (locale) return locale;
  }
  return "en";
}

function copyForLocale(locale: OAuthPageLocale): OAuthPageCopy {
  return OAUTH_PAGE_TEXT[locale] ?? OAUTH_PAGE_TEXT.en!;
}

function pageDirection(locale: OAuthPageLocale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

function localApprovalPageCopy(locale: OAuthPageLocale): { waiting: string; fallback: string } {
  if (locale === "ko") {
    return {
      waiting: "ChatGPT To Codex Mac 앱에서 이 연결을 승인해 주세요. 승인하면 자동으로 계속됩니다.",
      fallback: "앱 승인을 사용할 수 없을 때만 아래 Owner Token 입력을 사용하세요.",
    };
  }
  return {
    waiting: "Approve this connection in the ChatGPT To Codex Mac app. This page will continue automatically.",
    fallback: "Use the Owner Token field below only when local app approval is unavailable.",
  };
}

const OAUTH_PAGE_TEXT: Record<OAuthPageLocale, OAuthPageCopy> = {
  en: {
    title: "Connect ChatGPT To Codex",
    badge: "Local approval",
    intro: "Paste the owner token from the desktop app to approve this connection.",
    client: "Client",
    scope: "Scope",
    resource: "Connector URL",
    label: "Owner token",
    placeholder: "Paste owner token",
    hint: "The token is checked locally by hash. This page does not store it.",
    button: "Authorize ChatGPT To Codex",
    expiredError: "This form has expired. Please try again.",
    lockedError: "Too many attempts. Please wait before trying again.",
    rejectedError: "The owner token was not accepted.",
  },
  ko: {
    title: "ChatGPT To Codex 연결",
    badge: "로컬 승인",
    intro: "데스크톱 앱의 소유자 토큰을 붙여넣어 이 연결을 승인하세요.",
    client: "클라이언트",
    scope: "권한",
    resource: "커넥터 URL",
    label: "소유자 토큰",
    placeholder: "소유자 토큰 붙여넣기",
    hint: "토큰은 로컬에서 해시로만 검증되며 이 페이지에 저장되지 않습니다.",
    button: "ChatGPT To Codex 승인",
    expiredError: "이 승인 양식이 만료되었습니다. 다시 시도하세요.",
    lockedError: "시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.",
    rejectedError: "소유자 토큰이 올바르지 않습니다.",
  },
  ja: {
    title: "ChatGPT To Codex に接続",
    badge: "ローカル承認",
    intro: "デスクトップアプリのオーナートークンを貼り付けて、この接続を承認します。",
    client: "クライアント",
    scope: "権限",
    resource: "コネクタ URL",
    label: "オーナートークン",
    placeholder: "オーナートークンを貼り付け",
    hint: "トークンはローカルでハッシュ検証され、このページには保存されません。",
    button: "ChatGPT To Codex を承認",
    expiredError: "このフォームは期限切れです。もう一度お試しください。",
    lockedError: "試行回数が多すぎます。しばらく待ってから再試行してください。",
    rejectedError: "オーナートークンを承認できませんでした。",
  },
  "zh-Hans": {
    title: "连接 ChatGPT To Codex",
    badge: "本地授权",
    intro: "粘贴桌面应用中的所有者令牌，以批准此连接。",
    client: "客户端",
    scope: "权限",
    resource: "连接器 URL",
    label: "所有者令牌",
    placeholder: "粘贴所有者令牌",
    hint: "令牌只会在本地通过哈希验证，本页面不会保存它。",
    button: "授权 ChatGPT To Codex",
    expiredError: "此表单已过期。请重试。",
    lockedError: "尝试次数过多。请稍后再试。",
    rejectedError: "所有者令牌未被接受。",
  },
  "zh-Hant": {
    title: "連接 ChatGPT To Codex",
    badge: "本機授權",
    intro: "貼上桌面應用程式中的擁有者權杖，以核准此連線。",
    client: "用戶端",
    scope: "權限",
    resource: "連接器 URL",
    label: "擁有者權杖",
    placeholder: "貼上擁有者權杖",
    hint: "權杖只會在本機以雜湊驗證，本頁面不會儲存。",
    button: "授權 ChatGPT To Codex",
    expiredError: "此表單已過期。請再試一次。",
    lockedError: "嘗試次數過多。請稍後再試。",
    rejectedError: "擁有者權杖未被接受。",
  },
  es: {
    title: "Conectar ChatGPT To Codex",
    badge: "Aprobación local",
    intro: "Pega el token de propietario de la app de escritorio para aprobar esta conexión.",
    client: "Cliente",
    scope: "Permiso",
    resource: "URL del conector",
    label: "Token de propietario",
    placeholder: "Pega el token de propietario",
    hint: "El token se verifica localmente por hash. Esta página no lo almacena.",
    button: "Autorizar ChatGPT To Codex",
    expiredError: "Este formulario caducó. Inténtalo de nuevo.",
    lockedError: "Demasiados intentos. Espera antes de volver a intentarlo.",
    rejectedError: "No se aceptó el token de propietario.",
  },
  fr: {
    title: "Connecter ChatGPT To Codex",
    badge: "Approbation locale",
    intro: "Collez le jeton propriétaire de l'application de bureau pour approuver cette connexion.",
    client: "Client",
    scope: "Autorisation",
    resource: "URL du connecteur",
    label: "Jeton propriétaire",
    placeholder: "Coller le jeton propriétaire",
    hint: "Le jeton est vérifié localement par hachage. Cette page ne le stocke pas.",
    button: "Autoriser ChatGPT To Codex",
    expiredError: "Ce formulaire a expiré. Veuillez réessayer.",
    lockedError: "Trop de tentatives. Veuillez patienter avant de réessayer.",
    rejectedError: "Le jeton propriétaire n'a pas été accepté.",
  },
  de: {
    title: "ChatGPT To Codex verbinden",
    badge: "Lokale Freigabe",
    intro: "Fügen Sie das Owner-Token aus der Desktop-App ein, um diese Verbindung zu genehmigen.",
    client: "Client",
    scope: "Berechtigung",
    resource: "Connector-URL",
    label: "Owner-Token",
    placeholder: "Owner-Token einfügen",
    hint: "Das Token wird lokal per Hash geprüft. Diese Seite speichert es nicht.",
    button: "ChatGPT To Codex autorisieren",
    expiredError: "Dieses Formular ist abgelaufen. Bitte versuchen Sie es erneut.",
    lockedError: "Zu viele Versuche. Bitte warten Sie vor dem nächsten Versuch.",
    rejectedError: "Das Owner-Token wurde nicht akzeptiert.",
  },
  "pt-BR": {
    title: "Conectar ChatGPT To Codex",
    badge: "Aprovação local",
    intro: "Cole o token do proprietário do app de desktop para aprovar esta conexão.",
    client: "Cliente",
    scope: "Permissão",
    resource: "URL do conector",
    label: "Token do proprietário",
    placeholder: "Cole o token do proprietário",
    hint: "O token é verificado localmente por hash. Esta página não o armazena.",
    button: "Autorizar ChatGPT To Codex",
    expiredError: "Este formulário expirou. Tente novamente.",
    lockedError: "Muitas tentativas. Aguarde antes de tentar novamente.",
    rejectedError: "O token do proprietário não foi aceito.",
  },
  it: {
    title: "Connetti ChatGPT To Codex",
    badge: "Approvazione locale",
    intro: "Incolla il token proprietario dell'app desktop per approvare questa connessione.",
    client: "Client",
    scope: "Permesso",
    resource: "URL connettore",
    label: "Token proprietario",
    placeholder: "Incolla token proprietario",
    hint: "Il token viene verificato localmente tramite hash. Questa pagina non lo memorizza.",
    button: "Autorizza ChatGPT To Codex",
    expiredError: "Questo modulo è scaduto. Riprova.",
    lockedError: "Troppi tentativi. Attendi prima di riprovare.",
    rejectedError: "Il token proprietario non è stato accettato.",
  },
  nl: {
    title: "ChatGPT To Codex verbinden",
    badge: "Lokale goedkeuring",
    intro: "Plak de eigenaarstoken uit de desktop-app om deze verbinding goed te keuren.",
    client: "Client",
    scope: "Machtiging",
    resource: "Connector-URL",
    label: "Eigenaarstoken",
    placeholder: "Eigenaarstoken plakken",
    hint: "De token wordt lokaal via hash gecontroleerd. Deze pagina slaat hem niet op.",
    button: "ChatGPT To Codex autoriseren",
    expiredError: "Dit formulier is verlopen. Probeer het opnieuw.",
    lockedError: "Te veel pogingen. Wacht even voordat je het opnieuw probeert.",
    rejectedError: "De eigenaarstoken is niet geaccepteerd.",
  },
  pl: {
    title: "Połącz ChatGPT To Codex",
    badge: "Lokalne zatwierdzenie",
    intro: "Wklej token właściciela z aplikacji desktopowej, aby zatwierdzić to połączenie.",
    client: "Klient",
    scope: "Uprawnienie",
    resource: "URL konektora",
    label: "Token właściciela",
    placeholder: "Wklej token właściciela",
    hint: "Token jest lokalnie sprawdzany przez hash. Ta strona go nie zapisuje.",
    button: "Autoryzuj ChatGPT To Codex",
    expiredError: "Ten formularz wygasł. Spróbuj ponownie.",
    lockedError: "Zbyt wiele prób. Poczekaj przed kolejną próbą.",
    rejectedError: "Token właściciela nie został zaakceptowany.",
  },
  ru: {
    title: "Подключить ChatGPT To Codex",
    badge: "Локальное подтверждение",
    intro: "Вставьте токен владельца из настольного приложения, чтобы подтвердить это подключение.",
    client: "Клиент",
    scope: "Разрешение",
    resource: "URL коннектора",
    label: "Токен владельца",
    placeholder: "Вставьте токен владельца",
    hint: "Токен проверяется локально по хэшу. Эта страница не сохраняет его.",
    button: "Авторизовать ChatGPT To Codex",
    expiredError: "Срок действия формы истек. Попробуйте снова.",
    lockedError: "Слишком много попыток. Подождите перед повторной попыткой.",
    rejectedError: "Токен владельца не принят.",
  },
  tr: {
    title: "ChatGPT To Codex bağlantısı",
    badge: "Yerel onay",
    intro: "Bu bağlantıyı onaylamak için masaüstü uygulamasındaki sahip tokenını yapıştırın.",
    client: "İstemci",
    scope: "Yetki",
    resource: "Bağlayıcı URL'si",
    label: "Sahip tokenı",
    placeholder: "Sahip tokenını yapıştırın",
    hint: "Token yerelde hash ile doğrulanır. Bu sayfa tokenı saklamaz.",
    button: "ChatGPT To Codex'i yetkilendir",
    expiredError: "Bu formun süresi doldu. Lütfen tekrar deneyin.",
    lockedError: "Çok fazla deneme yapıldı. Tekrar denemeden önce bekleyin.",
    rejectedError: "Sahip tokenı kabul edilmedi.",
  },
  vi: {
    title: "Kết nối ChatGPT To Codex",
    badge: "Phê duyệt cục bộ",
    intro: "Dán token chủ sở hữu từ ứng dụng desktop để phê duyệt kết nối này.",
    client: "Máy khách",
    scope: "Quyền",
    resource: "URL kết nối",
    label: "Token chủ sở hữu",
    placeholder: "Dán token chủ sở hữu",
    hint: "Token được kiểm tra cục bộ bằng hash. Trang này không lưu token.",
    button: "Ủy quyền ChatGPT To Codex",
    expiredError: "Biểu mẫu này đã hết hạn. Vui lòng thử lại.",
    lockedError: "Quá nhiều lần thử. Vui lòng chờ trước khi thử lại.",
    rejectedError: "Token chủ sở hữu không được chấp nhận.",
  },
  id: {
    title: "Hubungkan ChatGPT To Codex",
    badge: "Persetujuan lokal",
    intro: "Tempel token pemilik dari aplikasi desktop untuk menyetujui koneksi ini.",
    client: "Klien",
    scope: "Izin",
    resource: "URL konektor",
    label: "Token pemilik",
    placeholder: "Tempel token pemilik",
    hint: "Token diperiksa secara lokal dengan hash. Halaman ini tidak menyimpannya.",
    button: "Otorisasi ChatGPT To Codex",
    expiredError: "Formulir ini telah kedaluwarsa. Coba lagi.",
    lockedError: "Terlalu banyak percobaan. Tunggu sebelum mencoba lagi.",
    rejectedError: "Token pemilik tidak diterima.",
  },
  th: {
    title: "เชื่อมต่อ ChatGPT To Codex",
    badge: "อนุมัติในเครื่อง",
    intro: "วางโทเค็นเจ้าของจากแอปเดสก์ท็อปเพื่ออนุมัติการเชื่อมต่อนี้",
    client: "ไคลเอนต์",
    scope: "สิทธิ์",
    resource: "URL ตัวเชื่อมต่อ",
    label: "โทเค็นเจ้าของ",
    placeholder: "วางโทเค็นเจ้าของ",
    hint: "โทเค็นจะตรวจสอบในเครื่องด้วยแฮช หน้านี้จะไม่บันทึกโทเค็น",
    button: "อนุมัติ ChatGPT To Codex",
    expiredError: "แบบฟอร์มนี้หมดอายุแล้ว โปรดลองอีกครั้ง",
    lockedError: "พยายามหลายครั้งเกินไป โปรดรอก่อนลองใหม่",
    rejectedError: "ไม่ยอมรับโทเค็นเจ้าของ",
  },
  ar: {
    title: "ربط ChatGPT To Codex",
    badge: "موافقة محلية",
    intro: "الصق رمز المالك من تطبيق سطح المكتب للموافقة على هذا الاتصال.",
    client: "العميل",
    scope: "الصلاحية",
    resource: "رابط الموصل",
    label: "رمز المالك",
    placeholder: "الصق رمز المالك",
    hint: "يتم التحقق من الرمز محليًا عبر التجزئة. لا تحفظ هذه الصفحة الرمز.",
    button: "تخويل ChatGPT To Codex",
    expiredError: "انتهت صلاحية هذا النموذج. حاول مرة أخرى.",
    lockedError: "محاولات كثيرة جدًا. انتظر قبل المحاولة مرة أخرى.",
    rejectedError: "لم يتم قبول رمز المالك.",
  },
  hi: {
    title: "ChatGPT To Codex कनेक्ट करें",
    badge: "स्थानीय अनुमति",
    intro: "इस कनेक्शन को स्वीकृत करने के लिए डेस्कटॉप ऐप का owner token चिपकाएं।",
    client: "क्लाइंट",
    scope: "अनुमति",
    resource: "कनेक्टर URL",
    label: "Owner token",
    placeholder: "Owner token चिपकाएं",
    hint: "Token को स्थानीय रूप से hash से जांचा जाता है। यह पेज इसे सहेजता नहीं है।",
    button: "ChatGPT To Codex को अनुमति दें",
    expiredError: "यह फ़ॉर्म समाप्त हो गया है। कृपया फिर से प्रयास करें।",
    lockedError: "बहुत अधिक प्रयास हुए। फिर से प्रयास करने से पहले प्रतीक्षा करें।",
    rejectedError: "Owner token स्वीकार नहीं किया गया।",
  },
  uk: {
    title: "Підключити ChatGPT To Codex",
    badge: "Локальне підтвердження",
    intro: "Вставте токен власника з настільної програми, щоб підтвердити це підключення.",
    client: "Клієнт",
    scope: "Дозвіл",
    resource: "URL конектора",
    label: "Токен власника",
    placeholder: "Вставте токен власника",
    hint: "Токен перевіряється локально за хешем. Ця сторінка його не зберігає.",
    button: "Авторизувати ChatGPT To Codex",
    expiredError: "Термін дії цієї форми минув. Спробуйте ще раз.",
    lockedError: "Забагато спроб. Зачекайте перед наступною спробою.",
    rejectedError: "Токен власника не прийнято.",
  },
};

function formHtml(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  csrfToken: string;
  fields: Record<string, string | undefined>;
  locale: OAuthPageLocale;
  localApproval?: OAuthLocalApprovalPageSession;
}): string {
  const copy = copyForLocale(params.locale);
  const localCopy = localApprovalPageCopy(params.locale);
  const dir = pageDirection(params.locale);
  const scopeText = params.scopes.length > 0 ? params.scopes.join(" ") : "chatgpt2codex";
  const resourceText = params.resource?.href ?? "chatgpt2codex MCP endpoint";
  const error = params.error ? `<p class="error" role="alert">${htmlEscape(params.error)}</p>` : "";
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `        <input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join("\n");
  const localApproval = params.localApproval
    ? `<section id="oauth_local_approval" class="local-approval" data-request-id="${htmlEscape(params.localApproval.requestId)}" data-browser-token="${htmlEscape(params.localApproval.browserToken)}">
          <p id="oauth_local_approval_status" class="local-approval-status" role="status">${htmlEscape(localCopy.waiting)}</p>
          <p class="hint">${htmlEscape(localCopy.fallback)}</p>
        </section>`
    : "";

  return `<!doctype html>
<html lang="${htmlEscape(params.locale)}" dir="${dir}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlEscape(copy.title)}</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 28px 16px;
        background: #eef3f8;
        color: #172033;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(600px, 100%);
      }
      .panel {
        padding: clamp(22px, 4vw, 32px);
        border: 1px solid #d7dee9;
        border-radius: 8px;
        background: #ffffff;
        box-shadow: 0 18px 50px rgba(26, 39, 68, .16);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 18px;
        color: #0f7f67;
        font-size: 13px;
        font-weight: 700;
      }
      .badge::before {
        content: "";
        width: 10px;
        height: 10px;
        border-radius: 99px;
        background: #10a37f;
        box-shadow: 0 0 0 4px rgba(16, 163, 127, .13);
      }
      h1 { margin: 0; font-size: clamp(28px, 6vw, 38px); line-height: 1.12; letter-spacing: 0; }
      .intro { margin: 12px 0 24px; color: #475569; font-size: 16px; line-height: 1.55; }
      dl {
        display: grid;
        grid-template-columns: 132px 1fr;
        gap: 0 18px;
        margin: 0 0 22px;
        border-top: 1px solid #e2e8f0;
        border-bottom: 1px solid #e2e8f0;
      }
      dt, dd { padding: 12px 0; border-top: 1px solid #eef2f7; }
      dt:first-of-type, dt:first-of-type + dd { border-top: 0; }
      dt { color: #64748b; font-size: 13px; font-weight: 700; }
      dd { margin: 0; color: #172033; word-break: break-word; font-size: 14px; line-height: 1.45; }
      label { display: block; margin: 0 0 8px; color: #111827; font-size: 15px; font-weight: 800; }
      input {
        width: 100%;
        min-height: 54px;
        padding: 12px 14px;
        border-radius: 8px;
        border: 1px solid #9aa8ba;
        outline: none;
        background: #ffffff;
        color: #0f172a;
        font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 18px;
        letter-spacing: 0;
      }
      .token-field { position: relative; }
      .token-field input { padding-right: 54px; }
      .token-toggle {
        position: absolute;
        top: 50%;
        right: 8px;
        width: 38px;
        height: 38px;
        transform: translateY(-50%);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 8px;
        padding: 0;
        color: #475569;
        background: transparent;
        cursor: pointer;
      }
      .token-toggle:hover { background: #e2e8f0; color: #0f172a; }
      .token-toggle:focus {
        outline: none;
        box-shadow: 0 0 0 4px rgba(16, 163, 127, .16);
      }
      .token-toggle svg { width: 21px; height: 21px; stroke-width: 2.2; }
      .token-toggle .eye-off { display: none; }
      .token-toggle[aria-pressed="true"] .eye { display: none; }
      .token-toggle[aria-pressed="true"] .eye-off { display: block; }
      input:focus {
        border-color: #10a37f;
        box-shadow: 0 0 0 4px rgba(16, 163, 127, .16);
      }
      .hint { margin: 9px 0 0; color: #47625b; font-size: 13px; line-height: 1.45; }
      .local-approval {
        margin: 0 0 20px;
        padding: 14px 16px;
        border: 1px solid #99d8c8;
        border-radius: 8px;
        background: #ecfdf5;
      }
      .local-approval-status { margin: 0; color: #065f46; font-weight: 800; line-height: 1.45; }
      button[type="submit"] {
        width: 100%;
        min-height: 52px;
        margin-top: 18px;
        border: 0;
        border-radius: 8px;
        padding: 13px 18px;
        color: #ffffff;
        background: #10a37f;
        font-size: 16px;
        font-weight: 800;
        cursor: pointer;
      }
      button[type="submit"]:hover { background: #0d8f70; }
      .error {
        margin: 0 0 18px;
        padding: 12px 14px;
        border-radius: 8px;
        color: #991b1b;
        background: #fef2f2;
        border: 1px solid #fecaca;
        font-weight: 700;
      }
      [dir="rtl"] dl { grid-template-columns: 1fr 132px; }
      [dir="rtl"] dt { grid-column: 2; }
      [dir="rtl"] dd { grid-column: 1; }
      [dir="rtl"] .token-field input { padding-left: 54px; padding-right: 14px; }
      [dir="rtl"] .token-toggle { left: 8px; right: auto; }
      @media (max-width: 560px) {
        body { align-items: flex-start; padding: 12px; }
        .panel { padding: 20px; }
        dl { grid-template-columns: 1fr; }
        [dir="rtl"] dl { grid-template-columns: 1fr; }
        [dir="rtl"] dt, [dir="rtl"] dd { grid-column: auto; }
      }
      @media (prefers-color-scheme: dark) {
        body { background: #0f172a; color: #f8fafc; }
        .panel { background: #111827; border-color: #334155; box-shadow: 0 18px 50px rgba(0, 0, 0, .4); }
        .badge { color: #7dd3fc; }
        h1, label, dd { color: #f8fafc; }
        .intro, dt { color: #cbd5e1; }
        dl, dt, dd { border-color: #263244; }
        input { background: #020617; color: #f8fafc; border-color: #526176; }
        .token-toggle { color: #cbd5e1; }
        .token-toggle:hover { background: #1f2937; color: #f8fafc; }
        .hint { color: #a7f3d0; }
        .local-approval { background: #052e2b; border-color: #0f766e; }
        .local-approval-status { color: #a7f3d0; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <p class="badge">${htmlEscape(copy.badge)}</p>
        <h1>${htmlEscape(copy.title)}</h1>
        <p class="intro">${htmlEscape(copy.intro)}</p>
        ${error}
        <dl>
          <dt>${htmlEscape(copy.client)}</dt><dd>${htmlEscape(params.clientName)}</dd>
          <dt>${htmlEscape(copy.scope)}</dt><dd>${htmlEscape(scopeText)}</dd>
          <dt>${htmlEscape(copy.resource)}</dt><dd>${htmlEscape(resourceText)}</dd>
        </dl>
        ${localApproval}
        <form method="post" action="/authorize">
${hiddenFields}
          <input type="hidden" name="csrf_token" value="${htmlEscape(params.csrfToken)}" />
          ${params.localApproval ? `<input type="hidden" name="local_approval_id" value="${htmlEscape(params.localApproval.requestId)}" />` : ""}
          <label for="owner_token">${htmlEscape(copy.label)}</label>
          <div class="token-field">
            <input id="owner_token" name="owner_token" type="password" autocomplete="one-time-code" inputmode="text" spellcheck="false" autocapitalize="off" placeholder="${htmlEscape(copy.placeholder)}" autofocus required />
            <button id="owner_token_toggle" class="token-toggle" type="button" aria-label="Show owner token" aria-controls="owner_token" aria-pressed="false" data-label-show="Show owner token" data-label-hide="Hide owner token">
              <svg class="eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M2.1 12s3.2-6.5 9.9-6.5S21.9 12 21.9 12 18.7 18.5 12 18.5 2.1 12 2.1 12Z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="m3 3 18 18"/><path d="M10.6 10.6A3 3 0 0 0 12 15a3 3 0 0 0 2.4-4.8"/><path d="M9.9 5.8A10.6 10.6 0 0 1 12 5.5c6.7 0 9.9 6.5 9.9 6.5a17.7 17.7 0 0 1-3.2 4.2"/><path d="M6.5 6.9A17.7 17.7 0 0 0 2.1 12s3.2 6.5 9.9 6.5c1.3 0 2.5-.2 3.5-.6"/></svg>
            </button>
          </div>
          <p id="owner_token_hint" class="hint">${htmlEscape(copy.hint)}</p>
          <button type="submit">${htmlEscape(copy.button)}</button>
        </form>
      </section>
    </main>
    <script src="/assets/owner-token-toggle.js" defer></script>
    ${params.localApproval ? `<script src="/assets/oauth-local-approval.js" defer></script>` : ""}
  </body>
</html>`;
}

function requestedScopesAllowed(requested: string[], supported: string[]): boolean {
  return requested.every((scope) => supported.includes(scope));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** SR-05: exponential-backoff lockout tracker for `/authorize` POSTs. The
 * per-client identity map is bounded, and a separate small global failure
 * window prevents attackers from bypassing lockout by rotating forwarded IPs
 * or dynamically registering clients behind the same proxy. */
class LoginAttemptTracker {
  private readonly attempts = new Map<string, { count: number; lockedUntilMs: number }>();
  private readonly globalFailures: number[] = [];

  private sweepGlobal(now: number): void {
    const cutoff = now - GLOBAL_FAILURE_WINDOW_MS;
    while (this.globalFailures.length > 0 && this.globalFailures[0]! <= cutoff) {
      this.globalFailures.shift();
    }
  }

  isGloballyLimited(now = Date.now()): boolean {
    this.sweepGlobal(now);
    return this.globalFailures.length >= MAX_GLOBAL_FAILURES_PER_WINDOW;
  }

  private evictIfFull(): void {
    if (this.attempts.size < MAX_TRACKED_IPS) return;
    const oldestKey = this.attempts.keys().next().value;
    if (oldestKey !== undefined) this.attempts.delete(oldestKey);
  }

  isLockedOut(key: string): boolean {
    const record = this.attempts.get(key);
    if (!record) return false;
    // lockedUntilMs === 0 means "under the backoff threshold, not yet
    // locked" (see recordFailure) — that is NOT the same as "was locked and
    // the lockout has since expired". Treating the two the same here used
    // to delete (reset to zero) the in-progress failure count on every
    // subsequent request's own pre-check, before that request's own
    // recordFailure call ever got a chance to increment on top of it — so
    // `count` could never actually climb past 1 across separate requests
    // and the exponential-backoff lockout could never engage at all. Only
    // clear the record once an *actual* lockout period has elapsed.
    if (record.lockedUntilMs === 0) return false;
    if (record.lockedUntilMs <= Date.now()) {
      this.attempts.delete(key);
      return false;
    }
    return true;
  }

  recordFailure(key: string, now = Date.now()): void {
    this.sweepGlobal(now);
    this.globalFailures.push(now);
    const existing = this.attempts.get(key);
    const count = (existing?.count ?? 0) + 1;
    let lockedUntilMs = 0;
    if (count >= MAX_ATTEMPTS_BEFORE_BACKOFF) {
      const overBy = count - MAX_ATTEMPTS_BEFORE_BACKOFF;
      const backoffMs = Math.min(LOCKOUT_WINDOW_MS, 1000 * 2 ** overBy);
      lockedUntilMs = now + backoffMs;
    }
    if (!existing) this.evictIfFull();
    this.attempts.set(key, { count, lockedUntilMs });
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly csrfTokens = new Map<string, number>(); // token -> expiresAtMs
  private readonly loginAttempts = new LoginAttemptTracker();
  private readonly oauthStore: JsonOAuthStore;
  private readonly resourceServerUrl: URL;
  private readonly localApprovals = new Map<string, PendingOAuthLocalApprovalRecord>();

  constructor(
    private readonly config: OAuthConfig,
    resourceServerUrl: URL,
    stateDir: string,
  ) {
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.oauthStore = new JsonOAuthStore(stateDir);
    this.clientsStore = new JsonOAuthClientsStore(this.oauthStore, config.allowedRedirectHosts);
  }

  requestLocalApproval(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    now = Date.now(),
  ): OAuthLocalApprovalPageSession | undefined {
    this.sweepLocalApprovals(now);
    const requestKey = hashToken([
      client.client_id,
      params.redirectUri,
      params.codeChallenge,
      params.state ?? "",
      params.resource?.href ?? "",
      ...(params.scopes ?? []),
    ].join("\u0000"));
    const existing = [...this.localApprovals.values()].find((record) =>
      record.requestKey === requestKey && record.status === "pending" && record.expiresAt > now,
    );
    if (existing) return { requestId: existing.requestId, browserToken: existing.browserToken };

    if ([...this.localApprovals.values()].filter((record) => record.status === "pending").length
      >= MAX_PENDING_LOCAL_APPROVALS) {
      return undefined;
    }

    const requestId = `oauth_${randomUUID()}`;
    const browserToken = randomToken();
    const redirectHost = (() => {
      try { return new URL(params.redirectUri).hostname; } catch { return "unknown"; }
    })();
    const record: PendingOAuthLocalApprovalRecord = {
      requestId,
      status: "pending",
      clientName: (client.client_name ?? "ChatGPT").slice(0, 160),
      scopes: [...(params.scopes ?? this.config.scopes)],
      resource: params.resource?.href ?? this.resourceServerUrl.href,
      redirectHost,
      createdAt: now,
      expiresAt: now + LOCAL_APPROVAL_TTL_MS,
      browserToken,
      browserTokenHash: hashToken(browserToken),
      requestKey,
      client,
      params,
    };
    this.localApprovals.set(requestId, record);
    return { requestId, browserToken };
  }

  listPendingLocalApprovals(now = Date.now()): PendingOAuthLocalApprovalSummary[] {
    this.sweepLocalApprovals(now);
    return [...this.localApprovals.values()]
      .filter((record) => record.status === "pending" && record.expiresAt > now)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => this.localApprovalSummary(record));
  }

  resolveLocalApproval(
    requestId: string,
    decision: "approve" | "reject",
    now = Date.now(),
  ): PendingOAuthLocalApprovalSummary {
    this.sweepLocalApprovals(now);
    const record = this.localApprovals.get(requestId);
    if (!record) throw new InvalidRequestError("OAuth local approval request was not found");
    if (record.status !== "pending" || record.expiresAt <= now) {
      throw new InvalidRequestError("OAuth local approval request is no longer pending");
    }
    if (decision === "approve") {
      record.redirectUrl = this.issueAuthorizationRedirect(record.client, record.params);
      record.status = "approved";
    } else {
      record.status = "rejected";
    }
    return this.localApprovalSummary(record);
  }

  localApprovalBrowserStatus(
    requestId: string,
    browserToken: string,
    now = Date.now(),
  ): OAuthLocalApprovalBrowserStatus | undefined {
    this.sweepLocalApprovals(now);
    const record = this.localApprovals.get(requestId);
    if (!record || !this.localApprovalBrowserTokenMatches(record, browserToken)) return undefined;
    return {
      status: record.status,
      ...(record.status === "approved" && record.redirectUrl ? { redirectUrl: record.redirectUrl } : {}),
    };
  }

  private localApprovalBrowserTokenMatches(
    record: PendingOAuthLocalApprovalRecord,
    candidate: string,
  ): boolean {
    const supplied = Buffer.from(hashToken(candidate), "utf8");
    const expected = Buffer.from(record.browserTokenHash, "utf8");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private localApprovalSummary(record: PendingOAuthLocalApprovalRecord): PendingOAuthLocalApprovalSummary {
    return {
      requestId: record.requestId,
      status: record.status,
      clientName: record.clientName,
      scopes: [...record.scopes],
      resource: record.resource,
      redirectHost: record.redirectHost,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }

  private sweepLocalApprovals(now: number): void {
    for (const [requestId, record] of this.localApprovals) {
      if (record.status === "pending" && record.expiresAt <= now) record.status = "expired";
      if (record.expiresAt + LOCAL_APPROVAL_TTL_MS <= now) this.localApprovals.delete(requestId);
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (
      !params.resource ||
      !checkResourceAllowed({ requestedResource: params.resource, configuredResource: this.resourceServerUrl })
    ) {
      throw new InvalidRequestError("Invalid or missing OAuth resource");
    }
    if (!requestedScopesAllowed(params.scopes ?? [], this.config.scopes)) {
      throw new InvalidRequestError("Requested scope is not supported");
    }

    const clientIp = res.req.ip ?? res.req.socket.remoteAddress ?? "unknown";
    // Express resolves forwarded client addresses only when the immediate
    // peer is a trusted loopback proxy. Include the registered client id so
    // one noisy connector cannot lock out every client, while the global
    // limiter below still bounds forwarded-IP rotation.
    const lockoutKey = `${client.client_id}:${clientIp}`;
    const locale = localeFromRequest(res);
    const localApproval = this.requestLocalApproval(client, params);

    if (res.req.method !== "POST") {
      const csrfToken = this.issueCsrfToken();
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          csrfToken,
          fields: authorizationFormFields(client, params),
          locale,
          localApproval,
        }),
      );
      return;
    }

    // SR-05: CSRF nonce + rate-limited lockout around the owner token gate.
    // A valid owner token is allowed to recover a stale form after app restarts,
    // because the token is the actual local-owner approval gate.
    const csrfToken = String(res.req.body?.csrf_token ?? "");
    const csrfAccepted = this.consumeCsrfToken(csrfToken);
    const providedToken = String(res.req.body?.owner_token ?? "");
    if (!csrfAccepted && !providedToken) {
      res.status(403).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: copyForLocale(locale).expiredError,
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          csrfToken: this.issueCsrfToken(),
          fields: authorizationFormFields(client, params),
          locale,
          localApproval,
        }),
      );
      return;
    }

    if (this.loginAttempts.isGloballyLimited()) {
      await this.recordOwnerTokenAttempt("locked_out", clientIp, client);
      res.status(429).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: copyForLocale(locale).lockedError,
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          csrfToken: this.issueCsrfToken(),
          fields: authorizationFormFields(client, params),
          locale,
          localApproval,
        }),
      );
      return;
    }

    if (this.loginAttempts.isLockedOut(lockoutKey)) {
      await this.recordOwnerTokenAttempt("locked_out", clientIp, client);
      res.status(429).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: copyForLocale(locale).lockedError,
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          csrfToken: this.issueCsrfToken(),
          fields: authorizationFormFields(client, params),
          locale,
          localApproval,
        }),
      );
      return;
    }

    const ownerTokenAccepted = providedToken.length > 0 && (await this.config.verifyOwnerToken(providedToken));
    if (!csrfAccepted && !ownerTokenAccepted) {
      // At this point guard 1 above already excluded the "no token submitted"
      // case, so reaching here means a real (wrong) owner_token was submitted
      // alongside a missing/stale csrf_token. That is a genuine failed login
      // attempt and must be counted toward SR-05 lockout and audited, or an
      // attacker can bypass both by simply omitting csrf_token.
      this.loginAttempts.recordFailure(lockoutKey);
      await this.recordOwnerTokenAttempt("failure", clientIp, client);
      res.status(403).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: copyForLocale(locale).expiredError,
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          csrfToken: this.issueCsrfToken(),
          fields: authorizationFormFields(client, params),
          locale,
          localApproval,
        }),
      );
      return;
    }

    if (!ownerTokenAccepted) {
      this.loginAttempts.recordFailure(lockoutKey);
      await this.recordOwnerTokenAttempt("failure", clientIp, client);
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: copyForLocale(locale).rejectedError,
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          csrfToken: this.issueCsrfToken(),
          fields: authorizationFormFields(client, params),
          locale,
          localApproval,
        }),
      );
      return;
    }

    this.loginAttempts.recordSuccess(lockoutKey);
    this.cancelLocalApproval(String(res.req.body?.local_approval_id ?? ""));
    res.redirect(302, this.issueAuthorizationRedirect(client, params));
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.validCodeRecord(client, authorizationCode);
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.validCodeRecord(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, record.params.scopes ?? this.config.scopes, record.params.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const refreshTokenHash = hashToken(refreshToken);
    const record = await this.oauthStore.getRefreshToken(refreshTokenHash);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
      throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    }

    return this.issueTokens(
      client.client_id,
      requestedScopes,
      resource ?? (record.resource ? new URL(record.resource) : undefined),
      refreshTokenHash,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.oauthStore.getAccessToken(hashToken(token));
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hashed = hashToken(request.token);
    await this.oauthStore.deleteAccessToken(hashed);
    await this.oauthStore.deleteRefreshToken(hashed);
  }

  close(): void {
    this.localApprovals.clear();
    this.oauthStore.close();
  }

  private issueCsrfToken(): string {
    const token = randomBytes(24).toString("base64url");
    this.csrfTokens.set(token, Date.now() + CODE_TTL_MS);
    // SR-09 bounded map: sweep + hard cap.
    if (this.csrfTokens.size > MAX_TRACKED_IPS) {
      const oldestKey = this.csrfTokens.keys().next().value;
      if (oldestKey !== undefined) this.csrfTokens.delete(oldestKey);
    }
    return token;
  }

  private consumeCsrfToken(token: string): boolean {
    if (!token) return false;
    const expiresAtMs = this.csrfTokens.get(token);
    this.csrfTokens.delete(token);
    if (!expiresAtMs) return false;
    return expiresAtMs >= Date.now();
  }

  private sweepExpiredCodes(): void {
    const now = Date.now();
    for (const [code, record] of this.codes) {
      if (record.expiresAtMs < now) this.codes.delete(code);
    }
  }

  private issueAuthorizationRedirect(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
  ): string {
    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      clientId: client.client_id,
      params,
      expiresAtMs: Date.now() + CODE_TTL_MS,
    });
    this.sweepExpiredCodes();

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state);
    return redirectUrl.href;
  }

  private cancelLocalApproval(requestId: string): void {
    if (!requestId) return;
    const record = this.localApprovals.get(requestId);
    if (record?.status === "pending") record.status = "rejected";
  }

  private async recordOwnerTokenAttempt(
    outcome: "failure" | "locked_out",
    clientIp: string,
    client: OAuthClientInformationFull,
  ): Promise<void> {
    try {
      await this.config.onOwnerTokenAttempt?.({
        outcome,
        clientIp,
        clientId: client.client_id,
        clientName: client.client_name,
      });
    } catch {
      // Audit logging must not change the OAuth response.
    }
  }

  private validCodeRecord(client: OAuthClientInformationFull, authorizationCode: string): AuthorizationCodeRecord {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record;
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource?: URL,
    consumedRefreshTokenHash?: string,
  ): Promise<OAuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds;

    const saved = await this.oauthStore.saveTokenPair(
      {
        accessTokenHash: hashToken(accessToken),
        accessToken: {
          clientId,
          scopes,
          expiresAt: accessExpiresAt,
          resource: resource?.href,
        },
        refreshTokenHash: hashToken(refreshToken),
        refreshToken: {
          clientId,
          scopes,
          expiresAt: refreshExpiresAt,
          resource: resource?.href,
        },
      },
      consumedRefreshTokenHash,
    );
    if (!saved) {
      throw new InvalidGrantError("Invalid refresh token");
    }

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

function authorizationFormFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" "),
    state: params.state,
    resource: params.resource?.href,
  };
}
