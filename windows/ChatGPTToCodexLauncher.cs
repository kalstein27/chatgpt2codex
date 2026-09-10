using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class ChatGPTToCodexLauncher
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new LauncherForm(args));
    }
}

internal sealed class LocalControlSnapshot
{
    public LocalControlInfo control { get; set; }
    public LocalOAuthApprovalsInfo oauthApprovals { get; set; }
    public LocalControlSession[] sessions { get; set; }
}

internal sealed class LocalOAuthApprovalsInfo
{
    public int pendingRequestCount { get; set; }
    public LocalPendingOAuthApproval[] pendingRequests { get; set; }
}

internal sealed class LocalPendingOAuthApproval
{
    public string requestId { get; set; }
    public string status { get; set; }
    public string clientName { get; set; }
    public string[] scopes { get; set; }
    public string resource { get; set; }
    public string redirectHost { get; set; }
    public long createdAt { get; set; }
    public long expiresAt { get; set; }
}

internal sealed class LocalControlInfo
{
    public bool enabled { get; set; }
    public bool platformSupported { get; set; }
    public bool armed { get; set; }
    public bool killed { get; set; }
    public int pendingCount { get; set; }
    public LocalPendingControlAction[] pendingActions { get; set; }
    public bool autoEnabled { get; set; }
    public long autoRemainingMs { get; set; }
    public int allowlistedAppCount { get; set; }
}

internal sealed class LocalPendingControlAction
{
    public string actionId { get; set; }
    public string appName { get; set; }
    public string kind { get; set; }
    public string status { get; set; }
}

internal sealed class LocalControlSession
{
    public string sessionLabel { get; set; }
    public string clientName { get; set; }
    public string state { get; set; }
    public LocalControlOperation operation { get; set; }
}

internal sealed class LocalControlOperation
{
    public string tool { get; set; }
    public string state { get; set; }
    public long elapsedMs { get; set; }
}

internal sealed class DesktopSettings
{
    public int schemaVersion { get; set; }
    public string language { get; set; }
    public string projectFolder { get; set; }
    public bool launchAtStartup { get; set; }
    public bool startMcpOnOpen { get; set; }
    public bool autoCheckUpdates { get; set; }
    public bool multiProjectLanesEnabled { get; set; }
    public bool enablePublicTunnel { get; set; }
    public string publicHostname { get; set; }
    public int port { get; set; }
    public string[] controlAllowlist { get; set; }
}

internal static class DashboardWindowBranding
{
    private const uint WmSetIcon = 0x0080;
    private static readonly IntPtr IconSmall = IntPtr.Zero;
    private static readonly IntPtr IconBig = new IntPtr(1);
    private const uint ImageIcon = 1;
    private const uint LrLoadFromFile = 0x0010;
    private const uint LrDefaultSize = 0x0040;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr LoadImage(IntPtr hInst, string name, uint type, int cx, int cy, uint fuLoad);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    public static void ApplyAsync()
    {
        System.Threading.ThreadPool.QueueUserWorkItem(_ =>
        {
            var iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "assets", "chatgpt2codex-icon.ico");
            if (!File.Exists(iconPath)) return;

            var icon = LoadImage(IntPtr.Zero, iconPath, ImageIcon, 0, 0, LrLoadFromFile | LrDefaultSize);
            if (icon == IntPtr.Zero) return;

            for (var attempt = 0; attempt < 50; attempt++)
            {
                var applied = false;
                EnumWindows((hWnd, lParam) =>
                {
                    if (!IsWindowVisible(hWnd)) return true;
                    var length = GetWindowTextLength(hWnd);
                    if (length <= 0 || length > 256) return true;
                    var title = new StringBuilder(length + 1);
                    GetWindowText(hWnd, title, title.Capacity);
                    if (!string.Equals(title.ToString(), "ChatGPT To Codex", StringComparison.Ordinal)) return true;

                    SendMessage(hWnd, WmSetIcon, IconBig, icon);
                    SendMessage(hWnd, WmSetIcon, IconSmall, icon);
                    applied = true;
                    return true;
                }, IntPtr.Zero);

                if (applied) return;
                System.Threading.Thread.Sleep(100);
            }
        });
    }
}

internal sealed class LauncherForm : Form
{
    private const int MaxLauncherLogFiles = 20;
    private const int MaxLauncherLogAgeDays = 14;
    private const long MaxLauncherLogFileBytes = 2L * 1024L * 1024L;
    private const long MaxLauncherLogTotalBytes = 25L * 1024L * 1024L;
    private const int MaxLauncherLogLinesAfterTrim = 2500;
    private const int MaxVisibleLogCharacters = 200000;
    private static readonly string[] LanguageCodes = new[]
    {
        "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt-BR", "it",
        "nl", "pl", "ru", "tr", "vi", "id", "th", "ar", "hi", "uk"
    };
    private static readonly string[] LanguageOptionCodes = new[]
    {
        "auto", "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt-BR", "it",
        "nl", "pl", "ru", "tr", "vi", "id", "th", "ar", "hi", "uk"
    };
    private static readonly string[] LanguageOptionNames = new[]
    {
        "Auto (System)", "English", "한국어", "日本語", "简体中文", "繁體中文",
        "Español", "Français", "Deutsch", "Português (Brasil)", "Italiano",
        "Nederlands", "Polski", "Русский", "Türkçe", "Tiếng Việt", "Bahasa Indonesia",
        "ไทย", "العربية", "हिन्दी", "Українська"
    };
    private static readonly Dictionary<string, string[]> Texts = new Dictionary<string, string[]>
    {
        {"statusChecking", new[] {"checking...", "확인 중...", "確認中...", "正在检查...", "正在檢查...", "comprobando...", "vérification...", "wird geprüft...", "verificando...", "controllo...", "controleren...", "sprawdzanie...", "проверка...", "kontrol ediliyor...", "đang kiểm tra...", "memeriksa...", "กำลังตรวจสอบ...", "جار التحقق...", "जांच हो रही है...", "перевірка..."}},
        {"statusOn", new[] {"on", "켜짐", "オン", "开启", "開啟", "activo", "actif", "ein", "ligado", "attivo", "aan", "włączone", "вкл", "açık", "bật", "aktif", "เปิด", "تشغيل", "चालू", "увімкнено"}},
        {"statusOff", new[] {"off", "꺼짐", "オフ", "关闭", "關閉", "inactivo", "inactif", "aus", "desligado", "spento", "uit", "wyłączone", "выкл", "kapalı", "tắt", "nonaktif", "ปิด", "إيقاف", "बंद", "вимкнено"}},
        {"startMCP", new[] {"Start MCP", "MCP 시작", "MCP を開始", "启动 MCP", "啟動 MCP", "Iniciar MCP", "Démarrer MCP", "MCP starten", "Iniciar MCP", "Avvia MCP", "MCP starten", "Uruchom MCP", "Запустить MCP", "MCP başlat", "Khởi động MCP", "Mulai MCP", "เริ่ม MCP", "بدء MCP", "MCP शुरू करें", "Запустити MCP"}},
        {"stopMCP", new[] {"Stop MCP", "MCP 중지", "MCP を停止", "停止 MCP", "停止 MCP", "Detener MCP", "Arrêter MCP", "MCP stoppen", "Parar MCP", "Ferma MCP", "MCP stoppen", "Zatrzymaj MCP", "Остановить MCP", "MCP durdur", "Dừng MCP", "Hentikan MCP", "หยุด MCP", "إيقاف MCP", "MCP रोकें", "Зупинити MCP"}},
        {"restartMCP", new[] {"Restart MCP", "MCP 재시작", "MCP を再起動", "重启 MCP", "重新啟動 MCP", "Reiniciar MCP", "Redémarrer MCP", "MCP neu starten", "Reiniciar MCP", "Riavvia MCP", "MCP herstarten", "Uruchom ponownie MCP", "Перезапустить MCP", "MCP yeniden başlat", "Khởi động lại MCP", "Mulai ulang MCP", "รีสตาร์ท MCP", "إعادة تشغيل MCP", "MCP फिर शुरू करें", "Перезапустити MCP"}},
        {"settingsMenu", new[] {"Settings...", "설정...", "設定...", "设置...", "設定...", "Ajustes...", "Réglages...", "Einstellungen...", "Configurações...", "Impostazioni...", "Instellingen...", "Ustawienia...", "Настройки...", "Ayarlar...", "Cài đặt...", "Pengaturan...", "การตั้งค่า...", "الإعدادات...", "सेटिंग्स...", "Налаштування..."}},
        {"connectionDiagnosticsMenu", new[] {"Connection Diagnostics...", "연결 진단 로그..."}},
        {"quit", new[] {"Quit", "종료", "終了", "退出", "結束", "Salir", "Quitter", "Beenden", "Sair", "Esci", "Afsluiten", "Zakończ", "Выход", "Çık", "Thoát", "Keluar", "ออก", "إنهاء", "बंद करें", "Вийти"}},
        {"settingsTitle", new[] {"ChatGPT To Codex Settings", "ChatGPT To Codex 설정", "ChatGPT To Codex 設定", "ChatGPT To Codex 设置", "ChatGPT To Codex 設定", "Ajustes de ChatGPT To Codex", "Réglages de ChatGPT To Codex", "ChatGPT To Codex Einstellungen", "Configurações do ChatGPT To Codex", "Impostazioni ChatGPT To Codex", "ChatGPT To Codex instellingen", "Ustawienia ChatGPT To Codex", "Настройки ChatGPT To Codex", "ChatGPT To Codex ayarları", "Cài đặt ChatGPT To Codex", "Pengaturan ChatGPT To Codex", "การตั้งค่า ChatGPT To Codex", "إعدادات ChatGPT To Codex", "ChatGPT To Codex सेटिंग्स", "Налаштування ChatGPT To Codex"}},
        {"language", new[] {"Language", "언어", "言語", "语言", "語言", "Idioma", "Langue", "Sprache", "Idioma", "Lingua", "Taal", "Język", "Язык", "Dil", "Ngôn ngữ", "Bahasa", "ภาษา", "اللغة", "भाषा", "Мова"}},
        {"projectFolder", new[] {"Project folder", "프로젝트 폴더", "プロジェクトフォルダ", "项目文件夹", "專案資料夾", "Carpeta del proyecto", "Dossier du projet", "Projektordner", "Pasta do projeto", "Cartella progetto", "Projectmap", "Folder projektu", "Папка проекта", "Proje klasörü", "Thư mục dự án", "Folder proyek", "โฟลเดอร์โปรเจกต์", "مجلد المشروع", "प्रोजेक्ट फ़ोल्डर", "Тека проєкту"}},
        {"browse", new[] {"Browse...", "찾아보기...", "参照...", "浏览...", "瀏覽...", "Examinar...", "Parcourir...", "Durchsuchen...", "Procurar...", "Sfoglia...", "Bladeren...", "Przeglądaj...", "Обзор...", "Gözat...", "Duyệt...", "Telusuri...", "เรียกดู...", "استعراض...", "ब्राउज़...", "Огляд..."}},
        {"launchWindowsSetting", new[] {"Launch ChatGPT To Codex when Windows starts", "Windows 시작 시 ChatGPT To Codex 실행", "Windows 起動時に ChatGPT To Codex を起動", "Windows 启动时启动 ChatGPT To Codex", "Windows 啟動時啟動 ChatGPT To Codex", "Iniciar ChatGPT To Codex con Windows", "Lancer ChatGPT To Codex au démarrage de Windows", "ChatGPT To Codex beim Windows-Start starten", "Abrir ChatGPT To Codex ao iniciar o Windows", "Avvia ChatGPT To Codex con Windows", "ChatGPT To Codex starten met Windows", "Uruchamiaj ChatGPT To Codex z Windows", "Запускать ChatGPT To Codex с Windows", "Windows açılışında ChatGPT To Codex başlat", "Mở ChatGPT To Codex cùng Windows", "Jalankan ChatGPT To Codex saat Windows mulai", "เปิด ChatGPT To Codex พร้อม Windows", "تشغيل ChatGPT To Codex عند بدء Windows", "Windows शुरू होने पर ChatGPT To Codex चलाएं", "Запускати ChatGPT To Codex з Windows"}},
        {"startOnOpenSetting", new[] {"Start MCP automatically when the app opens", "앱 열 때 MCP 자동 시작", "アプリ起動時に MCP を自動開始", "应用打开时自动启动 MCP", "App 開啟時自動啟動 MCP", "Iniciar MCP automáticamente al abrir la app", "Démarrer MCP automatiquement à l'ouverture", "MCP beim Öffnen automatisch starten", "Iniciar MCP automaticamente ao abrir o app", "Avvia MCP automaticamente all'apertura", "Start MCP automatisch bij openen", "Automatycznie uruchamiaj MCP przy otwarciu", "Автоматически запускать MCP при открытии", "Uygulama açılınca MCP otomatik başlasın", "Tự động khởi động MCP khi mở ứng dụng", "Mulai MCP otomatis saat app dibuka", "เริ่ม MCP อัตโนมัติเมื่อเปิดแอป", "بدء MCP تلقائيا عند فتح التطبيق", "ऐप खुलने पर MCP अपने-आप शुरू करें", "Автоматично запускати MCP під час відкриття"}},
        {"autoUpdatesSetting", new[] {"Check for updates automatically", "업데이트 자동 확인", "更新を自動確認", "自动检查更新", "自動檢查更新", "Buscar actualizaciones automáticamente", "Recherche automatique des mises à jour", "Automatisch nach Updates suchen", "Verificar atualizações automaticamente", "Controlla aggiornamenti automaticamente", "Automatisch updates zoeken", "Automatycznie sprawdzaj aktualizacje", "Автоматически проверять обновления", "Güncellemeleri otomatik denetle", "Tự động kiểm tra cập nhật", "Periksa pembaruan otomatis", "ตรวจอัปเดตอัตโนมัติ", "التحقق التلقائي من التحديثات", "अपडेट अपने-आप जांचें", "Автоматично перевіряти оновлення"}},
        {"publicTunnelSetting", new[] {"Enable ChatGPT web connector", "ChatGPT 웹 커넥터 사용", "ChatGPT Web コネクタを有効化", "启用 ChatGPT 网页连接器", "啟用 ChatGPT 網頁連接器", "Activar conector web de ChatGPT", "Activer le connecteur web ChatGPT", "ChatGPT-Web-Connector aktivieren", "Ativar conector web do ChatGPT", "Abilita connettore web ChatGPT", "ChatGPT-webconnector inschakelen", "Włącz konektor web ChatGPT", "Включить веб-коннектор ChatGPT", "ChatGPT web bağlayıcısını etkinleştir", "Bật trình kết nối web ChatGPT", "Aktifkan konektor web ChatGPT", "เปิดตัวเชื่อมต่อเว็บ ChatGPT", "تفعيل موصل ChatGPT على الويب", "ChatGPT वेब कनेक्टर चालू करें", "Увімкнути веб-конектор ChatGPT"}},
        {"publicHostname", new[] {"Owned fixed domain (optional)", "본인 소유 고정 도메인 (선택)", "所有する固定ドメイン (任意)", "自有固定域名（可选）", "自有固定網域（選填）", "Dominio fijo propio (opcional)", "Domaine fixe personnel (facultatif)", "Eigene feste Domain (optional)", "Domínio fixo próprio (opcional)", "Dominio fisso personale (opzionale)", "Eigen vast domein (optioneel)", "Własna stała domena (opcjonalnie)", "Собственный постоянный домен (необязательно)", "Kendi sabit alan adınız (isteğe bağlı)", "Tên miền cố định của bạn (tùy chọn)", "Domain tetap milik Anda (opsional)", "โดเมนคงที่ของคุณ (ไม่บังคับ)", "نطاق ثابت تملكه (اختياري)", "आपका स्थिर डोमेन (वैकल्पिक)", "Власний сталий домен (необов'язково)"}},
        {"publicHostnameHint", new[] {"Blank uses a temporary Quick Tunnel URL. It changes on restart, so reconnect ChatGPT. Use your own Cloudflare Named Tunnel hostname for daily use.", "비워두면 임시 Quick Tunnel URL을 씁니다. 재시작하면 주소가 바뀌므로 ChatGPT를 다시 연결해야 합니다. 상시 사용은 본인 Cloudflare Named Tunnel 호스트명을 입력하세요.", "空欄なら一時 Quick Tunnel URL を使います。再起動で変わるため ChatGPT の再接続が必要です。常用は自分の Cloudflare Named Tunnel ホスト名を入力してください。", "留空会使用临时 Quick Tunnel URL。重启后会变化，需要重新连接 ChatGPT。日常使用请输入自己的 Cloudflare Named Tunnel 主机名。", "留空會使用臨時 Quick Tunnel URL。重新啟動後會變更，需重新連接 ChatGPT。日常使用請輸入自己的 Cloudflare Named Tunnel 主機名稱。", "En blanco usa una URL temporal de Quick Tunnel. Cambia al reiniciar; vuelve a conectar ChatGPT. Para uso diario escribe tu hostname de Cloudflare Named Tunnel.", "Vide, utilise une URL Quick Tunnel temporaire. Elle change au redémarrage; reconnectez ChatGPT. Pour l'usage quotidien, indiquez votre hôte Cloudflare Named Tunnel.", "Leer nutzt eine temporäre Quick-Tunnel-URL. Sie ändert sich beim Neustart; ChatGPT neu verbinden. Für Dauerbetrieb eigene Cloudflare-Named-Tunnel-Hostname eintragen.", "Em branco usa uma URL temporária Quick Tunnel. Ela muda ao reiniciar; reconecte o ChatGPT. Para uso diário, informe seu hostname Cloudflare Named Tunnel.", "Vuoto usa un URL Quick Tunnel temporaneo. Cambia al riavvio; riconnetti ChatGPT. Per l'uso quotidiano inserisci il tuo hostname Cloudflare Named Tunnel.", "Leeg gebruikt een tijdelijke Quick Tunnel-URL. Die wijzigt na herstart; verbind ChatGPT opnieuw. Voor dagelijks gebruik vul je je Cloudflare Named Tunnel-hostnaam in.", "Puste używa tymczasowego URL Quick Tunnel. Zmienia się po restarcie; połącz ChatGPT ponownie. Do codziennego użycia wpisz własny hostname Cloudflare Named Tunnel.", "Пусто — временный URL Quick Tunnel. Он меняется при перезапуске; подключите ChatGPT заново. Для постоянной работы укажите свой hostname Cloudflare Named Tunnel.", "Boşsa geçici Quick Tunnel URL kullanır. Yeniden başlatınca değişir; ChatGPT'yi yeniden bağlayın. Günlük kullanım için kendi Cloudflare Named Tunnel hostname'inizi girin.", "Để trống sẽ dùng URL Quick Tunnel tạm thời. URL đổi khi khởi động lại; hãy kết nối lại ChatGPT. Dùng hằng ngày thì nhập hostname Cloudflare Named Tunnel của bạn.", "Kosong memakai URL Quick Tunnel sementara. URL berubah saat restart; hubungkan ulang ChatGPT. Untuk harian, isi hostname Cloudflare Named Tunnel milik Anda.", "เว้นว่างเพื่อใช้ URL Quick Tunnel ชั่วคราว ซึ่งจะเปลี่ยนเมื่อรีสตาร์ต ต้องเชื่อมต่อ ChatGPT ใหม่ ใช้งานประจำให้ใส่ hostname Cloudflare Named Tunnel ของคุณ", "فارغ يعني استخدام رابط Quick Tunnel مؤقت. يتغير عند إعادة التشغيل؛ أعد ربط ChatGPT. للاستخدام اليومي أدخل اسم مضيف Cloudflare Named Tunnel الخاص بك.", "खाली रखने पर अस्थायी Quick Tunnel URL प्रयोग होगा। रीस्टार्ट पर बदलता है; ChatGPT फिर जोड़ें। रोज़ उपयोग के लिए अपना Cloudflare Named Tunnel hostname डालें।", "Порожньо — тимчасовий URL Quick Tunnel. Після перезапуску змінюється; підключіть ChatGPT знову. Для щоденного використання вкажіть свій hostname Cloudflare Named Tunnel."}},
        {"localPort", new[] {"Local port", "로컬 포트", "ローカルポート", "本地端口", "本機連接埠", "Puerto local", "Port local", "Lokaler Port", "Porta local", "Porta locale", "Lokale poort", "Port lokalny", "Локальный порт", "Yerel bağlantı noktası", "Cổng cục bộ", "Port lokal", "พอร์ตภายใน", "المنفذ المحلي", "स्थानीय पोर्ट", "Локальний порт"}},
        {"githubRepositoryURL", new[] {"GitHub repository URL", "GitHub 저장소 URL", "GitHub リポジトリ URL", "GitHub 仓库 URL", "GitHub 儲存庫 URL", "URL del repositorio GitHub", "URL du dépôt GitHub", "GitHub-Repository-URL", "URL do repositório GitHub", "URL repository GitHub", "GitHub-repository-URL", "URL repozytorium GitHub", "URL репозитория GitHub", "GitHub depo URL'si", "URL kho GitHub", "URL repositori GitHub", "URL GitHub repository", "رابط مستودع GitHub", "GitHub रिपॉज़िटरी URL", "URL репозиторію GitHub"}},
        {"copyConnector", new[] {"Copy Connector URL", "커넥터 URL 복사", "コネクタ URL をコピー", "复制连接器 URL", "複製連接器 URL", "Copiar URL del conector", "Copier l'URL du connecteur", "Connector-URL kopieren", "Copiar URL do conector", "Copia URL connettore", "Connector-URL kopiëren", "Kopiuj URL konektora", "Копировать URL коннектора", "Bağlayıcı URL'sini kopyala", "Sao chép URL kết nối", "Salin URL konektor", "คัดลอก URL ตัวเชื่อมต่อ", "نسخ رابط الموصل", "कनेक्टर URL कॉपी करें", "Скопіювати URL конектора"}},
        {"copyOwnerToken", new[] {"Copy Owner Token", "소유자 토큰 복사", "所有者トークンをコピー", "复制所有者令牌", "複製擁有者權杖", "Copiar token de propietario", "Copier le jeton propriétaire", "Owner-Token kopieren", "Copiar token do proprietário", "Copia token proprietario", "Owner-token kopiëren", "Kopiuj token właściciela", "Копировать токен владельца", "Sahip tokenini kopyala", "Sao chép token chủ sở hữu", "Salin token pemilik", "คัดลอกโทเคนเจ้าของ", "نسخ رمز المالك", "Owner token कॉपी करें", "Скопіювати токен власника"}},
        {"autoGenerateToken", new[] {"Auto-generate Token", "토큰 자동 생성", "トークンを自動生成", "自动生成令牌", "自動產生權杖", "Generar token automáticamente", "Générer le jeton automatiquement", "Token automatisch erzeugen", "Gerar token automaticamente", "Genera token automaticamente", "Token automatisch genereren", "Automatycznie wygeneruj token", "Автоматически создать токен", "Tokeni otomatik oluştur", "Tự động tạo token", "Buat token otomatis", "สร้างโทเคนอัตโนมัติ", "إنشاء الرمز تلقائيا", "Token अपने-आप बनाएं", "Автоматично створити токен"}},
        {"openLocalHealth", new[] {"Open Local Health", "로컬 상태 열기", "ローカルヘルスを開く", "打开本地健康检查", "開啟本機健康檢查", "Abrir estado local", "Ouvrir l'état local", "Lokalen Status öffnen", "Abrir saúde local", "Apri stato locale", "Lokale status openen", "Otwórz status lokalny", "Открыть локальный статус", "Yerel durumu aç", "Mở trạng thái cục bộ", "Buka kesehatan lokal", "เปิดสถานะภายใน", "فتح حالة الجهاز", "स्थानीय हेल्थ खोलें", "Відкрити локальний стан"}},
        {"openPublicHealth", new[] {"Open Public Health", "공개 상태 열기", "公開ヘルスを開く", "打开公开健康检查", "開啟公開健康檢查", "Abrir estado público", "Ouvrir l'état public", "Öffentlichen Status öffnen", "Abrir saúde pública", "Apri stato pubblico", "Publieke status openen", "Otwórz status publiczny", "Открыть публичный статус", "Genel durumu aç", "Mở trạng thái công khai", "Buka kesehatan publik", "เปิดสถานะสาธารณะ", "فتح الحالة العامة", "सार्वजनिक हेल्थ खोलें", "Відкрити публічний стан"}},
        {"showLogs", new[] {"Show Logs", "로그 보기", "ログを表示", "显示日志", "顯示日誌", "Mostrar registros", "Afficher les journaux", "Logs anzeigen", "Mostrar logs", "Mostra log", "Logs tonen", "Pokaż logi", "Показать журналы", "Günlükleri göster", "Hiện nhật ký", "Tampilkan log", "แสดงบันทึก", "عرض السجلات", "लॉग दिखाएं", "Показати журнали"}},
        {"openGithub", new[] {"Open GitHub Repository", "GitHub 저장소 열기", "GitHub リポジトリを開く", "打开 GitHub 仓库", "開啟 GitHub 儲存庫", "Abrir repositorio GitHub", "Ouvrir le dépôt GitHub", "GitHub-Repository öffnen", "Abrir repositório GitHub", "Apri repository GitHub", "GitHub-repository openen", "Otwórz repozytorium GitHub", "Открыть репозиторий GitHub", "GitHub deposunu aç", "Mở kho GitHub", "Buka repositori GitHub", "เปิด GitHub repository", "فتح مستودع GitHub", "GitHub रिपॉज़िटरी खोलें", "Відкрити репозиторій GitHub"}},
        {"checkUpdates", new[] {"Check for Updates...", "업데이트 확인...", "更新を確認...", "检查更新...", "檢查更新..."}},
        {"about", new[] {"About ezBuilder", "ezBuilder 정보", "ezBuilder について", "关于 ezBuilder", "關於 ezBuilder"}},
        {"save", new[] {"Save", "저장", "保存", "保存", "儲存", "Guardar", "Enregistrer", "Speichern", "Salvar", "Salva", "Opslaan", "Zapisz", "Сохранить", "Kaydet", "Lưu", "Simpan", "บันทึก", "حفظ", "सहेजें", "Зберегти"}},
        {"cancel", new[] {"Cancel", "취소", "キャンセル", "取消", "取消", "Cancelar", "Annuler", "Abbrechen", "Cancelar", "Annulla", "Annuleren", "Anuluj", "Отмена", "İptal", "Hủy", "Batal", "ยกเลิก", "إلغاء", "रद्द करें", "Скасувати"}},
        {"connectorUrlLabel", new[] {"connector URL", "커넥터 URL"}},
        {"ownerTokenLabel", new[] {"owner token", "소유자 토큰"}},
        {"copiedItem", new[] {"Copied {0}.", "{0} 복사 완료."}},
        {"copyFailedManual", new[] {"Copy failed. Select the {0} field manually.", "복사에 실패했습니다. {0} 입력칸을 직접 선택해 복사하세요."}},
        {"ownerTokenGenerating", new[] {"Auto-generating owner token...", "소유자 토큰 자동 생성 중..."}},
        {"ownerTokenConfigured", new[] {"Owner token already configured. Click Auto-generate Token to create/copy a new one.", "소유자 토큰이 이미 설정되어 있습니다. 새 토큰이 필요하면 토큰 자동 생성을 누르세요."}},
        {"ownerTokenReadyCopied", new[] {"Owner token ready and copied. Paste it into ChatGPT when prompted.", "소유자 토큰 생성 및 복사 완료. ChatGPT가 요청하면 붙여넣으세요."}},
        {"ownerTokenReadyManualCopy", new[] {"Owner token is ready, but clipboard copy failed. The field is selected for manual copy.", "소유자 토큰은 생성됐지만 클립보드 복사에 실패했습니다. 입력칸을 선택해 두었으니 직접 복사하세요."}},
        {"ownerTokenNotReady", new[] {"Owner token is not ready yet. Click Auto-generate Token first.", "소유자 토큰이 아직 준비되지 않았습니다. 먼저 토큰 자동 생성을 누르세요."}},
        {"temporaryTunnelReady", new[] {"Temporary tunnel URL ready. It changes when the tunnel restarts.", "임시 터널 URL 준비 완료. 터널을 재시작하면 주소가 바뀝니다."}},
        {"temporaryTunnelChanged", new[] {"Temporary tunnel URL changed. Reconnect or update the ChatGPT app registration.", "임시 터널 URL이 변경되었습니다. ChatGPT 앱 등록을 다시 연결하거나 업데이트하세요."}},
        {"temporaryTunnelCopied", new[] {"Temporary connector URL copied. For permanent use, configure a stable domain before registering in ChatGPT.", "임시 커넥터 URL 복사 완료. 상시 사용하려면 ChatGPT 등록 전에 고정 도메인을 설정하세요."}},
        {"stableConnectorReady", new[] {"Ready: {0}", "준비됨: {0}"}},
        {"projectPrefix", new[] {"Project", "프로젝트"}},
        {"portPrefix", new[] {"Port", "포트"}},
        {"activeSessionsMenu", new[] {"Active session status", "활성 세션 상태"}},
        {"sessionNoActive", new[] {"No active sessions", "활성 세션 없음"}},
        {"agentArmOnMenu", new[] {"Agent Arm: on", "Agent Arm: 켜짐"}},
        {"agentArmOffMenu", new[] {"Agent Arm: off", "Agent Arm: 꺼짐"}},
        {"agentArmUnavailableWindows", new[] {"Agent Arm: unavailable on Windows", "Agent Arm: Windows에서 아직 지원 안 됨"}},
        {"pendingControlActionsMenu", new[] {"Pending control actions", "대기 중인 제어 작업"}},
        {"controlNoPendingActions", new[] {"No pending actions", "대기 중인 작업 없음"}},
        {"controlApprove", new[] {"Approve", "승인"}},
        {"controlReject", new[] {"Reject", "거부"}},
        {"pendingOAuthApprovalsMenu", new[] {"Pending OAuth connections", "대기 중인 OAuth 연결"}},
        {"oauthNoPendingApprovals", new[] {"No pending OAuth connections", "대기 중인 OAuth 연결 없음"}},
        {"oauthApprovalTitle", new[] {"ChatGPT OAuth connection", "ChatGPT OAuth 연결"}},
        {"oauthApprovalPrompt", new[] {"Approve this one OAuth connection request?\r\n\r\nClient: {0}\r\nScopes: {1}\r\nConnector: {2}\r\nReturn host: {3}\r\n\r\nYes = approve, No = reject, Cancel = later.\r\nOwner Token and OAuth access/refresh tokens are never shown here.", "이 OAuth 연결 요청 한 건을 승인할까요?\r\n\r\n클라이언트: {0}\r\n권한: {1}\r\n커넥터: {2}\r\n돌아갈 호스트: {3}\r\n\r\n예 = 승인, 아니요 = 거부, 취소 = 나중에.\r\nOwner Token과 OAuth access/refresh token은 여기에 표시되지 않습니다."}},
        {"approveAllControlMenu", new[] {"Approve all pending", "대기 중인 작업 모두 승인"}},
        {"autoApproveOnMenu", new[] {"Turn on auto-approve (10 min)", "자동 승인 켜기 (10분)"}},
        {"autoApproveOffMenu", new[] {"Turn off auto-approve", "자동 승인 끄기"}},
        {"autoApproveStatusMenu", new[] {"Auto-approve: on ({0}m)", "자동 승인: 켜짐 ({0}분)"}},
        {"autoApproveUnavailableMenu", new[] {"Auto-approve needs an allowlisted app", "자동 승인에는 허용 목록 앱이 필요합니다"}},
        {"killControlMenu", new[] {"Kill Control", "제어 강제 종료"}},
        {"killControlConfirmTitle", new[] {"Stop all desktop control?", "모든 데스크톱 제어를 중지할까요?"}},
        {"killControlConfirmInfo", new[] {"This rejects every pending control action and blocks new ones until control is armed again.", "대기 중인 모든 제어 작업을 거부하고 제어를 다시 켤 때까지 새 작업을 차단합니다."}},
        {"localStatusUnavailable", new[] {"Local status is not available", "로컬 상태를 확인할 수 없음"}}
    };
    private readonly string[] args;
    private readonly string root;
    private readonly string appDataDir;
    private readonly string logDir;
    private readonly string logFile;
    private readonly string connectionDiagnosticsFile;
    private readonly string selectedProjectFile;
    private readonly string settingsFile;
    private readonly string sharedSettingsFile;
    private readonly string defaultWorkspace;
    private string configuredPublicHost;
    private string lastConnectorUrl;
    private int port;
    private string preferredLanguage = "auto";
    private string githubRepoUrl;
    private bool publicTunnelEnabled;
    private bool launchAtStartup;
    private bool startMcpOnOpen;
    private bool autoCheckUpdates;
    private bool multiProjectLanesEnabled = true;
    private string[] controlAllowlist = new[] { "Finder" };
    private DateTime sharedSettingsLastWriteUtc = DateTime.MinValue;
    private readonly TextBox logBox;
    private readonly TextBox urlBox;
    private readonly TextBox ownerTokenBox;
    private readonly Label statusLabel;
    private readonly Button copyButton;
    private readonly Button copyOwnerTokenButton;
    private readonly Button autoGenerateOwnerTokenButton;
    private readonly Button stopButton;
    private readonly Button openLogButton;
    private readonly NotifyIcon trayIcon;
    private readonly ContextMenuStrip trayMenu;
    private readonly ToolStripMenuItem statusTrayItem;
    private readonly ToolStripMenuItem projectTrayItem;
    private readonly ToolStripMenuItem portTrayItem;
    private readonly ToolStripMenuItem sessionsTrayItem;
    private readonly ToolStripMenuItem oauthApprovalsTrayItem;
    private readonly ToolStripMenuItem armTrayItem;
    private readonly ToolStripMenuItem killTrayItem;
    private readonly ToolStripMenuItem pendingTrayItem;
    private readonly ToolStripMenuItem toggleTrayItem;
    private readonly ToolStripMenuItem restartTrayItem;
    private readonly ToolStripMenuItem connectionDiagnosticsTrayItem;
    private readonly ToolStripMenuItem activityTrayItem;
    private readonly ToolStripMenuItem settingsTrayItem;
    private readonly ToolStripMenuItem quitTrayItem;
    private readonly System.Windows.Forms.Timer controlStatusTimer;
    private Process process;
    private string mcpUrl;
    private string ownerToken;
    private string pendingSecretKind;
    private string selectedProjectPath;
    private bool stopping;
    private bool exitRequested;
    private bool trayNoticeShown;
    private bool unifiedDashboardShown;
    private bool autoGenerateOwnerTokenOnNextStart;
    private bool controlStatusRefreshInFlight;
    private LocalControlSnapshot latestControlSnapshot;
    private readonly HashSet<string> presentedOAuthApprovalIds = new HashSet<string>(StringComparer.Ordinal);
    private bool oauthApprovalDialogOpen;

    internal LauncherForm(string[] args)
    {
        this.args = args;
        root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (string.IsNullOrWhiteSpace(localAppData)) localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        appDataDir = Path.Combine(localAppData, "ChatGPT To Codex");
        logDir = Path.Combine(appDataDir, "logs");
        selectedProjectFile = Path.Combine(appDataDir, "selected-project.txt");
        settingsFile = Path.Combine(appDataDir, "settings.ini");
        var userProfile = ResolveUserProfileDirectory();
        sharedSettingsFile = Path.Combine(
            userProfile,
            ".local",
            "share",
            "chatgpt2codex",
            "desktop-settings.json");
        defaultWorkspace = ResolveDefaultWorkspace();
        configuredPublicHost = ResolveConfiguredPublicHost();
        port = ResolvePort();
        publicTunnelEnabled = false;
        githubRepoUrl = Environment.GetEnvironmentVariable("CHATGPT2CODEX_UPDATE_REPO_URL");
        if (string.IsNullOrWhiteSpace(githubRepoUrl)) githubRepoUrl = "https://github.com/ezBuilder/chatgpt2codex";
        LoadSettings();
        if (string.IsNullOrEmpty(selectedProjectPath)) selectedProjectPath = LoadSelectedProjectPath();
        SeedOrLoadSharedSettings();
        Directory.CreateDirectory(logDir);
        PruneLauncherLogs(logDir);
        logFile = Path.Combine(logDir, "launcher-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log");
        connectionDiagnosticsFile = Path.Combine(
            userProfile,
            ".local",
            "share",
            "chatgpt2codex",
            "connection-events.jsonl");

        Text = "ChatGPT To Codex";
        Width = 920;
        Height = 620;
        StartPosition = FormStartPosition.CenterScreen;
        SetWindowIcon(this);

        statusLabel = new Label();
        statusLabel.Text = "ChatGPT To Codex: " + L("statusChecking");
        statusLabel.Dock = DockStyle.Top;
        statusLabel.Height = 34;
        statusLabel.Padding = new Padding(10, 8, 10, 0);

        logBox = new TextBox();
        logBox.Dock = DockStyle.Fill;
        logBox.Multiline = true;
        logBox.ReadOnly = true;
        logBox.ScrollBars = ScrollBars.Both;
        logBox.WordWrap = false;
        logBox.Font = new System.Drawing.Font("Consolas", 10);

        var bottomPanel = new TableLayoutPanel();
        bottomPanel.Dock = DockStyle.Bottom;
        bottomPanel.Height = 86;
        bottomPanel.ColumnCount = 1;
        bottomPanel.RowCount = 2;
        bottomPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        bottomPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));

        var urlPanel = new FlowLayoutPanel();
        urlPanel.Dock = DockStyle.Fill;
        urlPanel.Padding = new Padding(8, 7, 8, 0);
        urlPanel.FlowDirection = FlowDirection.LeftToRight;
        urlPanel.WrapContents = false;

        urlBox = new TextBox();
        urlBox.Width = 520;
        urlBox.ReadOnly = true;
        urlBox.Text = "Connector URL will appear here";

        copyButton = new Button();
        copyButton.Text = L("copyConnector");
        copyButton.Width = 150;
        copyButton.Enabled = false;
        copyButton.Click += delegate { CopyMcpUrl(); };

        var tokenPanel = new FlowLayoutPanel();
        tokenPanel.Dock = DockStyle.Fill;
        tokenPanel.Padding = new Padding(8, 1, 8, 7);
        tokenPanel.FlowDirection = FlowDirection.LeftToRight;
        tokenPanel.WrapContents = false;

        ownerTokenBox = new TextBox();
        ownerTokenBox.Width = 520;
        ownerTokenBox.ReadOnly = true;
        ownerTokenBox.Text = "Owner token will be auto-generated and copied on first setup";

        copyOwnerTokenButton = new Button();
        copyOwnerTokenButton.Text = L("copyOwnerToken");
        copyOwnerTokenButton.Width = 130;
        copyOwnerTokenButton.Enabled = false;
        copyOwnerTokenButton.Click += delegate { CopyOwnerToken(); };

        autoGenerateOwnerTokenButton = new Button();
        autoGenerateOwnerTokenButton.Text = L("autoGenerateToken");
        autoGenerateOwnerTokenButton.Width = 150;
        autoGenerateOwnerTokenButton.Click += delegate { AutoGenerateOwnerToken(); };

        openLogButton = new Button();
        openLogButton.Text = L("showLogs");
        openLogButton.Width = 100;
        openLogButton.Click += delegate { ShowLogs(); };

        stopButton = new Button();
        stopButton.Text = L("stopMCP");
        stopButton.Width = 100;
        stopButton.Click += delegate { ToggleServer(); };

        urlPanel.Controls.Add(urlBox);
        urlPanel.Controls.Add(copyButton);
        urlPanel.Controls.Add(openLogButton);
        urlPanel.Controls.Add(stopButton);

        tokenPanel.Controls.Add(ownerTokenBox);
        tokenPanel.Controls.Add(copyOwnerTokenButton);
        tokenPanel.Controls.Add(autoGenerateOwnerTokenButton);

        bottomPanel.Controls.Add(urlPanel, 0, 0);
        bottomPanel.Controls.Add(tokenPanel, 0, 1);

        Controls.Add(logBox);
        Controls.Add(bottomPanel);
        Controls.Add(statusLabel);

        trayMenu = new ContextMenuStrip();
        statusTrayItem = new ToolStripMenuItem("ChatGPT To Codex: " + L("statusChecking"));
        statusTrayItem.Enabled = false;
        projectTrayItem = new ToolStripMenuItem(L("projectPrefix") + ": -");
        projectTrayItem.Enabled = false;
        portTrayItem = new ToolStripMenuItem(L("portPrefix") + ": " + port);
        portTrayItem.Enabled = false;
        sessionsTrayItem = new ToolStripMenuItem(L("activeSessionsMenu"));
        sessionsTrayItem.DropDownItems.Add(new ToolStripMenuItem(L("sessionNoActive")) { Enabled = false });
        oauthApprovalsTrayItem = new ToolStripMenuItem(L("pendingOAuthApprovalsMenu"));
        oauthApprovalsTrayItem.DropDownItems.Add(new ToolStripMenuItem(L("oauthNoPendingApprovals")) { Enabled = false });
        armTrayItem = new ToolStripMenuItem(L("agentArmOffMenu"), null, delegate { ToggleAgentArm(); });
        armTrayItem.Enabled = false;
        killTrayItem = new ToolStripMenuItem(L("killControlMenu"), null, delegate { KillControl(); });
        killTrayItem.Enabled = false;
        pendingTrayItem = new ToolStripMenuItem(L("pendingControlActionsMenu"));
        pendingTrayItem.DropDownItems.Add(new ToolStripMenuItem(L("controlNoPendingActions")) { Enabled = false });
        toggleTrayItem = new ToolStripMenuItem(L("startMCP"), null, delegate { ToggleServer(); });
        restartTrayItem = new ToolStripMenuItem(L("restartMCP"), null, delegate { RestartServer(); });
        connectionDiagnosticsTrayItem = new ToolStripMenuItem(
            L("connectionDiagnosticsMenu"),
            null,
            delegate { ShowConnectionDiagnostics(); });
        activityTrayItem = new ToolStripMenuItem("Open ChatGPT To Codex", null, delegate
        {
            if (IsManagedProcessRunning()) OpenUnifiedDashboard(null);
            else ShowFromTray();
        });
        settingsTrayItem = new ToolStripMenuItem(L("settingsMenu"), null, delegate { OpenSettingsExperience(); });
        quitTrayItem = new ToolStripMenuItem(L("quit"), null, delegate { ExitApplication(); });
        trayMenu.Items.Add(statusTrayItem);
        trayMenu.Items.Add(projectTrayItem);
        trayMenu.Items.Add(portTrayItem);
        trayMenu.Items.Add(sessionsTrayItem);
        trayMenu.Items.Add(oauthApprovalsTrayItem);
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add(armTrayItem);
        trayMenu.Items.Add(killTrayItem);
        trayMenu.Items.Add(pendingTrayItem);
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add(toggleTrayItem);
        trayMenu.Items.Add(restartTrayItem);
        trayMenu.Items.Add(activityTrayItem);
        trayMenu.Items.Add(connectionDiagnosticsTrayItem);
        trayMenu.Items.Add(settingsTrayItem);
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add(quitTrayItem);
        trayMenu.Opening += delegate { RequestLocalControlRefresh(); };

        trayIcon = new NotifyIcon();
        trayIcon.Text = "ChatGPT To Codex";
        trayIcon.Icon = Icon == null ? System.Drawing.SystemIcons.Application : Icon;
        trayIcon.ContextMenuStrip = trayMenu;
        trayIcon.Visible = true;
        trayIcon.DoubleClick += delegate
        {
            if (IsManagedProcessRunning()) OpenUnifiedDashboard(null);
            else ShowFromTray();
        };

        controlStatusTimer = new System.Windows.Forms.Timer();
        controlStatusTimer.Interval = 2000;
        controlStatusTimer.Tick += delegate
        {
            RequestLocalControlRefresh();
            RefreshSharedSettingsIfChanged();
        };
        controlStatusTimer.Start();
        RefreshTrayState();

        Shown += delegate
        {
            if (startMcpOnOpen || args.Length > 0)
            {
                StartLauncher();
            }
            else
            {
                statusLabel.Text = "ChatGPT To Codex: " + L("statusOff");
                RefreshTrayState();
            }
            if (autoCheckUpdates) CheckUpdates(false);
        };
        Resize += delegate
        {
            if (WindowState == FormWindowState.Minimized) HideToTray();
        };
        FormClosing += OnFormClosing;
        FormClosed += delegate
        {
            controlStatusTimer.Stop();
            controlStatusTimer.Dispose();
            trayIcon.Visible = false;
            trayIcon.Dispose();
            trayMenu.Dispose();
        };
    }

    private static string Quote(string value)
    {
        if (string.IsNullOrEmpty(value)) return "\"\"";
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static void SetWindowIcon(Form form)
    {
        try
        {
            var icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (icon != null) form.Icon = icon;
        }
        catch
        {
            // The embedded icon is used when present; the app can still run without it.
        }
    }

    private static string JoinArgs(string[] values)
    {
        var builder = new StringBuilder();
        for (var i = 0; i < values.Length; i++)
        {
            if (i > 0) builder.Append(' ');
            builder.Append(Quote(values[i]));
        }
        return builder.ToString();
    }

    private static bool IsOption(string value, string option)
    {
        return string.Equals(value, option, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(value, "/" + option.TrimStart('-'), StringComparison.OrdinalIgnoreCase);
    }

    private static string ResolveLanguageCode(string value)
    {
        var raw = !string.IsNullOrWhiteSpace(value) && !string.Equals(value, "auto", StringComparison.OrdinalIgnoreCase)
            ? value
            : System.Globalization.CultureInfo.CurrentUICulture.Name;
        var lower = raw.ToLowerInvariant();
        if (lower.StartsWith("zh-hant") || lower.StartsWith("zh-tw") || lower.StartsWith("zh-hk") || lower.StartsWith("zh-mo")) return "zh-Hant";
        if (lower.StartsWith("zh")) return "zh-Hans";
        if (lower.StartsWith("pt")) return "pt-BR";
        foreach (var code in LanguageCodes)
        {
            var exact = code.ToLowerInvariant();
            var prefix = exact.Split('-')[0];
            if (lower == exact || lower.StartsWith(prefix + "-")) return code;
        }
        return "en";
    }

    private string L(string key)
    {
        string[] row;
        if (!Texts.TryGetValue(key, out row) || row == null || row.Length == 0) return key;
        var code = ResolveLanguageCode(preferredLanguage);
        var index = Array.IndexOf(LanguageCodes, code);
        if (index < 0 || index >= row.Length || string.IsNullOrEmpty(row[index])) return row[0];
        return row[index];
    }

    private string LFormat(string key, params object[] args)
    {
        return string.Format(System.Globalization.CultureInfo.CurrentUICulture, L(key), args);
    }

    private int LanguageOptionIndex()
    {
        var index = Array.IndexOf(LanguageOptionCodes, preferredLanguage ?? "auto");
        return index < 0 ? 0 : index;
    }

    private string GetArgValue(string option)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (IsOption(args[i], option)) return args[i + 1];
        }
        return null;
    }

    private static string ResolveUserProfileDirectory()
    {
        var value = Environment.GetEnvironmentVariable("USERPROFILE");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("HOME");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.GetFullPath(value);
    }

    private string ResolveDefaultWorkspace()
    {
        var value = GetArgValue("-Workspace");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("WORKSPACE");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("CHATGPT2CODEX_WORKSPACE");
        if (string.IsNullOrWhiteSpace(value))
        {
            value = Path.Combine(ResolveUserProfileDirectory(), "workspace");
        }
        return Path.GetFullPath(value);
    }

    private int ResolvePort()
    {
        var value = GetArgValue("-Port");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("PORT");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("CHATGPT2CODEX_PORT");
        int parsed;
        return int.TryParse(value, out parsed) && parsed > 0 ? parsed : 7979;
    }

    private string ResolveConfiguredPublicHost()
    {
        var value = GetArgValue("-PublicHostname");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("PUBLIC_HOSTNAME");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("CHATGPT2CODEX_PUBLIC_HOSTNAME");
        if (string.IsNullOrWhiteSpace(value)) return null;

        value = value.Trim();
        return value.TrimEnd('/');
    }

    private string ResolveTunnelMode()
    {
        var explicitMode = Environment.GetEnvironmentVariable("CHATGPT2CODEX_TUNNEL_MODE");
        if (!string.IsNullOrWhiteSpace(explicitMode))
        {
            var normalized = explicitMode.Trim().ToLowerInvariant();
            if (normalized == "loopback" || normalized == "cloudflare-quick" ||
                normalized == "cloudflare-named" || normalized == "external") return normalized;
        }
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CHATGPT2CODEX_PUBLIC_URL"))) return "external";
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CLOUDFLARED_TUNNEL_TOKEN")) ||
            !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CLOUDFLARED_TUNNEL_NAME"))) return "cloudflare-named";
        if (!publicTunnelEnabled) return "loopback";
        if (!string.IsNullOrWhiteSpace(configuredPublicHost))
        {
            var value = configuredPublicHost.Trim();
            if (value.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return "external";
            if (Regex.IsMatch(value, @"^[A-Za-z0-9.-]+\.ts\.net$", RegexOptions.IgnoreCase)) return "external";
            return "cloudflare-named";
        }
        return "cloudflare-quick";
    }

    private string ResolveExternalPublicUrl()
    {
        var value = Environment.GetEnvironmentVariable("CHATGPT2CODEX_PUBLIC_URL");
        if (string.IsNullOrWhiteSpace(value)) value = configuredPublicHost;
        if (string.IsNullOrWhiteSpace(value)) return null;
        value = value.Trim();
        if (!value.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) value = "https://" + value;
        Uri uri;
        System.Net.IPAddress address;
        var normalizedHost = "";
        if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps ||
            !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) ||
            (uri.AbsolutePath != "/" && uri.AbsolutePath != "")) return null;
        normalizedHost = uri.Host.TrimEnd('.').Trim('[', ']');
        if (normalizedHost.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
            normalizedHost.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase) ||
            (System.Net.IPAddress.TryParse(normalizedHost, out address) && System.Net.IPAddress.IsLoopback(address))) return null;
        return uri.GetLeftPart(UriPartial.Authority).TrimEnd('/');
    }

    private bool IsTailscaleExternalOrigin()
    {
        var value = ResolveExternalPublicUrl();
        Uri uri;
        return !string.IsNullOrWhiteSpace(value) && Uri.TryCreate(value, UriKind.Absolute, out uri) &&
            uri.Host.EndsWith(".ts.net", StringComparison.OrdinalIgnoreCase);
    }

    private string LoadSelectedProjectPath()
    {
        try
        {
            if (!File.Exists(selectedProjectFile)) return null;
            var value = File.ReadAllText(selectedProjectFile, Encoding.UTF8).Trim();
            if (value.Length == 0) return null;
            value = Path.GetFullPath(value);
            return Directory.Exists(value) ? value : null;
        }
        catch
        {
            return null;
        }
    }

    private static string EncodeSetting(string value)
    {
        if (value == null) value = string.Empty;
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
    }

    private static string DecodeSetting(string value)
    {
        try
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(value ?? string.Empty));
        }
        catch
        {
            return string.Empty;
        }
    }

    private static bool ParseBool(string value)
    {
        return string.Equals(value, "1", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase);
    }

    private void LoadSettings()
    {
        try
        {
            if (!File.Exists(settingsFile)) return;
            foreach (var rawLine in File.ReadAllLines(settingsFile, Encoding.UTF8))
            {
                var index = rawLine.IndexOf('=');
                if (index <= 0) continue;
                var key = rawLine.Substring(0, index);
                var value = DecodeSetting(rawLine.Substring(index + 1));
                int parsedPort;
                if (key == "ProjectFolder" && Directory.Exists(value)) selectedProjectPath = Path.GetFullPath(value);
                else if (key == "Port" && int.TryParse(value, out parsedPort) && parsedPort > 0) port = parsedPort;
                else if (key == "PublicHostname") configuredPublicHost = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
                else if (key == "EnablePublicTunnel") publicTunnelEnabled = ParseBool(value);
                else if (key == "LaunchAtStartup") launchAtStartup = ParseBool(value);
                else if (key == "StartMcpOnOpen") startMcpOnOpen = ParseBool(value);
                else if (key == "AutoCheckUpdates") autoCheckUpdates = ParseBool(value);
                else if (key == "MultiProjectLanesEnabled") multiProjectLanesEnabled = ParseBool(value);
                else if (key == "ControlAllowlist") controlAllowlist = NormalizeControlAllowlist(value.Split(','));
                else if (key == "GitHubRepoUrl" && !string.IsNullOrWhiteSpace(value)) githubRepoUrl = value.Trim();
                else if (key == "Language" && !string.IsNullOrWhiteSpace(value)) preferredLanguage = value.Trim();
                else if (key == "LastConnectorUrl" && !string.IsNullOrWhiteSpace(value)) lastConnectorUrl = value.Trim();
            }
        }
        catch
        {
            // Corrupt settings should not block startup.
        }

        if (new[] { "cloudflare-quick", "cloudflare-named", "external" }.Contains((Environment.GetEnvironmentVariable("CHATGPT2CODEX_TUNNEL_MODE") ?? "").Trim().ToLowerInvariant()) ||
            !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CHATGPT2CODEX_PUBLIC_URL")))
        {
            publicTunnelEnabled = true;
        }
    }

    private void SaveSettings()
    {
        Directory.CreateDirectory(appDataDir);
        var lines = new[]
        {
            "ProjectFolder=" + EncodeSetting(selectedProjectPath ?? string.Empty),
            "Port=" + EncodeSetting(port.ToString()),
            "PublicHostname=" + EncodeSetting(configuredPublicHost ?? string.Empty),
            "EnablePublicTunnel=" + EncodeSetting(publicTunnelEnabled ? "true" : "false"),
            "LaunchAtStartup=" + EncodeSetting(launchAtStartup ? "true" : "false"),
            "StartMcpOnOpen=" + EncodeSetting(startMcpOnOpen ? "true" : "false"),
            "AutoCheckUpdates=" + EncodeSetting(autoCheckUpdates ? "true" : "false"),
            "MultiProjectLanesEnabled=" + EncodeSetting(multiProjectLanesEnabled ? "true" : "false"),
            "ControlAllowlist=" + EncodeSetting(string.Join(",", controlAllowlist ?? new string[0])),
            "GitHubRepoUrl=" + EncodeSetting(githubRepoUrl ?? string.Empty),
            "Language=" + EncodeSetting(preferredLanguage ?? "auto"),
            "LastConnectorUrl=" + EncodeSetting(lastConnectorUrl ?? string.Empty)
        };
        File.WriteAllLines(settingsFile, lines, Encoding.UTF8);
        SaveSelectedProjectPath();
        SetLaunchAtStartup(launchAtStartup);
        SaveSharedSettings();
    }

    private static string[] NormalizeControlAllowlist(IEnumerable<string> values)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        foreach (var raw in values ?? Enumerable.Empty<string>())
        {
            var value = (raw ?? string.Empty).Trim();
            if (value.Length == 0) continue;
            if (value.Length > 120) value = value.Substring(0, 120);
            if (!seen.Add(value)) continue;
            result.Add(value);
            if (result.Count >= 64) break;
        }
        return result.ToArray();
    }

    private DesktopSettings CurrentDesktopSettings()
    {
        return new DesktopSettings
        {
            schemaVersion = 1,
            language = string.IsNullOrWhiteSpace(preferredLanguage) ? "auto" : preferredLanguage,
            projectFolder = selectedProjectPath,
            launchAtStartup = launchAtStartup,
            startMcpOnOpen = startMcpOnOpen,
            autoCheckUpdates = autoCheckUpdates,
            multiProjectLanesEnabled = multiProjectLanesEnabled,
            enablePublicTunnel = publicTunnelEnabled,
            publicHostname = configuredPublicHost,
            port = port,
            controlAllowlist = controlAllowlist ?? new string[0]
        };
    }

    private void SaveSharedSettings()
    {
        try
        {
            var directory = Path.GetDirectoryName(sharedSettingsFile);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var json = new JavaScriptSerializer().Serialize(CurrentDesktopSettings());
            var temporary = sharedSettingsFile + ".tmp-" + Process.GetCurrentProcess().Id;
            File.WriteAllText(temporary, json + Environment.NewLine, new UTF8Encoding(false));
            if (File.Exists(sharedSettingsFile))
            {
                try
                {
                    File.Replace(temporary, sharedSettingsFile, null);
                }
                catch
                {
                    File.Copy(temporary, sharedSettingsFile, true);
                    File.Delete(temporary);
                }
            }
            else
            {
                File.Move(temporary, sharedSettingsFile);
            }
            sharedSettingsLastWriteUtc = File.GetLastWriteTimeUtc(sharedSettingsFile);
        }
        catch
        {
            // Legacy settings remain usable if the shared settings mirror cannot be written.
        }
    }

    private bool LoadSharedSettings(bool promptForRestart)
    {
        try
        {
            if (!File.Exists(sharedSettingsFile)) return false;
            var json = File.ReadAllText(sharedSettingsFile, Encoding.UTF8);
            var settings = new JavaScriptSerializer().Deserialize<DesktopSettings>(json);
            if (settings == null || settings.schemaVersion != 1) return false;

            var previousProject = selectedProjectPath ?? string.Empty;
            var previousHost = configuredPublicHost ?? string.Empty;
            var previousPort = port;
            var previousTunnel = publicTunnelEnabled;
            var previousLanes = multiProjectLanesEnabled;

            if (!string.IsNullOrWhiteSpace(settings.language) &&
                (settings.language == "auto" || LanguageOptionCodes.Contains(settings.language)))
            {
                preferredLanguage = settings.language;
            }
            if (string.IsNullOrWhiteSpace(settings.projectFolder))
            {
                selectedProjectPath = null;
            }
            else
            {
                try
                {
                    var projectPath = Path.GetFullPath(settings.projectFolder.Trim());
                    Directory.CreateDirectory(projectPath);
                    selectedProjectPath = projectPath;
                }
                catch
                {
                    // Keep the previous project if the new path is invalid or inaccessible.
                }
            }
            launchAtStartup = settings.launchAtStartup;
            startMcpOnOpen = settings.startMcpOnOpen;
            autoCheckUpdates = settings.autoCheckUpdates;
            multiProjectLanesEnabled = settings.multiProjectLanesEnabled;
            publicTunnelEnabled = settings.enablePublicTunnel;
            configuredPublicHost = string.IsNullOrWhiteSpace(settings.publicHostname) ? null : settings.publicHostname.Trim();
            if (settings.port > 0 && settings.port <= 65535) port = settings.port;
            controlAllowlist = NormalizeControlAllowlist(settings.controlAllowlist ?? new string[0]);

            var runtimeChanged = previousProject != (selectedProjectPath ?? string.Empty) ||
                previousHost != (configuredPublicHost ?? string.Empty) ||
                previousPort != port ||
                previousTunnel != publicTunnelEnabled ||
                previousLanes != multiProjectLanesEnabled;

            SaveSettings();
            RefreshTrayState();
            if (promptForRestart && runtimeChanged && IsManagedProcessRunning())
            {
                var result = MessageBox.Show(
                    this,
                    "Settings were saved. Restart MCP now to apply project, tunnel, port, and runtime options?",
                    "Restart MCP?",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Information);
                if (result == DialogResult.Yes) RestartServer();
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    private void SeedOrLoadSharedSettings()
    {
        if (File.Exists(sharedSettingsFile))
        {
            LoadSharedSettings(false);
            return;
        }
        SaveSharedSettings();
    }

    private void RefreshSharedSettingsIfChanged()
    {
        try
        {
            if (!File.Exists(sharedSettingsFile)) return;
            var changedAt = File.GetLastWriteTimeUtc(sharedSettingsFile);
            if (changedAt == sharedSettingsLastWriteUtc) return;
            LoadSharedSettings(true);
        }
        catch
        {
            // Polling must never destabilize the tray app.
        }
    }

    private void SaveSelectedProjectPath()
    {
        Directory.CreateDirectory(appDataDir);
        File.WriteAllText(selectedProjectFile, selectedProjectPath ?? string.Empty, Encoding.UTF8);
    }

    private string ProjectDisplayName()
    {
        if (string.IsNullOrEmpty(selectedProjectPath)) return "Default workspace";
        return new DirectoryInfo(selectedProjectPath).Name;
    }

    private bool IsManagedProcessRunning()
    {
        try
        {
            return process != null && !process.HasExited && !stopping;
        }
        catch
        {
            return false;
        }
    }

    private string[] BuildLauncherArgs()
    {
        var values = new List<string>();
        for (var i = 0; i < args.Length; i++)
        {
            if (IsOption(args[i], "-Workspace") || IsOption(args[i], "-Port") || IsOption(args[i], "-PublicHostname") ||
                IsOption(args[i], "-PublicUrl") || IsOption(args[i], "-TunnelMode"))
            {
                i++;
                continue;
            }
            if (IsOption(args[i], "-NoTunnel") || IsOption(args[i], "-ExposeWeb") || IsOption(args[i], "-RotateOwnerToken"))
            {
                continue;
            }
            values.Add(args[i]);
        }

        values.Add("-Port");
        values.Add(port.ToString());

        var workspace = string.IsNullOrEmpty(selectedProjectPath) ? defaultWorkspace : selectedProjectPath;
        if (!string.IsNullOrWhiteSpace(workspace))
        {
            values.Add("-Workspace");
            values.Add(workspace);
        }

        var tunnelMode = ResolveTunnelMode();
        values.Add("-TunnelMode");
        values.Add(tunnelMode);
        if (tunnelMode != "loopback")
        {
            values.Add("-ExposeWeb");
            if (tunnelMode == "external")
            {
                var externalUrl = ResolveExternalPublicUrl();
                if (!string.IsNullOrWhiteSpace(externalUrl))
                {
                    values.Add("-PublicUrl");
                    values.Add(externalUrl);
                }
            }
            else if (tunnelMode == "cloudflare-named" && !string.IsNullOrWhiteSpace(configuredPublicHost))
            {
                values.Add("-PublicHostname");
                values.Add(configuredPublicHost);
            }
        }
        return values.ToArray();
    }

    private string ConnectorUrl()
    {
        if (!string.IsNullOrEmpty(mcpUrl)) return mcpUrl;
        var tunnelMode = ResolveTunnelMode();
        return tunnelMode == "loopback" ? "http://127.0.0.1:" + port + "/mcp" : null;
    }

    private string ConfiguredPublicConnectorUrl()
    {
        if (!string.IsNullOrEmpty(mcpUrl)) return mcpUrl;
        var tunnelMode = ResolveTunnelMode();
        if (tunnelMode == "external")
        {
            var externalUrl = ResolveExternalPublicUrl();
            return string.IsNullOrEmpty(externalUrl) ? null : externalUrl + "/mcp";
        }
        if (tunnelMode == "cloudflare-named" && !string.IsNullOrEmpty(configuredPublicHost))
        {
            return "https://" + configuredPublicHost + "/mcp";
        }
        return null;
    }

    private static bool IsTemporaryTunnelUrl(string url)
    {
        Uri parsed;
        return Uri.TryCreate(url, UriKind.Absolute, out parsed) &&
            parsed.Host.EndsWith(".trycloudflare.com", StringComparison.OrdinalIgnoreCase);
    }

    private string PublicHealthUrl()
    {
        var connector = ConnectorUrl() ?? ConfiguredPublicConnectorUrl();
        if (string.IsNullOrEmpty(connector)) return null;
        return Regex.Replace(connector, @"/mcp/?$", "/healthz", RegexOptions.IgnoreCase);
    }

    private string LocalHealthUrl()
    {
        return "http://127.0.0.1:" + port + "/healthz";
    }

    private void OpenUrl(string url)
    {
        if (string.IsNullOrEmpty(url)) return;
        Process.Start(new ProcessStartInfo
        {
            FileName = url,
            UseShellExecute = true
        });
    }

    private string UnifiedDashboardUrl(string view)
    {
        var url = "http://127.0.0.1:7980/activity/?embedded=windows";
        if (!string.IsNullOrWhiteSpace(view)) url += "&view=" + Uri.EscapeDataString(view);
        return url;
    }

    private void OpenUnifiedDashboard(string view)
    {
        var url = UnifiedDashboardUrl(view);
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe")
        };
        foreach (var candidate in candidates)
        {
            if (!File.Exists(candidate)) continue;
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = candidate,
                    Arguments = "--app=" + Quote(url) + " --window-size=920,640",
                    UseShellExecute = false
                });
                DashboardWindowBranding.ApplyAsync();
                return;
            }
            catch
            {
                // Fall through to the system browser.
            }
        }
        OpenUrl(url);
    }

    private void OpenSettingsExperience()
    {
        if (IsManagedProcessRunning())
        {
            OpenUnifiedDashboard("settings");
            return;
        }
        ShowSettings();
    }

    private void OpenLocalHealth()
    {
        OpenUrl(LocalHealthUrl());
    }

    private void OpenPublicHealth()
    {
        OpenUrl(PublicHealthUrl());
    }

    private void ShowLogs()
    {
        Process.Start("explorer.exe", "/select,\"" + logFile + "\"");
    }

    private void ShowConnectionDiagnostics()
    {
        if (!File.Exists(connectionDiagnosticsFile))
        {
            MessageBox.Show(
                this,
                "No connection events have been recorded yet.\r\n\r\n" + connectionDiagnosticsFile,
                L("connectionDiagnosticsMenu").TrimEnd('.'),
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }
        Process.Start(new ProcessStartInfo
        {
            FileName = "notepad.exe",
            Arguments = "\"" + connectionDiagnosticsFile + "\"",
            UseShellExecute = true
        });
    }

    private void OpenGithub()
    {
        OpenUrl(githubRepoUrl);
    }

    private void CheckUpdates(bool manual)
    {
        try
        {
            var repo = (githubRepoUrl ?? string.Empty).TrimEnd('/');
            var match = Regex.Match(repo, @"github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+)", RegexOptions.IgnoreCase);
            if (!match.Success)
            {
                if (manual) OpenUrl(repo);
                return;
            }

            var api = "https://api.github.com/repos/" + match.Groups["owner"].Value + "/" + match.Groups["repo"].Value + "/releases/latest";
            using (var client = new WebClient())
            {
                client.Headers.Add("User-Agent", "chatgpt2codex");
                var json = client.DownloadString(api);
                var tagMatch = Regex.Match(json, @"""tag_name""\s*:\s*""(?<tag>[^""]+)""");
                var latest = tagMatch.Success ? tagMatch.Groups["tag"].Value.TrimStart('v', 'V') : "latest";
                var installed = "unknown";
                var packageJson = Path.Combine(root, "package.json");
                if (File.Exists(packageJson))
                {
                    var packageText = File.ReadAllText(packageJson, Encoding.UTF8);
                    var versionMatch = Regex.Match(packageText, @"""version""\s*:\s*""(?<version>[^""]+)""");
                    if (versionMatch.Success) installed = versionMatch.Groups["version"].Value;
                }

                var message = latest == installed
                    ? "ChatGPT To Codex is up to date (" + installed + ")."
                    : "Update available: " + latest + ". Installed: " + installed + ".";
                if (manual) MessageBox.Show(this, message, "ChatGPT To Codex", MessageBoxButtons.OK, MessageBoxIcon.Information);
                else statusLabel.Text = message;
            }
        }
        catch
        {
            if (manual && MessageBox.Show(this, "Could not check releases automatically. Open releases page?", "ChatGPT To Codex", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
            {
                OpenUrl((githubRepoUrl ?? string.Empty).TrimEnd('/') + "/releases");
            }
        }
    }

    private void SetLaunchAtStartup(bool enabled)
    {
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
            {
                if (key == null) return;
                if (enabled)
                {
                    key.SetValue("ChatGPT To Codex", "\"" + Application.ExecutablePath + "\"");
                }
                else
                {
                    key.DeleteValue("ChatGPT To Codex", false);
                }
            }
        }
        catch
        {
            // Startup registration is best-effort.
        }
    }

    private bool HasProjectMarker(string path)
    {
        var markers = new[] { ".git", "package.json", "pubspec.yaml", "go.mod", "Cargo.toml", "requirements.txt", ".chatgpt2codex" };
        return markers.Any(marker => Directory.Exists(Path.Combine(path, marker)) || File.Exists(Path.Combine(path, marker)));
    }

    private void SelectProjectFolder()
    {
        using (var dialog = new FolderBrowserDialog())
        {
            dialog.Description = "Select Project Folder";
            dialog.ShowNewFolderButton = true;
            var initial = selectedProjectPath ?? defaultWorkspace;
            if (Directory.Exists(initial)) dialog.SelectedPath = initial;

            ShowFromTray();
            if (dialog.ShowDialog(this) != DialogResult.OK) return;

            var path = Path.GetFullPath(dialog.SelectedPath);
            Directory.CreateDirectory(path);

            var shouldRestart = IsManagedProcessRunning();
            selectedProjectPath = path;
            SaveSelectedProjectPath();
            AppendLog("[chatgpt2codex] Selected project folder: " + selectedProjectPath);
            RefreshTrayState();

            if (shouldRestart)
            {
                RestartServer();
            }
        }
    }

    private static Label NewLabel(string text, int x, int y, int width)
    {
        var label = new Label();
        label.Text = text;
        label.SetBounds(x, y, width, 22);
        return label;
    }

    private static Button NewButton(string text, int x, int y, int width)
    {
        var button = new Button();
        button.Text = text;
        button.SetBounds(x, y, width, 30);
        return button;
    }

    private void ShowSettings()
    {
        using (var form = new Form())
        {
            form.Text = L("settingsTitle");
            form.Width = 640;
            form.Height = 670;
            form.StartPosition = FormStartPosition.CenterParent;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;

            var title = NewLabel(L("settingsTitle"), 24, 18, 500);
            title.Font = new System.Drawing.Font(title.Font.FontFamily, 14, System.Drawing.FontStyle.Bold);
            title.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
            form.Controls.Add(title);

            form.Controls.Add(NewLabel(L("language"), 24, 62, 150));
            var languageBox = new ComboBox();
            languageBox.DropDownStyle = ComboBoxStyle.DropDownList;
            languageBox.Items.AddRange(LanguageOptionNames.Cast<object>().ToArray());
            languageBox.SetBounds(180, 58, 230, 28);
            languageBox.SelectedIndex = LanguageOptionIndex();
            form.Controls.Add(languageBox);

            form.Controls.Add(NewLabel(L("projectFolder"), 24, 102, 150));
            var projectBox = new TextBox();
            projectBox.Text = selectedProjectPath ?? string.Empty;
            projectBox.ReadOnly = true;
            projectBox.SetBounds(180, 98, 250, 24);
            form.Controls.Add(projectBox);
            var browseButton = NewButton(L("browse"), 440, 96, 82);
            browseButton.Click += delegate
            {
                using (var dialog = new FolderBrowserDialog())
                {
                    dialog.Description = L("projectFolder");
                    dialog.ShowNewFolderButton = true;
                    var initial = projectBox.Text.Length > 0 ? projectBox.Text : defaultWorkspace;
                    if (Directory.Exists(initial)) dialog.SelectedPath = initial;
                    if (dialog.ShowDialog(form) == DialogResult.OK)
                    {
                        var path = Path.GetFullPath(dialog.SelectedPath);
                        Directory.CreateDirectory(path);
                        projectBox.Text = path;
                    }
                }
            };
            form.Controls.Add(browseButton);

            var launchCheck = new CheckBox();
            launchCheck.Text = L("launchWindowsSetting");
            launchCheck.Checked = launchAtStartup;
            launchCheck.SetBounds(180, 138, 320, 24);
            form.Controls.Add(launchCheck);

            var startCheck = new CheckBox();
            startCheck.Text = L("startOnOpenSetting");
            startCheck.Checked = startMcpOnOpen;
            startCheck.SetBounds(180, 166, 320, 24);
            form.Controls.Add(startCheck);

            var updatesCheck = new CheckBox();
            updatesCheck.Text = L("autoUpdatesSetting");
            updatesCheck.Checked = autoCheckUpdates;
            updatesCheck.SetBounds(180, 194, 320, 24);
            form.Controls.Add(updatesCheck);

            var tunnelCheck = new CheckBox();
            tunnelCheck.Text = L("publicTunnelSetting");
            tunnelCheck.Checked = publicTunnelEnabled;
            tunnelCheck.SetBounds(180, 222, 390, 24);
            form.Controls.Add(tunnelCheck);

            form.Controls.Add(NewLabel(preferredLanguage == "ko" ? "공개 호스트 / 외부 HTTPS URL" : "Public host / external HTTPS URL", 24, 262, 150));
            var hostBox = new TextBox();
            hostBox.Text = configuredPublicHost ?? string.Empty;
            hostBox.SetBounds(180, 258, 342, 24);
            form.Controls.Add(hostBox);

            var hostHintText = preferredLanguage == "ko"
                ? "비워두면 Cloudflare Quick Tunnel. 호스트명은 기존 Cloudflare named tunnel token/name이 함께 설정된 경우에만 고정 주소로 사용됩니다. https:// URL은 외부 관리 터널이며 앱이 시작/종료하지 않습니다."
                : "Blank = Cloudflare Quick Tunnel. A hostname is fixed only with an existing Cloudflare named-tunnel token/name. https:// URL = externally managed; this app does not start/stop it.";
            var hostHint = NewLabel(hostHintText, 180, 288, 342);
            hostHint.SetBounds(180, 286, 342, 42);
            hostHint.ForeColor = System.Drawing.SystemColors.GrayText;
            form.Controls.Add(hostHint);

            form.Controls.Add(NewLabel(L("localPort"), 24, 342, 150));
            var portBox = new NumericUpDown();
            portBox.Minimum = 1;
            portBox.Maximum = 65535;
            portBox.Value = Math.Min(65535, Math.Max(1, port));
            portBox.SetBounds(180, 338, 120, 24);
            form.Controls.Add(portBox);

            form.Controls.Add(NewLabel(L("githubRepositoryURL"), 24, 382, 150));
            var repoBox = new TextBox();
            repoBox.Text = githubRepoUrl ?? string.Empty;
            repoBox.SetBounds(180, 378, 342, 24);
            form.Controls.Add(repoBox);

            var copyConnector = NewButton(L("copyConnector"), 24, 426, 156);
            copyConnector.Click += delegate { CopyMcpUrl(); };
            form.Controls.Add(copyConnector);

            var copyOwner = NewButton(L("copyOwnerToken"), 194, 426, 156);
            copyOwner.Enabled = !string.IsNullOrEmpty(ownerToken);
            copyOwner.Click += delegate { CopyOwnerToken(); };
            form.Controls.Add(copyOwner);

            var generateOwner = NewButton(L("autoGenerateToken"), 364, 426, 158);
            generateOwner.Click += delegate { AutoGenerateOwnerToken(); };
            form.Controls.Add(generateOwner);

            var localHealth = NewButton(L("openLocalHealth"), 24, 464, 156);
            localHealth.Click += delegate { OpenLocalHealth(); };
            form.Controls.Add(localHealth);

            var publicHealth = NewButton(L("openPublicHealth"), 194, 464, 156);
            publicHealth.Click += delegate { OpenPublicHealth(); };
            form.Controls.Add(publicHealth);

            var logs = NewButton(L("showLogs"), 364, 464, 158);
            logs.Click += delegate { ShowLogs(); };
            form.Controls.Add(logs);

            var github = NewButton(L("openGithub"), 24, 502, 156);
            github.Click += delegate { OpenGithub(); };
            form.Controls.Add(github);

            var checkUpdates = NewButton(L("checkUpdates"), 194, 502, 156);
            checkUpdates.Click += delegate { CheckUpdates(true); };
            form.Controls.Add(checkUpdates);

            var about = NewButton(L("about"), 364, 502, 158);
            about.Click += delegate
            {
                MessageBox.Show(form, "ChatGPT To Codex by ezBuilder\r\nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };
            form.Controls.Add(about);

            var copyright = NewLabel("Copyright 2026 ezBuilder. All rights reserved.", 24, 560, 300);
            form.Controls.Add(copyright);

            var cancel = NewButton(L("cancel"), 356, 554, 78);
            cancel.DialogResult = DialogResult.Cancel;
            form.Controls.Add(cancel);

            var save = NewButton(L("save"), 444, 554, 78);
            save.DialogResult = DialogResult.OK;
            form.AcceptButton = save;
            form.CancelButton = cancel;
            form.Controls.Add(save);

            ShowFromTray();
            if (form.ShowDialog(this) != DialogResult.OK) return;

            var wasRunning = IsManagedProcessRunning();
            selectedProjectPath = string.IsNullOrWhiteSpace(projectBox.Text) ? null : Path.GetFullPath(projectBox.Text);
            launchAtStartup = launchCheck.Checked;
            startMcpOnOpen = startCheck.Checked;
            autoCheckUpdates = updatesCheck.Checked;
            publicTunnelEnabled = tunnelCheck.Checked;
            configuredPublicHost = string.IsNullOrWhiteSpace(hostBox.Text) ? null : hostBox.Text.Trim();
            port = (int)portBox.Value;
            githubRepoUrl = string.IsNullOrWhiteSpace(repoBox.Text) ? "https://github.com/ezBuilder/chatgpt2codex" : repoBox.Text.Trim();
            preferredLanguage = LanguageOptionCodes[Math.Max(0, languageBox.SelectedIndex)];
            SaveSettings();
            RefreshTrayState();
            if (wasRunning) RestartServer();
        }
    }

    private string LocalControlTokenPath()
    {
        return Path.Combine(
            ResolveUserProfileDirectory(),
            ".local",
            "share",
            "chatgpt2codex",
            "local-control-token");
    }

    private string ReadLocalControlToken()
    {
        try
        {
            var path = LocalControlTokenPath();
            return File.Exists(path) ? File.ReadAllText(path, Encoding.UTF8).Trim() : null;
        }
        catch
        {
            return null;
        }
    }

    private string SendLocalControlRequest(string path, string method)
    {
        var token = ReadLocalControlToken();
        if (string.IsNullOrWhiteSpace(token)) return null;
        var request = (HttpWebRequest)WebRequest.Create(
            "http://127.0.0.1:" + port + "/local-control/v1" + path);
        request.Method = method;
        request.Timeout = 1500;
        request.ReadWriteTimeout = 1500;
        request.Proxy = null;
        request.Headers[HttpRequestHeader.Authorization] = "Bearer " + token;
        if (string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase))
        {
            request.ContentLength = 0;
        }
        using (var response = (HttpWebResponse)request.GetResponse())
        using (var stream = response.GetResponseStream())
        using (var reader = new StreamReader(stream, Encoding.UTF8))
        {
            return reader.ReadToEnd();
        }
    }

    private void RequestLocalControlRefresh()
    {
        if (exitRequested || controlStatusRefreshInFlight) return;
        if (!IsManagedProcessRunning())
        {
            latestControlSnapshot = null;
            ApplyLocalControlSnapshot();
            return;
        }

        controlStatusRefreshInFlight = true;
        System.Threading.ThreadPool.QueueUserWorkItem(delegate
        {
            LocalControlSnapshot snapshot = null;
            try
            {
                var json = SendLocalControlRequest("/status", "GET");
                if (!string.IsNullOrWhiteSpace(json))
                {
                    snapshot = new JavaScriptSerializer().Deserialize<LocalControlSnapshot>(json);
                }
            }
            catch
            {
                snapshot = null;
            }

            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke((Action)delegate
                {
                    controlStatusRefreshInFlight = false;
                    latestControlSnapshot = snapshot;
                    ApplyLocalControlSnapshot();
                });
            }
            catch (InvalidOperationException)
            {
                controlStatusRefreshInFlight = false;
            }
        });
    }

    private void PerformLocalControl(string path)
    {
        if (exitRequested) return;
        System.Threading.ThreadPool.QueueUserWorkItem(delegate
        {
            var ok = false;
            try
            {
                ok = SendLocalControlRequest(path, "POST") != null;
            }
            catch
            {
                ok = false;
            }
            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke((Action)delegate
                {
                    if (!ok) statusLabel.Text = L("localStatusUnavailable");
                    RequestLocalControlRefresh();
                });
            }
            catch (InvalidOperationException)
            {
                // The form is already closing.
            }
        });
    }

    private void ResolveOAuthApproval(LocalPendingOAuthApproval request, string decision)
    {
        if (request == null || string.IsNullOrWhiteSpace(request.requestId)) return;
        PerformLocalControl(
            "/oauth-approvals/" + Uri.EscapeDataString(request.requestId) + "/" + decision);
    }

    private void PresentOAuthApproval(LocalPendingOAuthApproval request)
    {
        if (request == null || string.IsNullOrWhiteSpace(request.requestId)) return;
        if (!string.Equals(request.status, "pending", StringComparison.OrdinalIgnoreCase)) return;

        var scopeText = request.scopes != null && request.scopes.Length > 0
            ? string.Join(", ", request.scopes)
            : "chatgpt2codex";
        var answer = MessageBox.Show(
            LFormat(
                "oauthApprovalPrompt",
                string.IsNullOrWhiteSpace(request.clientName) ? "ChatGPT" : request.clientName,
                scopeText,
                string.IsNullOrWhiteSpace(request.resource) ? "C2CT" : request.resource,
                string.IsNullOrWhiteSpace(request.redirectHost) ? "chatgpt.com" : request.redirectHost),
            L("oauthApprovalTitle"),
            MessageBoxButtons.YesNoCancel,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button1);
        if (answer == DialogResult.Yes) ResolveOAuthApproval(request, "approve");
        else if (answer == DialogResult.No) ResolveOAuthApproval(request, "reject");
    }

    private void ApplyOAuthApprovals(LocalControlSnapshot snapshot)
    {
        var approvals = snapshot != null && snapshot.oauthApprovals != null && snapshot.oauthApprovals.pendingRequests != null
            ? snapshot.oauthApprovals.pendingRequests
            : new LocalPendingOAuthApproval[0];
        var pending = approvals
            .Where(request => request != null && string.Equals(request.status, "pending", StringComparison.OrdinalIgnoreCase))
            .ToArray();

        oauthApprovalsTrayItem.Text = L("pendingOAuthApprovalsMenu") + " (" + pending.Length + ")";
        oauthApprovalsTrayItem.DropDownItems.Clear();
        if (pending.Length == 0)
        {
            oauthApprovalsTrayItem.DropDownItems.Add(new ToolStripMenuItem(L("oauthNoPendingApprovals")) { Enabled = false });
            return;
        }

        foreach (var request in pending)
        {
            var scopeText = request.scopes != null && request.scopes.Length > 0
                ? string.Join(", ", request.scopes)
                : "chatgpt2codex";
            var summary = (string.IsNullOrWhiteSpace(request.clientName) ? "ChatGPT" : request.clientName) +
                " · " + scopeText;
            var requestItem = new ToolStripMenuItem(summary);
            var captured = request;
            requestItem.DropDownItems.Add(new ToolStripMenuItem(
                L("controlApprove"),
                null,
                delegate { ResolveOAuthApproval(captured, "approve"); }));
            requestItem.DropDownItems.Add(new ToolStripMenuItem(
                L("controlReject"),
                null,
                delegate { ResolveOAuthApproval(captured, "reject"); }));
            requestItem.DropDownItems.Add(new ToolStripMenuItem(
                L("oauthApprovalTitle"),
                null,
                delegate { PresentOAuthApproval(captured); }));
            oauthApprovalsTrayItem.DropDownItems.Add(requestItem);
        }

        if (oauthApprovalDialogOpen) return;
        var firstUnseen = pending.FirstOrDefault(request => !presentedOAuthApprovalIds.Contains(request.requestId));
        if (firstUnseen == null) return;
        presentedOAuthApprovalIds.Add(firstUnseen.requestId);
        oauthApprovalDialogOpen = true;
        try
        {
            PresentOAuthApproval(firstUnseen);
        }
        finally
        {
            oauthApprovalDialogOpen = false;
        }
    }

    private void ToggleAgentArm()
    {
        var control = latestControlSnapshot == null ? null : latestControlSnapshot.control;
        if (control == null || !control.platformSupported) return;
        PerformLocalControl(control.armed ? "/control/disarm" : "/control/arm");
    }

    private void ToggleAutoApprove()
    {
        var control = latestControlSnapshot == null ? null : latestControlSnapshot.control;
        if (control == null || !control.platformSupported) return;
        PerformLocalControl(control.autoEnabled ? "/control/auto/off" : "/control/auto/on");
    }

    private void KillControl()
    {
        var control = latestControlSnapshot == null ? null : latestControlSnapshot.control;
        if (control == null || !control.platformSupported) return;
        var answer = MessageBox.Show(
            this,
            L("killControlConfirmInfo"),
            L("killControlConfirmTitle"),
            MessageBoxButtons.OKCancel,
            MessageBoxIcon.Warning);
        if (answer == DialogResult.OK) PerformLocalControl("/control/kill");
    }

    private void ApplyLocalControlSnapshot()
    {
        var snapshot = latestControlSnapshot;
        ApplyOAuthApprovals(snapshot);
        if (snapshot != null && IsManagedProcessRunning() && !unifiedDashboardShown && Visible)
        {
            unifiedDashboardShown = true;
            BeginInvoke((MethodInvoker)delegate
            {
                OpenUnifiedDashboard(null);
                HideToTray();
            });
        }
        var sessions = snapshot != null && snapshot.sessions != null
            ? snapshot.sessions
            : new LocalControlSession[0];
        sessionsTrayItem.Text = L("activeSessionsMenu") + " (" + sessions.Length + ")";
        sessionsTrayItem.DropDownItems.Clear();
        if (sessions.Length == 0)
        {
            sessionsTrayItem.DropDownItems.Add(new ToolStripMenuItem(L("sessionNoActive")) { Enabled = false });
        }
        else
        {
            foreach (var session in sessions)
            {
                var identity = string.IsNullOrWhiteSpace(session.clientName)
                    ? session.sessionLabel
                    : session.clientName + " · " + session.sessionLabel;
                var sessionItem = new ToolStripMenuItem(identity) { Enabled = false };
                sessionsTrayItem.DropDownItems.Add(sessionItem);
                var operation = session.operation;
                var detail = operation == null
                    ? session.state
                    : operation.tool + " · " + operation.state +
                        (operation.elapsedMs > 0 ? " · " + Math.Max(1, operation.elapsedMs / 1000) + "s" : "");
                sessionsTrayItem.DropDownItems.Add(new ToolStripMenuItem("  " + detail) { Enabled = false });
                sessionsTrayItem.DropDownItems.Add(new ToolStripSeparator());
            }
        }

        var control = snapshot == null ? null : snapshot.control;
        if (control == null)
        {
            armTrayItem.Text = IsManagedProcessRunning() ? L("localStatusUnavailable") : L("agentArmOffMenu");
            armTrayItem.Checked = false;
            armTrayItem.Enabled = false;
            killTrayItem.Enabled = false;
            pendingTrayItem.Text = L("pendingControlActionsMenu");
            pendingTrayItem.DropDownItems.Clear();
            pendingTrayItem.DropDownItems.Add(new ToolStripMenuItem(L("controlNoPendingActions")) { Enabled = false });
            return;
        }

        armTrayItem.Text = control.platformSupported
            ? L(control.armed ? "agentArmOnMenu" : "agentArmOffMenu")
            : L("agentArmUnavailableWindows");
        armTrayItem.Checked = control.platformSupported && control.armed;
        armTrayItem.Enabled = control.platformSupported && IsManagedProcessRunning();
        killTrayItem.Enabled = control.platformSupported && IsManagedProcessRunning();

        var pending = control.pendingActions ?? new LocalPendingControlAction[0];
        pendingTrayItem.Text = L("pendingControlActionsMenu") + " (" + pending.Length + ")";
        pendingTrayItem.DropDownItems.Clear();
        if (control.platformSupported)
        {
            var minutesLeft = Math.Max(1, control.autoRemainingMs / 60000);
            var autoItem = new ToolStripMenuItem(
                control.autoEnabled
                    ? LFormat("autoApproveStatusMenu", minutesLeft) + " — " + L("autoApproveOffMenu")
                    : L("autoApproveOnMenu"),
                null,
                delegate { ToggleAutoApprove(); });
            autoItem.Enabled = control.autoEnabled || control.allowlistedAppCount > 0;
            if (!autoItem.Enabled) autoItem.ToolTipText = L("autoApproveUnavailableMenu");
            pendingTrayItem.DropDownItems.Add(autoItem);
            pendingTrayItem.DropDownItems.Add(new ToolStripSeparator());
        }
        if (pending.Length == 0)
        {
            pendingTrayItem.DropDownItems.Add(new ToolStripMenuItem(L("controlNoPendingActions")) { Enabled = false });
            return;
        }
        if (control.platformSupported)
        {
            pendingTrayItem.DropDownItems.Add(new ToolStripMenuItem(
                L("approveAllControlMenu"),
                null,
                delegate { PerformLocalControl("/control/actions/approve-all"); }));
            pendingTrayItem.DropDownItems.Add(new ToolStripSeparator());
        }
        foreach (var action in pending)
        {
            var summary = string.Join(
                " · ",
                new[] { action.appName, action.kind }.Where(value => !string.IsNullOrWhiteSpace(value)).ToArray());
            var actionItem = new ToolStripMenuItem(summary);
            if (control.platformSupported)
            {
                var actionId = action.actionId;
                actionItem.DropDownItems.Add(new ToolStripMenuItem(
                    L("controlApprove"),
                    null,
                    delegate { PerformLocalControl("/control/actions/" + Uri.EscapeDataString(actionId) + "/approve"); }));
                actionItem.DropDownItems.Add(new ToolStripMenuItem(
                    L("controlReject"),
                    null,
                    delegate { PerformLocalControl("/control/actions/" + Uri.EscapeDataString(actionId) + "/reject"); }));
            }
            else
            {
                actionItem.Enabled = false;
            }
            pendingTrayItem.DropDownItems.Add(actionItem);
        }
    }

    private void RefreshTrayState()
    {
        var running = IsManagedProcessRunning();
        statusTrayItem.Text = "ChatGPT To Codex: " + (running ? L("statusOn") : L("statusOff"));
        var projectPath = string.IsNullOrWhiteSpace(selectedProjectPath) ? defaultWorkspace : selectedProjectPath;
        projectTrayItem.Text = L("projectPrefix") + ": " +
            (string.IsNullOrWhiteSpace(projectPath) ? "-" : new DirectoryInfo(projectPath).Name);
        portTrayItem.Text = L("portPrefix") + ": " + port;
        toggleTrayItem.Text = running ? L("stopMCP") : L("startMCP");
        stopButton.Text = running ? L("stopMCP") : L("startMCP");
        stopButton.Enabled = true;
        restartTrayItem.Enabled = true;
        restartTrayItem.Text = L("restartMCP");
        var connector = ConnectorUrl();
        if (!string.IsNullOrEmpty(connector) && (string.IsNullOrEmpty(urlBox.Text) || urlBox.Text == "Connector URL will appear here"))
        {
            urlBox.Text = connector;
        }
        else if (string.IsNullOrEmpty(connector) && publicTunnelEnabled && running)
        {
            urlBox.Text = "Waiting for Cloudflare connector URL...";
        }
        copyButton.Enabled = !string.IsNullOrEmpty(connector);
        copyButton.Text = L("copyConnector");
        copyOwnerTokenButton.Text = L("copyOwnerToken");
        copyOwnerTokenButton.Enabled = !string.IsNullOrEmpty(ownerToken);
        autoGenerateOwnerTokenButton.Text = L("autoGenerateToken");
        autoGenerateOwnerTokenButton.Enabled = !exitRequested && !autoGenerateOwnerTokenOnNextStart;
        openLogButton.Text = L("showLogs");
        connectionDiagnosticsTrayItem.Text = L("connectionDiagnosticsMenu");
        activityTrayItem.Text = ResolveLanguageCode(preferredLanguage) == "ko" ? "ChatGPT To Codex 열기" : "Open ChatGPT To Codex";
        settingsTrayItem.Text = L("settingsMenu");
        quitTrayItem.Text = L("quit");
        if (!running)
        {
            latestControlSnapshot = null;
            ApplyLocalControlSnapshot();
        }
    }

    private void ToggleServer()
    {
        if (IsManagedProcessRunning())
        {
            StopProcessTree();
            RefreshTrayState();
            return;
        }

        stopping = false;
        StartLauncher();
    }

    private void RestartServer()
    {
        if (exitRequested) return;
        AppendLog("[chatgpt2codex] Restarting MCP runtime...");
        StopProcessTree();

        var timer = new Timer();
        timer.Interval = 1200;
        timer.Tick += delegate
        {
            timer.Stop();
            timer.Dispose();
            stopping = false;
            StartLauncher();
        };
        timer.Start();
    }

    private static void PruneLauncherLogs(string directory)
    {
        try
        {
            var dir = new DirectoryInfo(directory);
            if (!dir.Exists) return;

            var cutoff = DateTime.UtcNow.AddDays(-MaxLauncherLogAgeDays);
            foreach (var file in dir.GetFiles("launcher-*.log"))
            {
                if (file.LastWriteTimeUtc < cutoff)
                {
                    TryDelete(file);
                }
            }

            var remaining = dir.GetFiles("launcher-*.log")
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .ToArray();

            for (var i = MaxLauncherLogFiles; i < remaining.Length; i++)
            {
                TryDelete(remaining[i]);
            }

            long total = 0;
            foreach (var file in dir.GetFiles("launcher-*.log").OrderByDescending(file => file.LastWriteTimeUtc))
            {
                total += file.Length;
                if (total > MaxLauncherLogTotalBytes)
                {
                    TryDelete(file);
                }
            }
        }
        catch
        {
            // Log cleanup is best-effort; startup must never fail because of it.
        }
    }

    private static void TryDelete(FileInfo file)
    {
        try
        {
            file.Delete();
        }
        catch
        {
            // Another process may still be reading the log.
        }
    }

    private void TrimCurrentLogIfNeeded()
    {
        try
        {
            var file = new FileInfo(logFile);
            if (!file.Exists || file.Length <= MaxLauncherLogFileBytes) return;

            var lines = File.ReadAllLines(logFile, Encoding.UTF8);
            var keep = Math.Min(lines.Length, MaxLauncherLogLinesAfterTrim);
            var trimmed = new string[keep + 1];
            trimmed[0] = "[chatgpt2codex] Older log output trimmed to keep this file bounded.";
            Array.Copy(lines, lines.Length - keep, trimmed, 1, keep);
            File.WriteAllLines(logFile, trimmed, Encoding.UTF8);
        }
        catch
        {
            // Keep the launcher running even if log trimming fails.
        }
    }

    private void TrimVisibleLogIfNeeded()
    {
        if (logBox.TextLength <= MaxVisibleLogCharacters) return;

        var text = logBox.Text;
        var keep = MaxVisibleLogCharacters / 2;
        var start = Math.Max(0, text.Length - keep);
        logBox.Text = "[older on-screen log output trimmed]" + Environment.NewLine + text.Substring(start);
        logBox.SelectionStart = logBox.TextLength;
        logBox.ScrollToCaret();
    }

    private void CopyMcpUrl()
    {
        var connector = ConnectorUrl();
        if (string.IsNullOrEmpty(connector)) return;

        if (CopyTextToClipboard(connector, L("connectorUrlLabel"), urlBox) && IsTemporaryTunnelUrl(connector))
        {
            statusLabel.Text = L("temporaryTunnelCopied");
        }
    }

    private void CopyOwnerToken()
    {
        if (string.IsNullOrEmpty(ownerToken))
        {
            statusLabel.Text = L("ownerTokenNotReady");
            return;
        }

        CopyTextToClipboard(ownerToken, L("ownerTokenLabel"), ownerTokenBox);
    }

    private bool CopyTextToClipboard(string value, string label, TextBox fallbackBox)
    {
        Exception lastError;
        if (TrySetClipboardText(value, out lastError))
        {
            statusLabel.Text = LFormat("copiedItem", label);
            AppendLog("[chatgpt2codex] Copied " + label + " to clipboard.");
            return true;
        }

        ShowFromTray();
        statusLabel.Text = LFormat("copyFailedManual", label);
        fallbackBox.UseSystemPasswordChar = false;
        fallbackBox.Text = value;
        fallbackBox.Focus();
        fallbackBox.SelectAll();
        AppendLog("[chatgpt2codex] Clipboard copy failed for " + label + ". Select the field manually: " + lastError.Message);
        return false;
    }

    private static bool TrySetClipboardText(string value, out Exception lastError)
    {
        lastError = null;
        for (var attempt = 0; attempt < 6; attempt++)
        {
            try
            {
                Clipboard.Clear();
                Clipboard.SetText(value, TextDataFormat.UnicodeText);
                return true;
            }
            catch (Exception ex)
            {
                lastError = ex;
                Application.DoEvents();
                System.Threading.Thread.Sleep(80 + attempt * 70);
            }
        }

        try
        {
            Clipboard.SetDataObject(value, true, 10, 150);
            return true;
        }
        catch (Exception ex)
        {
            lastError = ex;
            return false;
        }
    }

    private void AutoGenerateOwnerToken()
    {
        if (exitRequested) return;

        ownerToken = null;
        ownerTokenBox.UseSystemPasswordChar = false;
        ownerTokenBox.Text = L("ownerTokenGenerating");
        copyOwnerTokenButton.Enabled = false;
        autoGenerateOwnerTokenButton.Enabled = false;
        statusLabel.Text = L("ownerTokenGenerating");
        AppendLog("[chatgpt2codex] Generating owner token before runtime restart...");

        var workspace = string.IsNullOrEmpty(selectedProjectPath) ? defaultWorkspace : selectedProjectPath;
        var cliPath = Path.Combine(root, "dist", "cli.js");
        System.Threading.ThreadPool.QueueUserWorkItem(delegate
        {
            string generatedToken = null;
            string generationError = null;
            try
            {
                var generation = new Process();
                generation.StartInfo = new ProcessStartInfo
                {
                    FileName = "node",
                    Arguments = Quote(cliPath) + " owner-token --generate --workspace " + Quote(workspace),
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                generation.Start();
                var stdout = generation.StandardOutput.ReadToEnd();
                generation.StandardError.ReadToEnd();
                generation.WaitForExit();
                if (generation.ExitCode != 0)
                {
                    generationError = "owner-token command exited with code " + generation.ExitCode;
                }
                else
                {
                    var payload = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(stdout);
                    object tokenValue;
                    if (payload != null && payload.TryGetValue("ownerToken", out tokenValue))
                    {
                        generatedToken = Convert.ToString(tokenValue);
                    }
                    if (string.IsNullOrWhiteSpace(generatedToken) || generatedToken.Length < 40)
                    {
                        generatedToken = null;
                        generationError = "owner-token command did not return a valid token";
                    }
                }
            }
            catch (Exception ex)
            {
                generationError = ex.GetType().Name;
            }

            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke((Action)delegate
                {
                    if (string.IsNullOrEmpty(generatedToken))
                    {
                        ownerTokenBox.Text = "Owner token generation failed";
                        autoGenerateOwnerTokenButton.Enabled = true;
                        statusLabel.Text = "Owner token generation failed";
                        AppendLog("[chatgpt2codex] Owner token generation failed: " + (generationError ?? "unknown error"));
                        RefreshTrayState();
                        return;
                    }

                    SetOwnerToken(generatedToken);
                    AppendLog("[chatgpt2codex] Owner token generated. Restarting MCP runtime...");
                    RestartServer();
                });
            }
            catch (InvalidOperationException)
            {
                // The form is already closing.
            }
        });
    }

    private void SetOwnerToken(string value)
    {
        ownerToken = value;
        autoGenerateOwnerTokenOnNextStart = false;
        ownerTokenBox.UseSystemPasswordChar = true;
        ownerTokenBox.Text = value;
        copyOwnerTokenButton.Enabled = true;
        autoGenerateOwnerTokenButton.Enabled = true;
        if (CopyTextToClipboard(ownerToken, L("ownerTokenLabel"), ownerTokenBox))
        {
            statusLabel.Text = L("ownerTokenReadyCopied");
        }
        else
        {
            statusLabel.Text = L("ownerTokenReadyManualCopy");
        }
        RefreshTrayState();
    }

    private void ShowFromTray()
    {
        if (IsDisposed) return;
        ShowInTaskbar = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void HideToTray()
    {
        if (exitRequested || IsDisposed) return;
        Hide();
        ShowInTaskbar = false;
        if (!trayNoticeShown)
        {
            trayNoticeShown = true;
            trayIcon.ShowBalloonTip(
                2500,
                "ChatGPT To Codex is still running",
                "Use the tray icon's Quit menu to stop the server and tunnel completely.",
                ToolTipIcon.Info);
        }
    }

    private void ExitApplication()
    {
        if (exitRequested) return;
        if (IsTailscaleExternalOrigin() && process != null && !process.HasExited)
        {
            var answer = MessageBox.Show(
                this,
                "This app will stop the local MCP server, but it does not disable an externally managed Tailscale Serve/Funnel configuration.\r\n\r\nIf Funnel is enabled, disable it separately when you no longer want the public endpoint configured.\r\n\r\nQuit ChatGPT To Codex now?",
                "Tailscale public exposure",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);
            if (answer != DialogResult.Yes) return;
        }
        exitRequested = true;
        trayIcon.Visible = false;
        StopProcessTree();
        Close();
    }

    private void OnFormClosing(object sender, FormClosingEventArgs e)
    {
        if (!exitRequested && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            HideToTray();
            return;
        }

        exitRequested = true;
        trayIcon.Visible = false;
        StopProcessTree();
    }

    private void StartLauncher()
    {
        stopping = false;
        unifiedDashboardShown = false;
        mcpUrl = null;
        if (ResolveTunnelMode() != "loopback")
        {
            urlBox.Text = "Checking public connector...";
            copyButton.Enabled = false;
            statusLabel.Text = IsTailscaleExternalOrigin()
                ? "Tailscale URL configured; verifying Funnel/public reachability (Serve-only is private)"
                : "Local runtime starting; public connector not verified yet";
        }
        var script = Path.Combine(root, "start-chatgpt.ps1");
        if (!File.Exists(script))
        {
            AppendLog("ERROR: start-chatgpt.ps1 was not found next to chatgpt2codex.exe.");
            statusLabel.Text = "Missing launcher script";
            return;
        }

        AppendLog("ChatGPT To Codex launcher");
        AppendLog("Runtime: " + root);
        AppendLog("Log: " + logFile);
        AppendLog("");

        try
        {
            Directory.CreateDirectory(string.IsNullOrEmpty(selectedProjectPath) ? defaultWorkspace : selectedProjectPath);
        }
        catch (Exception ex)
        {
            AppendLog("ERROR: could not prepare workspace folder: " + ex.Message);
            statusLabel.Text = "Workspace folder error";
            RefreshTrayState();
            return;
        }

        var powerShellArgs = "-NoProfile -ExecutionPolicy Bypass -File " + Quote(script);
        var launcherArgs = new List<string>(BuildLauncherArgs());
        if (autoGenerateOwnerTokenOnNextStart)
        {
            launcherArgs.Add("-RotateOwnerToken");
        }
        if (launcherArgs.Count > 0) powerShellArgs += " " + JoinArgs(launcherArgs.ToArray());

        process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = powerShellArgs,
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        process.StartInfo.EnvironmentVariables["CHATGPT2CODEX_MULTI_PROJECT_LANES"] = multiProjectLanesEnabled ? "1" : "0";
        process.StartInfo.EnvironmentVariables["CHATGPT2CODEX_CONTROL_ALLOWLIST"] = string.Join(",", controlAllowlist ?? new string[0]);
        if (autoGenerateOwnerTokenOnNextStart)
        {
            process.StartInfo.EnvironmentVariables["CHATGPT2CODEX_ROTATE_OWNER_TOKEN"] = "1";
        }
        if (!string.IsNullOrEmpty(selectedProjectPath) && HasProjectMarker(selectedProjectPath))
        {
            process.StartInfo.EnvironmentVariables["CHATGPT2CODEX_ACTIVE_PROJECT_ROOT"] = selectedProjectPath;
            process.StartInfo.EnvironmentVariables["CHATGPT2CODEX_ACTIVE_PROJECT_PRESET"] = "full-write";
        }
        process.EnableRaisingEvents = true;
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (e.Data != null) AppendLog(e.Data);
        };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (e.Data != null) AppendLog(e.Data);
        };
        process.Exited += delegate(object sender, EventArgs e)
        {
            var exitedProcess = (Process)sender;
            var exitCode = exitedProcess.ExitCode;
            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke((Action)delegate
                {
                    statusLabel.Text = exitCode == 0 || stopping ? "Stopped" : "Exited with code " + exitCode;
                    RefreshTrayState();
                    AppendLog("");
                    AppendLog("chatgpt2codex exited with code " + exitCode + ".");
                });
            }
            catch (InvalidOperationException)
            {
                // The form is already closing.
            }
        };

        try
        {
            process.Start();
            autoGenerateOwnerTokenOnNextStart = false;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            statusLabel.Text = "Starting server and tunnel...";
            RefreshTrayState();
        }
        catch (Exception ex)
        {
            AppendLog("ERROR: " + ex.Message);
            statusLabel.Text = "Failed to start";
            RefreshTrayState();
        }
    }

    private void AppendLog(string line)
    {
        if (InvokeRequired)
        {
            BeginInvoke((Action)(() => AppendLog(line)));
            return;
        }

        line = CaptureSecretsForUiAndRedact(line);
        TrimCurrentLogIfNeeded();
        File.AppendAllText(logFile, line + Environment.NewLine, Encoding.UTF8);
        logBox.AppendText(line + Environment.NewLine);
        TrimVisibleLogIfNeeded();

        var match = Regex.Match(line, @"https?://\S+/mcp");
        if (match.Success)
        {
            var previousConnectorUrl = lastConnectorUrl;
            mcpUrl = match.Value.Trim();
            urlBox.Text = mcpUrl;
            copyButton.Enabled = true;
            if (!string.Equals(previousConnectorUrl, mcpUrl, StringComparison.OrdinalIgnoreCase))
            {
                lastConnectorUrl = mcpUrl;
                SaveSettings();
            }
            if (IsTemporaryTunnelUrl(mcpUrl))
            {
                statusLabel.Text = string.IsNullOrEmpty(previousConnectorUrl) ||
                    string.Equals(previousConnectorUrl, mcpUrl, StringComparison.OrdinalIgnoreCase)
                    ? L("temporaryTunnelReady")
                    : L("temporaryTunnelChanged");
            }
            else
            {
                statusLabel.Text = LFormat("stableConnectorReady", mcpUrl);
            }
            RefreshTrayState();
        }
        else if (line.IndexOf("public tunnel did not become ready", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            statusLabel.Text = string.IsNullOrEmpty(mcpUrl)
                ? "Local server is running; waiting for public tunnel"
                : "MCP URL ready; public tunnel is still warming up";
        }
        else if (line.IndexOf("Tailscale Serve is tailnet-private", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            statusLabel.Text = "Tailscale Serve is private; ChatGPT web needs Funnel/public HTTPS";
        }
        else if (line.IndexOf("chatgpt2codex is ready", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            statusLabel.Text = string.IsNullOrEmpty(mcpUrl) ? "Ready" : "Ready: " + mcpUrl;
        }
    }

    private string CaptureSecretsForUiAndRedact(string line)
    {
        if (line.IndexOf("generated a new HTTP owner token", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            pendingSecretKind = "owner";
            return line;
        }
        if (line.IndexOf("owner token already set", StringComparison.OrdinalIgnoreCase) >= 0 &&
            string.IsNullOrEmpty(ownerToken))
        {
            ownerTokenBox.UseSystemPasswordChar = false;
            ownerTokenBox.Text = L("ownerTokenConfigured");
            autoGenerateOwnerTokenButton.Enabled = true;
            RefreshTrayState();
            return line;
        }

        var secretMatch = Regex.Match(line, @"^\s{2}([A-Za-z0-9_-]{40,})\s*$");
        if (secretMatch.Success && !string.IsNullOrEmpty(pendingSecretKind))
        {
            var value = secretMatch.Groups[1].Value;
            var kind = pendingSecretKind;
            pendingSecretKind = null;
            if (kind == "owner")
            {
                SetOwnerToken(value);
                return "  [owner token captured by app; copied to clipboard]";
            }
        }

        return line;
    }

    private void StopProcessTree()
    {
        if (stopping) return;
        stopping = true;
        RefreshTrayState();

        try
        {
            if (process != null && !process.HasExited)
            {
                AppendLog("");
                AppendLog("Stopping ChatGPT To Codex...");
                var killer = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill.exe",
                    Arguments = "/pid " + process.Id + " /t /f",
                    CreateNoWindow = true,
                    UseShellExecute = false
                });
                if (killer != null) killer.WaitForExit(5000);
            }
        }
        catch
        {
            // Best-effort shutdown only.
        }
        RefreshTrayState();
    }
}
