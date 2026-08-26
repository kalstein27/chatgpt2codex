import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import Security
import ScreenCaptureKit
import WebKit

private func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

private func appleScriptString(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
}

private func versionIsNewer(_ candidate: String, than current: String) -> Bool {
    let candidateParts = candidate.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
    let currentParts = current.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
    let count = max(candidateParts.count, currentParts.count)
    for index in 0..<count {
        let left = index < candidateParts.count ? candidateParts[index] : 0
        let right = index < currentParts.count ? currentParts[index] : 0
        if left != right { return left > right }
    }
    return false
}

private struct LanguageOption {
    let code: String
    let name: String
}

private struct RuntimeUpdate {
    let version: String
    let dmgURL: URL
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

private let ownerTokenKeychainService = "dev.chatgpttocodex.owner-token"
private let ownerTokenKeychainAccount = "owner-token"

private let preferredLanguageKey = "preferredLanguage"
private let screenRecordingPromptLastShownKey = "screenRecordingPromptLastShownAt"
private let desktopLanguageCodes = [
    "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt-BR", "it",
    "nl", "pl", "ru", "tr", "vi", "id", "th", "ar", "hi", "uk"
]
private let desktopLanguageOptions = [
    LanguageOption(code: "auto", name: "Auto (System)"),
    LanguageOption(code: "en", name: "English"),
    LanguageOption(code: "ko", name: "한국어"),
    LanguageOption(code: "ja", name: "日本語"),
    LanguageOption(code: "zh-Hans", name: "简体中文"),
    LanguageOption(code: "zh-Hant", name: "繁體中文"),
    LanguageOption(code: "es", name: "Español"),
    LanguageOption(code: "fr", name: "Français"),
    LanguageOption(code: "de", name: "Deutsch"),
    LanguageOption(code: "pt-BR", name: "Português (Brasil)"),
    LanguageOption(code: "it", name: "Italiano"),
    LanguageOption(code: "nl", name: "Nederlands"),
    LanguageOption(code: "pl", name: "Polski"),
    LanguageOption(code: "ru", name: "Русский"),
    LanguageOption(code: "tr", name: "Türkçe"),
    LanguageOption(code: "vi", name: "Tiếng Việt"),
    LanguageOption(code: "id", name: "Bahasa Indonesia"),
    LanguageOption(code: "th", name: "ไทย"),
    LanguageOption(code: "ar", name: "العربية"),
    LanguageOption(code: "hi", name: "हिन्दी"),
    LanguageOption(code: "uk", name: "Українська")
]

private let desktopLocalizationRows: [String: [String]] = [
    "defaultWorkspace": ["Default workspace", "기본 작업공간", "デフォルトワークスペース", "默认工作区", "預設工作區", "Espacio predeterminado", "Espace par défaut", "Standardarbeitsbereich", "Espaço padrão", "Area predefinita", "Standaardwerkruimte", "Domyślny obszar roboczy", "Рабочая область по умолчанию", "Varsayılan çalışma alanı", "Không gian mặc định", "Ruang kerja default", "พื้นที่ทำงานเริ่มต้น", "مساحة العمل الافتراضية", "डिफ़ॉल्ट कार्यक्षेत्र", "Типова робоча область"],
    "statusChecking": ["checking...", "확인 중...", "確認中...", "正在检查...", "正在檢查...", "comprobando...", "vérification...", "wird geprüft...", "verificando...", "controllo...", "controleren...", "sprawdzanie...", "проверка...", "kontrol ediliyor...", "đang kiểm tra...", "memeriksa...", "กำลังตรวจสอบ...", "جار التحقق...", "जांच हो रही है...", "перевірка..."],
    "statusOn": ["on", "켜짐", "オン", "开启", "開啟", "activo", "actif", "ein", "ligado", "attivo", "aan", "włączone", "вкл", "açık", "bật", "aktif", "เปิด", "تشغيل", "चालू", "увімкнено"],
    "statusOff": ["off", "꺼짐", "オフ", "关闭", "關閉", "inactivo", "inactif", "aus", "desligado", "spento", "uit", "wyłączone", "выкл", "kapalı", "tắt", "nonaktif", "ปิด", "إيقاف", "बंद", "вимкнено"],
    "statusStarting": ["starting...", "시작 중...", "起動中...", "正在启动...", "正在啟動...", "iniciando...", "démarrage...", "startet...", "iniciando...", "avvio...", "starten...", "uruchamianie...", "запуск...", "başlatılıyor...", "đang khởi động...", "memulai...", "กำลังเริ่ม...", "جار البدء...", "शुरू हो रहा है...", "запуск..."],
    "statusRestarting": ["restarting...", "재시작 중...", "再起動中...", "正在重启...", "正在重新啟動...", "reiniciando...", "redémarrage...", "Neustart...", "reiniciando...", "riavvio...", "opnieuw starten...", "restartowanie...", "перезапуск...", "yeniden başlatılıyor...", "đang khởi động lại...", "memulai ulang...", "กำลังรีสตาร์ท...", "جار إعادة التشغيل...", "फिर शुरू हो रहा है...", "перезапуск..."],
    "projectPrefix": ["Project", "프로젝트", "プロジェクト", "项目", "專案", "Proyecto", "Projet", "Projekt", "Projeto", "Progetto", "Project", "Projekt", "Проект", "Proje", "Dự án", "Proyek", "โปรเจกต์", "المشروع", "प्रोजेक्ट", "Проєкт"],
    "portPrefix": ["Port", "포트", "ポート", "端口", "連接埠", "Puerto", "Port", "Port", "Porta", "Porta", "Poort", "Port", "Порт", "Bağlantı noktası", "Cổng", "Port", "พอร์ต", "المنفذ", "पोर्ट", "Порт"],
    "startMCP": ["Start MCP", "MCP 시작", "MCP を開始", "启动 MCP", "啟動 MCP", "Iniciar MCP", "Démarrer MCP", "MCP starten", "Iniciar MCP", "Avvia MCP", "MCP starten", "Uruchom MCP", "Запустить MCP", "MCP başlat", "Khởi động MCP", "Mulai MCP", "เริ่ม MCP", "بدء MCP", "MCP शुरू करें", "Запустити MCP"],
    "stopMCP": ["Stop MCP", "MCP 중지", "MCP を停止", "停止 MCP", "停止 MCP", "Detener MCP", "Arrêter MCP", "MCP stoppen", "Parar MCP", "Ferma MCP", "MCP stoppen", "Zatrzymaj MCP", "Остановить MCP", "MCP durdur", "Dừng MCP", "Hentikan MCP", "หยุด MCP", "إيقاف MCP", "MCP रोकें", "Зупинити MCP"],
    "restartMCP": ["Restart MCP", "MCP 재시작", "MCP を再起動", "重启 MCP", "重新啟動 MCP", "Reiniciar MCP", "Redémarrer MCP", "MCP neu starten", "Reiniciar MCP", "Riavvia MCP", "MCP herstarten", "Uruchom ponownie MCP", "Перезапустить MCP", "MCP yeniden başlat", "Khởi động lại MCP", "Mulai ulang MCP", "รีสตาร์ท MCP", "إعادة تشغيل MCP", "MCP फिर शुरू करें", "Перезапустити MCP"],
    "restartAfterSaveTitle": ["Restart MCP now?", "지금 MCP를 재시작할까요?"],
    "restartAfterSaveInfo": ["Settings were saved, but the running MCP server keeps using the previous workspace, tunnel, port, and related options until it restarts.", "설정은 저장됐지만 실행 중인 MCP 서버는 재시작 전까지 이전 프로젝트 폴더, 터널, 포트 설정을 계속 사용합니다."],
    "selectProjectFolderMenu": ["Select Project Folder...", "프로젝트 폴더 선택...", "プロジェクトフォルダを選択...", "选择项目文件夹...", "選擇專案資料夾...", "Seleccionar carpeta del proyecto...", "Choisir le dossier du projet...", "Projektordner auswählen...", "Selecionar pasta do projeto...", "Seleziona cartella progetto...", "Projectmap kiezen...", "Wybierz folder projektu...", "Выбрать папку проекта...", "Proje klasörü seç...", "Chọn thư mục dự án...", "Pilih folder proyek...", "เลือกโฟลเดอร์โปรเจกต์...", "اختيار مجلد المشروع...", "प्रोजेक्ट फ़ोल्डर चुनें...", "Вибрати теку проєкту..."],
    "settingsMenu": ["Settings...", "설정...", "設定...", "设置...", "設定...", "Ajustes...", "Réglages...", "Einstellungen...", "Configurações...", "Impostazioni...", "Instellingen...", "Ustawienia...", "Настройки...", "Ayarlar...", "Cài đặt...", "Pengaturan...", "การตั้งค่า...", "الإعدادات...", "सेटिंग्स...", "Налаштування..."],
    "rgPermissionMenu": ["External search tool (rg)", "외부 검색 도구 (rg)"],
    "rgAskEveryTime": ["Ask every time", "사용할 때마다 묻기"],
    "rgCodeSearchOnly": ["Use code_search only", "code_search만 사용"],
    "rgPendingNone": ["No pending rg approval requests", "대기 중인 rg 승인 요청 없음"],
    "rgUnavailable": ["Verified rg is unavailable", "검증된 rg를 사용할 수 없음"],
    "rgApprovalTitle": ["External rg search approval", "외부 rg 검색 승인 요청"],
    "rgApproveOnce": ["Allow once", "이번만 허용"],
    "rgApproveSession": ["Allow for this project session", "현재 프로젝트 세션 동안 허용"],
    "rgApproveAlways": ["Always allow this verified rg", "검증된 rg 항상 허용"],
    "rgReject": ["Reject", "거부"],
    "connectionDiagnosticsMenu": ["Connection Diagnostics...", "연결 진단 로그..."],
    "launchAtLoginMenu": ["Launch at Login", "로그인 시 실행", "ログイン時に起動", "登录时启动", "登入時啟動", "Iniciar al acceder", "Lancer à la connexion", "Beim Anmelden starten", "Abrir ao iniciar sessão", "Avvia al login", "Start bij inloggen", "Uruchamiaj przy logowaniu", "Запускать при входе", "Girişte başlat", "Mở khi đăng nhập", "Jalankan saat login", "เปิดเมื่อเข้าสู่ระบบ", "التشغيل عند تسجيل الدخول", "लॉगिन पर शुरू करें", "Запускати під час входу"],
    "startOnOpenMenu": ["Start MCP When App Opens", "앱 열 때 MCP 시작", "アプリ起動時に MCP を開始", "应用打开时启动 MCP", "App 開啟時啟動 MCP", "Iniciar MCP al abrir la app", "Démarrer MCP à l'ouverture", "MCP beim Öffnen starten", "Iniciar MCP ao abrir o app", "Avvia MCP all'apertura", "Start MCP bij openen", "Uruchamiaj MCP przy otwarciu", "Запускать MCP при открытии", "Uygulama açılınca MCP başlat", "Khởi động MCP khi mở ứng dụng", "Mulai MCP saat app dibuka", "เริ่ม MCP เมื่อเปิดแอป", "بدء MCP عند فتح التطبيق", "ऐप खुलने पर MCP शुरू करें", "Запускати MCP під час відкриття"],
    "screenshotPermissionMenu": ["Screen & System Audio Recording Permission...", "화면 및 시스템 오디오 기록 권한..."],
    "screenshotPermissionTitle": ["Screen & System Audio Recording permission", "화면 및 시스템 오디오 기록 권한"],
    "screenshotPermissionMissingInfo": ["ChatGPT To Codex needs macOS Screen & System Audio Recording permission to capture E2E screenshots and show them inline in ChatGPT. Enable ChatGPT To Codex in System Settings > Privacy & Security > Screen & System Audio Recording. The app will never request this permission automatically during an E2E capture.", "E2E 스크린샷을 찍고 ChatGPT 답변에 인라인으로 보여주려면 macOS 화면 및 시스템 오디오 기록 권한이 필요합니다. 시스템 설정 > 개인정보 보호 및 보안 > 화면 및 시스템 오디오 기록에서 ChatGPT To Codex를 허용하세요. E2E 캡처 중에는 이 권한을 자동 요청하지 않습니다."],
    "screenshotPermissionReadyInfo": ["Screen & System Audio Recording permission is already allowed. E2E screenshots can be captured by the menu-bar app and returned inline.", "화면 및 시스템 오디오 기록 권한이 이미 허용되어 있습니다. 메뉴바 앱이 E2E 스크린샷을 캡처해 인라인으로 제공할 수 있습니다."],
    "openPrivacySettings": ["Open Privacy Settings", "개인정보 설정 열기"],
    "requestPermission": ["Request Permission", "권한 요청"],
    "accessibilityPermissionMenu": ["Accessibility Permission...", "손쉬운 사용 권한..."],
    "accessibilityPermissionTitle": ["Accessibility permission", "손쉬운 사용 권한"],
    "accessibilityPermissionMissingInfo": ["ChatGPT To Codex needs macOS Accessibility permission to perform approved desktop-control clicks, typing, and key presses. Enable ChatGPT To Codex in System Settings > Privacy & Security > Accessibility, then restart the app if macOS asks for it.", "승인된 데스크톱 제어 클릭·입력·키 입력을 실행하려면 macOS 손쉬운 사용 권한이 필요합니다. 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 ChatGPT To Codex를 허용하고, macOS가 요청하면 앱을 재시작하세요."],
    "accessibilityPermissionReadyInfo": ["Accessibility permission is already allowed. Approved control actions can be executed.", "손쉬운 사용 권한이 이미 허용되어 있습니다. 승인된 제어 작업을 실행할 수 있습니다."],
    "pendingControlActionsMenu": ["Pending control actions", "대기 중인 제어 작업"],
    "controlNoPendingActions": ["No pending actions", "대기 중인 작업 없음"],
    "controlApprove": ["Approve", "승인"],
    "controlReject": ["Reject", "거부"],
    "agentArmStatusMenu": ["Agent Arm: local approval required", "Agent Arm: 로컬 승인 필요"],
    "agentArmStatusDetail": ["Remote ChatGPT can request control actions, but execution still requires this Mac's control lease, allowlist, sensitive-app checks, and kill switch.", "원격 ChatGPT는 제어 작업을 요청할 수 있지만 실행에는 이 Mac의 제어 lease, 허용 목록, 민감 앱 검사, kill switch가 계속 필요합니다."],
    "agentArmOnMenu": ["Agent Arm: on", "Agent Arm: 켜짐"],
    "agentArmOffMenu": ["Agent Arm: off", "Agent Arm: 꺼짐"],
    "agentArmOnExplanation": ["Desktop control is available; approvals and safety checks still apply", "화면 제어 가능 · 작업 승인과 안전 검사는 계속 적용"],
    "agentArmOffExplanation": ["Desktop clicks and typing are blocked; normal C2CT tools still work", "화면 클릭·입력 차단 · 일반 C2CT 작업은 계속 가능"],
    "agentArmRemoteRequestExplanation": ["Remote control requests are approved separately and never turn this on automatically", "원격 제어 요청은 별도 승인 · 자동으로 켜지지 않음"],
    "activeSessionsMenu": ["Active session status", "활성 세션 상태"],
    "sessionNoActive": ["No active sessions", "활성 세션 없음"],
    "activityWindowMenu": ["Current Work...", "작업 현황..."],
    "activityWindowTitle": ["Current Work", "현재 작업 현황"],
    "activityRefresh": ["Refresh", "새로고침"],
    "activityNoSessions": ["No sessions or operations are active.", "진행 중인 세션이나 작업이 없습니다."],
    "activityWaitingForTool": ["Connected · waiting for the next C2CT tool call", "연결됨 · 다음 C2CT 도구 호출 대기"],
    "activityThinkingNotObservable": ["ChatGPT thinking and response drafting happen outside the C2CT runtime and cannot be displayed here.", "ChatGPT의 생각·답변 작성 단계는 C2CT runtime 밖에서 진행되어 여기에 표시되지 않습니다."],
    "activityWaiting": ["May be waiting for a response", "응답 대기 가능"],
    "activityLastUpdated": ["Last updated", "최근 갱신"],
    "activityStartedAt": ["Started", "시작"],
    "activityFinishedAt": ["Finished", "완료"],
    "activityConnectedAt": ["Connected", "연결"],
    "activityChats": ["chats", "채팅"],
    "activityOlderOperations": ["older operations", "개의 이전 작업"],
    "sessionPhase": ["Phase", "단계"],
    "sessionHeartbeat": ["heartbeat", "하트비트"],
    "sessionClientCancelled": ["Client stopped waiting", "클라이언트가 대기를 중단함"],
    "sessionNoAutomaticRetry": ["do not retry automatically", "자동 재실행 금지"],
    "permissionAllowed": ["allowed", "허용됨"],
    "permissionRequired": ["permission required", "권한 필요"],
    "killControlMenu": ["Kill Control", "제어 강제 종료"],
    "killControlConfirmTitle": ["Kill control session?", "제어 세션을 강제 종료할까요?"],
    "killControlConfirmInfo": ["This immediately rejects every pending control action and blocks new ones until a fresh control lease is granted.", "대기 중인 모든 제어 작업을 즉시 거부하고, 새 제어 lease를 부여하기 전까지 새 작업을 차단합니다."],
    "approveAllControlMenu": ["Approve all pending", "대기 중인 작업 모두 승인"],
    "autoApproveOnMenu": ["Turn on auto-approve (10 min)", "자동 승인 켜기 (10분)"],
    "autoApproveOffMenu": ["Turn off auto-approve", "자동 승인 끄기"],
    "autoApproveStatusMenu": ["Auto-approve: on", "자동 승인: 켜짐"],
    "autoApproveUnavailableMenu": ["Auto-approve needs an allowlisted app (CHATGPT2CODEX_CONTROL_ALLOWLIST)", "자동 승인을 사용하려면 허용 목록(CHATGPT2CODEX_CONTROL_ALLOWLIST) 앱이 필요합니다"],
    "autoUpdatesMenu": ["Auto Check for Updates", "업데이트 자동 확인", "更新を自動確認", "自动检查更新", "自動檢查更新", "Buscar actualizaciones automáticamente", "Recherche auto des mises à jour", "Automatisch nach Updates suchen", "Verificar atualizações automaticamente", "Controlla aggiornamenti automaticamente", "Automatisch updates zoeken", "Automatycznie sprawdzaj aktualizacje", "Автопроверка обновлений", "Güncellemeleri otomatik denetle", "Tự động kiểm tra cập nhật", "Periksa pembaruan otomatis", "ตรวจอัปเดตอัตโนมัติ", "التحقق التلقائي من التحديثات", "अपडेट अपने-आप जांचें", "Автоматично перевіряти оновлення"],
    "openLocalHealth": ["Open Local Health", "로컬 상태 열기", "ローカルヘルスを開く", "打开本地健康检查", "開啟本機健康檢查", "Abrir estado local", "Ouvrir l'état local", "Lokalen Status öffnen", "Abrir saúde local", "Apri stato locale", "Lokale status openen", "Otwórz status lokalny", "Открыть локальный статус", "Yerel durumu aç", "Mở trạng thái cục bộ", "Buka kesehatan lokal", "เปิดสถานะภายใน", "فتح حالة الجهاز", "स्थानीय हेल्थ खोलें", "Відкрити локальний стан"],
    "openPublicHealth": ["Open Public Health", "공개 상태 열기", "公開ヘルスを開く", "打开公开健康检查", "開啟公開健康檢查", "Abrir estado público", "Ouvrir l'état public", "Öffentlichen Status öffnen", "Abrir saúde pública", "Apri stato pubblico", "Publieke status openen", "Otwórz status publiczny", "Открыть публичный статус", "Genel durumu aç", "Mở trạng thái công khai", "Buka kesehatan publik", "เปิดสถานะสาธารณะ", "فتح الحالة العامة", "सार्वजनिक हेल्थ खोलें", "Відкрити публічний стан"],
    "copyConnector": ["Copy Connector URL", "커넥터 URL 복사", "コネクタ URL をコピー", "复制连接器 URL", "複製連接器 URL", "Copiar URL del conector", "Copier l'URL du connecteur", "Connector-URL kopieren", "Copiar URL do conector", "Copia URL connettore", "Connector-URL kopiëren", "Kopiuj URL konektora", "Копировать URL коннектора", "Bağlayıcı URL'sini kopyala", "Sao chép URL kết nối", "Salin URL konektor", "คัดลอก URL ตัวเชื่อมต่อ", "نسخ رابط الموصل", "कनेक्टर URL कॉपी करें", "Скопіювати URL конектора"],
    "openGithub": ["Open GitHub Repository", "GitHub 저장소 열기", "GitHub リポジトリを開く", "打开 GitHub 仓库", "開啟 GitHub 儲存庫", "Abrir repositorio GitHub", "Ouvrir le dépôt GitHub", "GitHub-Repository öffnen", "Abrir repositório GitHub", "Apri repository GitHub", "GitHub-repository openen", "Otwórz repozytorium GitHub", "Открыть репозиторий GitHub", "GitHub deposunu aç", "Mở kho GitHub", "Buka repositori GitHub", "เปิด GitHub repository", "فتح مستودع GitHub", "GitHub रिपॉज़िटरी खोलें", "Відкрити репозиторій GitHub"],
    "checkUpdates": ["Check for Updates...", "업데이트 확인...", "更新を確認...", "检查更新...", "檢查更新...", "Buscar actualizaciones...", "Rechercher les mises à jour...", "Nach Updates suchen...", "Verificar atualizações...", "Controlla aggiornamenti...", "Updates zoeken...", "Sprawdź aktualizacje...", "Проверить обновления...", "Güncellemeleri denetle...", "Kiểm tra cập nhật...", "Periksa pembaruan...", "ตรวจหาอัปเดต...", "التحقق من التحديثات...", "अपडेट जांचें...", "Перевірити оновлення..."],
    "showLogs": ["Show Logs", "로그 보기", "ログを表示", "显示日志", "顯示日誌", "Mostrar registros", "Afficher les journaux", "Logs anzeigen", "Mostrar logs", "Mostra log", "Logs tonen", "Pokaż logi", "Показать журналы", "Günlükleri göster", "Hiện nhật ký", "Tampilkan log", "แสดงบันทึก", "عرض السجلات", "लॉग दिखाएं", "Показати журнали"],
    "runDoctor": ["Run Doctor", "Doctor 실행", "Doctor を実行", "运行 Doctor", "執行 Doctor", "Ejecutar Doctor", "Lancer Doctor", "Doctor ausführen", "Executar Doctor", "Esegui Doctor", "Doctor uitvoeren", "Uruchom Doctor", "Запустить Doctor", "Doctor çalıştır", "Chạy Doctor", "Jalankan Doctor", "เรียกใช้ Doctor", "تشغيل Doctor", "Doctor चलाएं", "Запустити Doctor"],
    "doctorTitle": ["ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor"],
    "doctorRunning": ["Running dependency doctor...", "의존성 Doctor 실행 중...", "依存関係 Doctor を実行中...", "正在运行依赖 Doctor...", "正在執行相依性 Doctor...", "Ejecutando Doctor de dependencias...", "Diagnostic des dépendances en cours...", "Abhängigkeits-Doctor läuft...", "Executando Doctor de dependências...", "Doctor dipendenze in esecuzione...", "Afhankelijkheidsdoctor uitvoeren...", "Uruchamianie doctora zależności...", "Запуск проверки зависимостей...", "Bağımlılık Doctor çalışıyor...", "Đang chạy Doctor phụ thuộc...", "Menjalankan Doctor dependensi...", "กำลังเรียกใช้ Doctor ตรวจ dependency...", "جار تشغيل Doctor للتبعيات...", "Dependency Doctor चल रहा है...", "Запуск Doctor залежностей..."],
    "ownerToken": ["Owner auth token", "소유자 인증 토큰"],
    "ownerTokenReady": ["configured", "설정됨"],
    "ownerTokenCopiedStatus": ["configured - copied", "설정됨 · 복사됨"],
    "ownerTokenMissing": ["not set", "미설정"],
    "ownerTokenCheckFailed": ["status check failed", "상태 확인 실패"],
    "ownerTokenGenerateCopy": ["Generate & Copy Token", "토큰 생성 후 복사"],
    "ownerTokenCopy": ["Copy Token", "토큰 복사"],
    "ownerTokenCopyUnavailable": ["Generate a token first. Existing tokens are stored by hash only unless this app generated them.", "먼저 토큰을 생성하세요. 기존 토큰은 이 앱이 생성한 경우가 아니면 해시로만 저장되어 다시 복사할 수 없습니다."],
    "ownerTokenGenerating": ["Generating...", "생성 중..."],
    "ownerTokenRegenerateTitle": ["Generate a new token?", "새 토큰을 생성할까요?"],
    "ownerTokenRegenerateInfo": ["The current token will be replaced and existing ChatGPT OAuth sessions will be revoked.", "현재 토큰이 새 토큰으로 교체되고 기존 ChatGPT OAuth 세션은 무효화됩니다."],
    "ownerTokenGeneratedTitle": ["Token copied", "토큰 복사됨"],
    "ownerTokenGeneratedInfo": ["A new owner auth token was generated, copied, and applied immediately. No settings save is needed. Store it in your password manager. Existing ChatGPT OAuth sessions were revoked.", "새 소유자 인증 토큰을 생성해 클립보드에 복사했고 즉시 적용했습니다. 설정 저장은 필요 없습니다. 비밀번호 관리자에 저장하세요. 기존 ChatGPT OAuth 세션은 무효화됐습니다."],
    "openStatus": ["Open Status", "상태 열기"],
    "about": ["About ezBuilder", "ezBuilder 정보", "ezBuilder について", "关于 ezBuilder", "關於 ezBuilder", "Acerca de ezBuilder", "À propos d'ezBuilder", "Über ezBuilder", "Sobre ezBuilder", "Informazioni su ezBuilder", "Over ezBuilder", "O ezBuilder", "О ezBuilder", "ezBuilder hakkında", "Giới thiệu ezBuilder", "Tentang ezBuilder", "حول ezBuilder", "ezBuilder के बारे में", "Про ezBuilder"],
    "quit": ["Quit", "종료", "終了", "退出", "結束", "Salir", "Quitter", "Beenden", "Sair", "Esci", "Afsluiten", "Zakończ", "Выход", "Çık", "Thoát", "Keluar", "ออก", "إنهاء", "बंद करें", "Вийти"],
    "tooltipState": ["ChatGPT To Codex MCP is %@", "ChatGPT To Codex MCP: %@", "ChatGPT To Codex MCP は %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP está %@", "ChatGPT To Codex MCP est %@", "ChatGPT To Codex MCP ist %@", "ChatGPT To Codex MCP está %@", "ChatGPT To Codex MCP è %@", "ChatGPT To Codex MCP is %@", "ChatGPT To Codex MCP jest %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP đang %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP %@"] ,
    "selectProjectFolderTitle": ["Select Project Folder", "프로젝트 폴더 선택", "プロジェクトフォルダを選択", "选择项目文件夹", "選擇專案資料夾", "Seleccionar carpeta del proyecto", "Choisir le dossier du projet", "Projektordner auswählen", "Selecionar pasta do projeto", "Seleziona cartella progetto", "Projectmap kiezen", "Wybierz folder projektu", "Выбрать папку проекта", "Proje klasörü seç", "Chọn thư mục dự án", "Pilih folder proyek", "เลือกโฟลเดอร์โปรเจกต์", "اختيار مجلد المشروع", "प्रोजेक्ट फ़ोल्डर चुनें", "Вибрати теку проєкту"],
    "select": ["Select", "선택", "選択", "选择", "選擇", "Seleccionar", "Choisir", "Auswählen", "Selecionar", "Seleziona", "Kiezen", "Wybierz", "Выбрать", "Seç", "Chọn", "Pilih", "เลือก", "اختيار", "चुनें", "Вибрати"],
    "projectMarkerTitle": ["Project marker not found", "프로젝트 표시를 찾지 못했습니다", "プロジェクトマーカーが見つかりません", "未找到项目标记", "找不到專案標記", "No se encontró marcador de proyecto", "Marqueur de projet introuvable", "Projektmarker nicht gefunden", "Marcador do projeto não encontrado", "Marcatore progetto non trovato", "Projectmarkering niet gevonden", "Nie znaleziono znacznika projektu", "Маркер проекта не найден", "Proje işareti bulunamadı", "Không tìm thấy dấu hiệu dự án", "Penanda proyek tidak ditemukan", "ไม่พบตัวบ่งชี้โปรเจกต์", "لم يتم العثور على علامة مشروع", "प्रोजेक्ट संकेत नहीं मिला", "Маркер проєкту не знайдено"],
    "projectMarkerInfo": ["Choose a folder with .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt, or .chatgpt2codex.", ".git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt, .chatgpt2codex 중 하나가 있는 폴더를 선택하세요.", ".git、package.json、pubspec.yaml、go.mod、Cargo.toml、requirements.txt、.chatgpt2codex のいずれかがあるフォルダを選んでください。", "请选择包含 .git、package.json、pubspec.yaml、go.mod、Cargo.toml、requirements.txt 或 .chatgpt2codex 的文件夹。", "請選擇包含 .git、package.json、pubspec.yaml、go.mod、Cargo.toml、requirements.txt 或 .chatgpt2codex 的資料夾。", "Elige una carpeta con .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt o .chatgpt2codex.", "Choisissez un dossier avec .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt ou .chatgpt2codex.", "Wähle einen Ordner mit .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt oder .chatgpt2codex.", "Escolha uma pasta com .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt ou .chatgpt2codex.", "Scegli una cartella con .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt o .chatgpt2codex.", "Kies een map met .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt of .chatgpt2codex.", "Wybierz folder z .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt lub .chatgpt2codex.", "Выберите папку с .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt или .chatgpt2codex.", ".git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt veya .chatgpt2codex içeren bir klasör seçin.", "Chọn thư mục có .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt hoặc .chatgpt2codex.", "Pilih folder yang berisi .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt, atau .chatgpt2codex.", "เลือกโฟลเดอร์ที่มี .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt หรือ .chatgpt2codex", "اختر مجلدا يحتوي على .git أو package.json أو pubspec.yaml أو go.mod أو Cargo.toml أو requirements.txt أو .chatgpt2codex.", ".git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt या .chatgpt2codex वाला फ़ोल्डर चुनें।", "Виберіть теку з .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt або .chatgpt2codex."],
    "settingsTitle": ["ChatGPT To Codex Settings", "ChatGPT To Codex 설정", "ChatGPT To Codex 設定", "ChatGPT To Codex 设置", "ChatGPT To Codex 設定", "Ajustes de ChatGPT To Codex", "Réglages de ChatGPT To Codex", "ChatGPT To Codex Einstellungen", "Configurações do ChatGPT To Codex", "Impostazioni ChatGPT To Codex", "ChatGPT To Codex instellingen", "Ustawienia ChatGPT To Codex", "Настройки ChatGPT To Codex", "ChatGPT To Codex ayarları", "Cài đặt ChatGPT To Codex", "Pengaturan ChatGPT To Codex", "การตั้งค่า ChatGPT To Codex", "إعدادات ChatGPT To Codex", "ChatGPT To Codex सेटिंग्स", "Налаштування ChatGPT To Codex"],
    "settingsInfo": ["ezBuilder local MCP runtime settings", "ezBuilder 로컬 MCP 런타임 설정", "ezBuilder ローカル MCP ランタイム設定", "ezBuilder 本地 MCP 运行时设置", "ezBuilder 本機 MCP 執行階段設定", "Ajustes del runtime MCP local de ezBuilder", "Réglages du runtime MCP local ezBuilder", "Lokale MCP-Laufzeit von ezBuilder", "Configurações do runtime MCP local ezBuilder", "Impostazioni runtime MCP locale ezBuilder", "Lokale MCP-runtime instellingen van ezBuilder", "Ustawienia lokalnego runtime MCP ezBuilder", "Настройки локального MCP ezBuilder", "ezBuilder yerel MCP çalışma zamanı ayarları", "Cài đặt runtime MCP cục bộ ezBuilder", "Pengaturan runtime MCP lokal ezBuilder", "การตั้งค่ารันไทม์ MCP ภายในของ ezBuilder", "إعدادات تشغيل MCP المحلي من ezBuilder", "ezBuilder स्थानीय MCP रनटाइम सेटिंग्स", "Налаштування локального MCP runtime ezBuilder"],
    "language": ["Language", "언어", "言語", "语言", "語言", "Idioma", "Langue", "Sprache", "Idioma", "Lingua", "Taal", "Język", "Язык", "Dil", "Ngôn ngữ", "Bahasa", "ภาษา", "اللغة", "भाषा", "Мова"],
    "projectFolder": ["Project folder", "프로젝트 폴더", "プロジェクトフォルダ", "项目文件夹", "專案資料夾", "Carpeta del proyecto", "Dossier du projet", "Projektordner", "Pasta do projeto", "Cartella progetto", "Projectmap", "Folder projektu", "Папка проекта", "Proje klasörü", "Thư mục dự án", "Folder proyek", "โฟลเดอร์โปรเจกต์", "مجلد المشروع", "प्रोजेक्ट फ़ोल्डर", "Тека проєкту"],
    "browse": ["Browse...", "찾아보기...", "参照...", "浏览...", "瀏覽...", "Examinar...", "Parcourir...", "Durchsuchen...", "Procurar...", "Sfoglia...", "Bladeren...", "Przeglądaj...", "Обзор...", "Gözat...", "Duyệt...", "Telusuri...", "เรียกดู...", "استعراض...", "ब्राउज़...", "Огляд..."],
    "launchAtLoginSetting": ["Launch app at login", "로그인 시 앱 실행", "ログイン時にアプリを起動", "登录时启动应用", "登入時啟動 App", "Iniciar la app al acceder", "Lancer l'app à la connexion", "App beim Anmelden starten", "Abrir app ao iniciar sessão", "Avvia app al login", "App starten bij inloggen", "Uruchamiaj aplikację przy logowaniu", "Запускать приложение при входе", "Girişte uygulamayı başlat", "Mở ứng dụng khi đăng nhập", "Jalankan app saat login", "เปิดแอปเมื่อเข้าสู่ระบบ", "تشغيل التطبيق عند تسجيل الدخول", "लॉगिन पर ऐप शुरू करें", "Запускати застосунок під час входу"],
    "startOnOpenSetting": ["Start MCP when the app opens", "앱 열 때 MCP 시작", "アプリ起動時に MCP を開始", "应用打开时启动 MCP", "App 開啟時啟動 MCP", "Iniciar MCP al abrir la app", "Démarrer MCP à l'ouverture", "MCP beim Öffnen der App starten", "Iniciar MCP ao abrir o app", "Avvia MCP all'apertura", "Start MCP bij openen", "Uruchamiaj MCP przy otwarciu aplikacji", "Запускать MCP при открытии приложения", "Uygulama açılınca MCP başlat", "Khởi động MCP khi mở ứng dụng", "Mulai MCP saat app dibuka", "เริ่ม MCP เมื่อเปิดแอป", "بدء MCP عند فتح التطبيق", "ऐप खुलने पर MCP शुरू करें", "Запускати MCP під час відкриття застосунку"],
    "multiProjectLanesSetting": ["Enable concurrent multi-project work", "여러 프로젝트 동시 작업 사용"],
    "showIntermediateCommentarySetting": ["Show intermediate work explanations (applies immediately)", "중간 작업 설명 표시 (즉시 적용)"],
    "autoUpdatesSetting": ["Auto check for updates", "업데이트 자동 확인", "更新を自動確認", "自动检查更新", "自動檢查更新", "Buscar actualizaciones automáticamente", "Recherche automatique des mises à jour", "Automatisch nach Updates suchen", "Verificar atualizações automaticamente", "Controlla aggiornamenti automaticamente", "Automatisch updates zoeken", "Automatycznie sprawdzaj aktualizacje", "Автоматически проверять обновления", "Güncellemeleri otomatik denetle", "Tự động kiểm tra cập nhật", "Periksa pembaruan otomatis", "ตรวจอัปเดตอัตโนมัติ", "التحقق التلقائي من التحديثات", "अपडेट अपने-आप जांचें", "Автоматично перевіряти оновлення"],
    "publicTunnelSetting": ["Enable ChatGPT web connector", "ChatGPT 웹 커넥터 사용", "ChatGPT Web コネクタを有効化", "启用 ChatGPT 网页连接器", "啟用 ChatGPT 網頁連接器", "Activar conector web de ChatGPT", "Activer le connecteur web ChatGPT", "ChatGPT-Web-Connector aktivieren", "Ativar conector web do ChatGPT", "Abilita connettore web ChatGPT", "ChatGPT-webconnector inschakelen", "Włącz konektor web ChatGPT", "Включить веб-коннектор ChatGPT", "ChatGPT web bağlayıcısını etkinleştir", "Bật trình kết nối web ChatGPT", "Aktifkan konektor web ChatGPT", "เปิดตัวเชื่อมต่อเว็บ ChatGPT", "تفعيل موصل ChatGPT على الويب", "ChatGPT वेब कनेक्टर चालू करें", "Увімкнути веб-конектор ChatGPT"],
    "publicHostname": ["Owned fixed domain (optional)", "본인 소유 고정 도메인 (선택)", "所有する固定ドメイン (任意)", "自有固定域名（可选）", "自有固定網域（選填）", "Dominio fijo propio (opcional)", "Domaine fixe personnel (facultatif)", "Eigene feste Domain (optional)", "Domínio fixo próprio (opcional)", "Dominio fisso personale (opzionale)", "Eigen vast domein (optioneel)", "Własna stała domena (opcjonalnie)", "Собственный постоянный домен (необязательно)", "Kendi sabit alan adınız (isteğe bağlı)", "Tên miền cố định của bạn (tùy chọn)", "Domain tetap milik Anda (opsional)", "โดเมนคงที่ของคุณ (ไม่บังคับ)", "نطاق ثابت تملكه (اختياري)", "अपना स्थिर डोमेन (वैकल्पिक)", "Власний сталий домен (необов'язково)"],
    "publicHostnameHint": ["Blank uses a temporary Quick Tunnel URL. It changes on restart, so reconnect ChatGPT. Enter your own Cloudflare Named Tunnel hostname for daily use.", "비워두면 임시 Quick Tunnel URL을 씁니다. 재시작하면 주소가 바뀌므로 ChatGPT를 다시 연결해야 합니다. 상시 사용은 본인 Cloudflare Named Tunnel 호스트명을 입력하세요.", "空欄なら一時 Quick Tunnel URL を使います。再起動で変わるため ChatGPT の再接続が必要です。常用は自分の Cloudflare Named Tunnel ホスト名を入力してください。", "留空会使用临时 Quick Tunnel URL。重启后会变化，需要重新连接 ChatGPT。日常使用请输入自己的 Cloudflare Named Tunnel 主机名。", "留空會使用臨時 Quick Tunnel URL。重新啟動後會變更，需重新連接 ChatGPT。日常使用請輸入自己的 Cloudflare Named Tunnel 主機名稱。", "En blanco usa una URL temporal de Quick Tunnel. Cambia al reiniciar; vuelve a conectar ChatGPT. Para uso diario escribe tu hostname de Cloudflare Named Tunnel.", "Vide, utilise une URL Quick Tunnel temporaire. Elle change au redémarrage; reconnectez ChatGPT. Pour l'usage quotidien, indiquez votre hôte Cloudflare Named Tunnel.", "Leer nutzt eine temporäre Quick-Tunnel-URL. Sie ändert sich beim Neustart; ChatGPT neu verbinden. Für Dauerbetrieb eigene Cloudflare-Named-Tunnel-Hostname eintragen.", "Em branco usa uma URL temporária Quick Tunnel. Ela muda ao reiniciar; reconecte o ChatGPT. Para uso diário, informe seu hostname Cloudflare Named Tunnel.", "Vuoto usa un URL Quick Tunnel temporaneo. Cambia al riavvio; riconnetti ChatGPT. Per l'uso quotidiano inserisci il tuo hostname Cloudflare Named Tunnel.", "Leeg gebruikt een tijdelijke Quick Tunnel-URL. Die wijzigt na herstart; verbind ChatGPT opnieuw. Voor dagelijks gebruik vul je je Cloudflare Named Tunnel-hostnaam in.", "Puste używa tymczasowego URL Quick Tunnel. Zmienia się po restarcie; połącz ChatGPT ponownie. Do codziennego użycia wpisz własny hostname Cloudflare Named Tunnel.", "Пусто — временный URL Quick Tunnel. Он меняется при перезапуске; подключите ChatGPT заново. Для постоянной работы укажите свой hostname Cloudflare Named Tunnel.", "Boşsa geçici Quick Tunnel URL kullanır. Yeniden başlatınca değişir; ChatGPT'yi yeniden bağlayın. Günlük kullanım için kendi Cloudflare Named Tunnel hostname'inizi girin.", "Để trống sẽ dùng URL Quick Tunnel tạm thời. URL đổi khi khởi động lại; hãy kết nối lại ChatGPT. Dùng hằng ngày thì nhập hostname Cloudflare Named Tunnel của bạn.", "Kosong memakai URL Quick Tunnel sementara. URL berubah saat restart; hubungkan ulang ChatGPT. Untuk harian, isi hostname Cloudflare Named Tunnel milik Anda.", "เว้นว่างเพื่อใช้ URL Quick Tunnel ชั่วคราว ซึ่งจะเปลี่ยนเมื่อรีสตาร์ต ต้องเชื่อมต่อ ChatGPT ใหม่ ใช้งานประจำให้ใส่ hostname Cloudflare Named Tunnel ของคุณ", "فارغ يعني استخدام رابط Quick Tunnel مؤقت. يتغير عند إعادة التشغيل؛ أعد ربط ChatGPT. للاستخدام اليومي أدخل اسم مضيف Cloudflare Named Tunnel الخاص بك.", "खाली रखने पर अस्थायी Quick Tunnel URL प्रयोग होगा। रीस्टार्ट पर बदलता है; ChatGPT फिर जोड़ें। रोज़ उपयोग के लिए अपना Cloudflare Named Tunnel hostname डालें।", "Порожньо — тимчасовий URL Quick Tunnel. Після перезапуску змінюється; підключіть ChatGPT знову. Для щоденного використання вкажіть свій hostname Cloudflare Named Tunnel."],
    "fixedDomainSetup": ["Setup...", "설정..."],
    "fixedDomainSetupTitle": ["Fixed domain setup", "고정 주소 설정"],
    "fixedDomainSetupInfo": ["1. Put your domain on Cloudflare DNS.\n2. In Cloudflare Zero Trust, create a Tunnel public hostname for this Mac.\n3. Route that hostname to http://127.0.0.1:%@.\n4. Enter the hostname here, save, restart MCP, then register https://%@/mcp in ChatGPT.\n\nIf you do not own a domain yet, leave this blank and use the temporary web connector first.", "1. 개인 도메인을 Cloudflare DNS에 연결하세요.\n2. Cloudflare Zero Trust에서 이 Mac용 Tunnel public hostname을 만드세요.\n3. 해당 hostname을 http://127.0.0.1:%@ 로 연결하세요.\n4. 여기에 hostname을 입력하고 저장한 뒤 MCP를 재시작하고, ChatGPT에는 https://%@/mcp 를 등록하세요.\n\n아직 도메인이 없으면 비워두고 임시 웹 커넥터부터 쓰면 됩니다."],
    "openCloudflare": ["Open Cloudflare", "Cloudflare 열기"],
    "copyFixedDomainSteps": ["Copy Steps", "단계 복사"],
    "fixedDomainStepsCopied": ["Fixed domain setup steps copied.", "고정 주소 설정 단계를 복사했습니다."],
    "localPort": ["Local port", "로컬 포트", "ローカルポート", "本地端口", "本機連接埠", "Puerto local", "Port local", "Lokaler Port", "Porta local", "Porta locale", "Lokale poort", "Port lokalny", "Локальный порт", "Yerel bağlantı noktası", "Cổng cục bộ", "Port lokal", "พอร์ตภายใน", "المنفذ المحلي", "स्थानीय पोर्ट", "Локальний порт"],
    "githubRepositoryURL": ["GitHub repository URL", "GitHub 저장소 URL", "GitHub リポジトリ URL", "GitHub 仓库 URL", "GitHub 儲存庫 URL", "URL del repositorio GitHub", "URL du dépôt GitHub", "GitHub-Repository-URL", "URL do repositório GitHub", "URL repository GitHub", "GitHub-repository-URL", "URL repozytorium GitHub", "URL репозитория GitHub", "GitHub depo URL'si", "URL kho GitHub", "URL repositori GitHub", "URL GitHub repository", "رابط مستودع GitHub", "GitHub रिपॉज़िटरी URL", "URL репозиторію GitHub"],
    "save": ["Save", "저장", "保存", "保存", "儲存", "Guardar", "Enregistrer", "Speichern", "Salvar", "Salva", "Opslaan", "Zapisz", "Сохранить", "Kaydet", "Lưu", "Simpan", "บันทึก", "حفظ", "सहेजें", "Зберегти"],
    "cancel": ["Cancel", "취소", "キャンセル", "取消", "取消", "Cancelar", "Annuler", "Abbrechen", "Cancelar", "Annulla", "Annuleren", "Anuluj", "Отмена", "İptal", "Hủy", "Batal", "ยกเลิก", "إلغاء", "रद्द करें", "Скасувати"],
    "ok": ["OK", "확인", "OK", "确定", "確定", "Aceptar", "OK", "OK", "OK", "OK", "OK", "OK", "OK", "Tamam", "OK", "OK", "ตกลง", "موافق", "ठीक है", "OK"],
    "close": ["Close", "닫기", "閉じる", "关闭", "關閉", "Cerrar", "Fermer", "Schließen", "Fechar", "Chiudi", "Sluiten", "Zamknij", "Закрыть", "Kapat", "Đóng", "Tutup", "ปิด", "إغلاق", "बंद करें", "Закрити"],
    "updatesTitle": ["ChatGPT To Codex Updates", "ChatGPT To Codex 업데이트", "ChatGPT To Codex 更新", "ChatGPT To Codex 更新", "ChatGPT To Codex 更新", "Actualizaciones de ChatGPT To Codex", "Mises à jour ChatGPT To Codex", "ChatGPT To Codex Updates", "Atualizações do ChatGPT To Codex", "Aggiornamenti ChatGPT To Codex", "ChatGPT To Codex updates", "Aktualizacje ChatGPT To Codex", "Обновления ChatGPT To Codex", "ChatGPT To Codex güncellemeleri", "Cập nhật ChatGPT To Codex", "Pembaruan ChatGPT To Codex", "อัปเดต ChatGPT To Codex", "تحديثات ChatGPT To Codex", "ChatGPT To Codex अपडेट", "Оновлення ChatGPT To Codex"],
    "openReleases": ["Open Releases", "릴리즈 열기", "リリースを開く", "打开发布页", "開啟發行頁", "Abrir releases", "Ouvrir les versions", "Releases öffnen", "Abrir releases", "Apri release", "Releases openen", "Otwórz wydania", "Открыть релизы", "Sürümleri aç", "Mở bản phát hành", "Buka rilis", "เปิด releases", "فتح الإصدارات", "रिलीज़ खोलें", "Відкрити релізи"],
    "openGithubButton": ["Open GitHub", "GitHub 열기", "GitHub を開く", "打开 GitHub", "開啟 GitHub", "Abrir GitHub", "Ouvrir GitHub", "GitHub öffnen", "Abrir GitHub", "Apri GitHub", "GitHub openen", "Otwórz GitHub", "Открыть GitHub", "GitHub'u aç", "Mở GitHub", "Buka GitHub", "เปิด GitHub", "فتح GitHub", "GitHub खोलें", "Відкрити GitHub"],
    "aboutTitle": ["ChatGPT To Codex by ezBuilder", "ezBuilder의 ChatGPT To Codex", "ezBuilder による ChatGPT To Codex", "ezBuilder 出品 ChatGPT To Codex", "ezBuilder 製作 ChatGPT To Codex", "ChatGPT To Codex de ezBuilder", "ChatGPT To Codex par ezBuilder", "ChatGPT To Codex von ezBuilder", "ChatGPT To Codex por ezBuilder", "ChatGPT To Codex di ezBuilder", "ChatGPT To Codex door ezBuilder", "ChatGPT To Codex od ezBuilder", "ChatGPT To Codex от ezBuilder", "ezBuilder tarafından ChatGPT To Codex", "ChatGPT To Codex bởi ezBuilder", "ChatGPT To Codex oleh ezBuilder", "ChatGPT To Codex โดย ezBuilder", "ChatGPT To Codex من ezBuilder", "ezBuilder द्वारा ChatGPT To Codex", "ChatGPT To Codex від ezBuilder"],
    "aboutInfo": ["Copyright 2026 ezBuilder. All rights reserved.\nLocal MCP runtime for ChatGPT, Codex-compatible agents, and trusted local projects.", "Copyright 2026 ezBuilder. All rights reserved.\nChatGPT, Codex 호환 에이전트, 신뢰한 로컬 프로젝트를 위한 로컬 MCP 런타임입니다.", "Copyright 2026 ezBuilder. All rights reserved.\nChatGPT、Codex 互換エージェント、信頼済みローカルプロジェクト向けのローカル MCP ランタイムです。", "Copyright 2026 ezBuilder. All rights reserved.\n面向 ChatGPT、Codex 兼容代理和受信任本地项目的本地 MCP 运行时。", "Copyright 2026 ezBuilder. All rights reserved.\n供 ChatGPT、Codex 相容代理與受信任本機專案使用的本機 MCP 執行階段。", "Copyright 2026 ezBuilder. All rights reserved.\nRuntime MCP local para ChatGPT, agentes compatibles con Codex y proyectos locales de confianza.", "Copyright 2026 ezBuilder. All rights reserved.\nRuntime MCP local pour ChatGPT, agents compatibles Codex et projets locaux fiables.", "Copyright 2026 ezBuilder. All rights reserved.\nLokale MCP-Laufzeit für ChatGPT, Codex-kompatible Agents und vertrauenswürdige lokale Projekte.", "Copyright 2026 ezBuilder. All rights reserved.\nRuntime MCP local para ChatGPT, agentes compatíveis com Codex e projetos locais confiáveis.", "Copyright 2026 ezBuilder. All rights reserved.\nRuntime MCP locale per ChatGPT, agent compatibili con Codex e progetti locali attendibili.", "Copyright 2026 ezBuilder. All rights reserved.\nLokale MCP-runtime voor ChatGPT, Codex-compatibele agents en vertrouwde lokale projecten.", "Copyright 2026 ezBuilder. All rights reserved.\nLokalny runtime MCP dla ChatGPT, agentów zgodnych z Codex i zaufanych projektów lokalnych.", "Copyright 2026 ezBuilder. All rights reserved.\nЛокальная среда MCP для ChatGPT, Codex-совместимых агентов и доверенных локальных проектов.", "Copyright 2026 ezBuilder. All rights reserved.\nChatGPT, Codex uyumlu ajanlar ve güvenilir yerel projeler için yerel MCP çalışma zamanı.", "Copyright 2026 ezBuilder. All rights reserved.\nRuntime MCP cục bộ cho ChatGPT, tác nhân tương thích Codex và dự án cục bộ tin cậy.", "Copyright 2026 ezBuilder. All rights reserved.\nRuntime MCP lokal untuk ChatGPT, agen kompatibel Codex, dan proyek lokal tepercaya.", "Copyright 2026 ezBuilder. All rights reserved.\nรันไทม์ MCP ภายในสำหรับ ChatGPT, เอเจนต์ที่เข้ากันได้กับ Codex และโปรเจกต์ภายในที่เชื่อถือได้", "Copyright 2026 ezBuilder. All rights reserved.\nتشغيل MCP المحلي لـ ChatGPT والوكلاء المتوافقين مع Codex والمشاريع المحلية الموثوقة.", "Copyright 2026 ezBuilder. All rights reserved.\nChatGPT, Codex-संगत एजेंट और भरोसेमंद स्थानीय प्रोजेक्ट के लिए स्थानीय MCP रनटाइम।", "Copyright 2026 ezBuilder. All rights reserved.\nЛокальний runtime MCP для ChatGPT, Codex-сумісних агентів і довірених локальних проєктів."],
    "updatePageReady": ["Update page is ready.", "업데이트 페이지를 열 수 있습니다.", "更新ページを開けます。", "更新页面已准备好。", "更新頁面已就緒。", "La página de actualizaciones está lista.", "La page des mises à jour est prête.", "Die Update-Seite ist bereit.", "A página de atualizações está pronta.", "La pagina aggiornamenti è pronta.", "De updatepagina is klaar.", "Strona aktualizacji jest gotowa.", "Страница обновлений готова.", "Güncelleme sayfası hazır.", "Trang cập nhật đã sẵn sàng.", "Halaman pembaruan siap.", "หน้าการอัปเดตพร้อมแล้ว", "صفحة التحديث جاهزة.", "अपडेट पेज तैयार है।", "Сторінка оновлень готова."],
    "updateCheckFailed": ["Could not check releases automatically. Open the releases page instead.", "릴리즈를 자동 확인하지 못했습니다. 릴리즈 페이지를 여세요.", "リリースを自動確認できませんでした。リリースページを開いてください。", "无法自动检查发布。请打开发布页面。", "無法自動檢查發行版。請開啟發行頁。", "No se pudieron comprobar releases automáticamente. Abre la página de releases.", "Impossible de vérifier les versions automatiquement. Ouvrez la page des versions.", "Releases konnten nicht automatisch geprüft werden. Öffne die Releases-Seite.", "Não foi possível verificar releases automaticamente. Abra a página de releases.", "Impossibile controllare le release automaticamente. Apri la pagina release.", "Kan releases niet automatisch controleren. Open de releases-pagina.", "Nie można automatycznie sprawdzić wydań. Otwórz stronę wydań.", "Не удалось автоматически проверить релизы. Откройте страницу релизов.", "Sürümler otomatik denetlenemedi. Sürümler sayfasını açın.", "Không thể tự động kiểm tra bản phát hành. Hãy mở trang phát hành.", "Tidak dapat memeriksa rilis otomatis. Buka halaman rilis.", "ตรวจสอบ releases อัตโนมัติไม่ได้ ให้เปิดหน้า releases", "تعذر التحقق من الإصدارات تلقائيا. افتح صفحة الإصدارات.", "रिलीज़ अपने-आप नहीं जांच सके। रिलीज़ पेज खोलें।", "Не вдалося автоматично перевірити релізи. Відкрийте сторінку релізів."],
    "upToDate": ["ChatGPT To Codex is up to date (%@).", "ChatGPT To Codex가 최신입니다 (%@).", "ChatGPT To Codex は最新です (%@)。", "ChatGPT To Codex 已是最新版本（%@）。", "ChatGPT To Codex 已是最新版本（%@）。", "ChatGPT To Codex está actualizado (%@).", "ChatGPT To Codex est à jour (%@).", "ChatGPT To Codex ist aktuell (%@).", "ChatGPT To Codex está atualizado (%@).", "ChatGPT To Codex è aggiornato (%@).", "ChatGPT To Codex is up-to-date (%@).", "ChatGPT To Codex jest aktualny (%@).", "ChatGPT To Codex обновлен (%@).", "ChatGPT To Codex güncel (%@).", "ChatGPT To Codex đã mới nhất (%@).", "ChatGPT To Codex sudah terbaru (%@).", "ChatGPT To Codex เป็นเวอร์ชันล่าสุด (%@)", "ChatGPT To Codex محدث (%@).", "ChatGPT To Codex अप टू डेट है (%@)।", "ChatGPT To Codex оновлено (%@)."],
    "updateAvailable": ["Update available: %@. Installed: %@.", "업데이트 가능: %@. 설치됨: %@.", "更新があります: %@。インストール済み: %@。", "有可用更新：%@。已安装：%@。", "有可用更新：%@。已安裝：%@。", "Actualización disponible: %@. Instalado: %@.", "Mise à jour disponible : %@. Installé : %@.", "Update verfügbar: %@. Installiert: %@.", "Atualização disponível: %@. Instalado: %@.", "Aggiornamento disponibile: %@. Installato: %@.", "Update beschikbaar: %@. Geïnstalleerd: %@.", "Dostępna aktualizacja: %@. Zainstalowano: %@.", "Доступно обновление: %@. Установлено: %@.", "Güncelleme var: %@. Kurulu: %@.", "Có bản cập nhật: %@. Đã cài: %@.", "Pembaruan tersedia: %@. Terpasang: %@.", "มีอัปเดต: %@ ติดตั้งอยู่: %@", "يتوفر تحديث: %@. المثبت: %@.", "अपडेट उपलब्ध: %@. इंस्टॉल: %@.", "Доступне оновлення: %@. Встановлено: %@."],
    "installRuntimeUpdate": ["Apply Runtime Update", "런타임 업데이트 적용"],
    "updateDownloading": ["Downloading and verifying the update...", "업데이트를 다운로드하고 서명을 확인하는 중..."],
    "updateRuntimeExplanation": ["The MCP runtime will restart briefly while the macOS app and Cloudflare tunnel stay running. The connector URL should not change. Native app UI changes take effect after the next app launch.", "macOS 앱과 Cloudflare 터널은 유지한 채 MCP 런타임만 잠깐 재시작합니다. 커넥터 URL은 바뀌지 않습니다. 네이티브 앱 UI 변경은 다음 앱 실행 때 반영됩니다."],
    "updateApplyFailed": ["Runtime update failed", "런타임 업데이트 실패"],
    "updateApplyComplete": ["Runtime update complete", "런타임 업데이트 완료"]
]

private func resolveDesktopLanguage(_ configured: String?) -> String {
    let raw = configured == nil || configured == "auto" ? (Locale.preferredLanguages.first ?? "en") : configured!
    let lower = raw.lowercased()
    if lower.hasPrefix("zh-hant") || lower.hasPrefix("zh-tw") || lower.hasPrefix("zh-hk") || lower.hasPrefix("zh-mo") {
        return "zh-Hant"
    }
    if lower.hasPrefix("zh") {
        return "zh-Hans"
    }
    if lower.hasPrefix("pt") {
        return "pt-BR"
    }
    for code in desktopLanguageCodes {
        let exact = code.lowercased()
        let prefix = exact.split(separator: "-").first.map(String.init) ?? exact
        if lower == exact || lower.hasPrefix(prefix + "-") {
            return code
        }
    }
    return "en"
}

private func localizedText(_ key: String, language: String) -> String {
    guard let row = desktopLocalizationRows[key],
          let index = desktopLanguageCodes.firstIndex(of: language),
          index < row.count,
          !row[index].isEmpty
    else {
        return desktopLocalizationRows[key]?.first ?? key
    }
    let value = row[index]
    return key == "checkUpdates" ? value.replacingOccurrences(of: "...", with: "").replacingOccurrences(of: "…", with: "") : value
}

private final class ServiceController {
    enum OwnerTokenStatus: Equatable {
        case configured
        case missing
        case checkFailed
    }

    private let environment = ProcessInfo.processInfo.environment
    private let defaults = UserDefaults.standard
    private let selectedProjectFolderKey = "selectedProjectFolder"
    private let additionalWorkspaceRootsKey = "additionalWorkspaceRoots"
    private let publicHostnameKey = "publicHostname"
    private let tunnelModeKey = "tunnelMode"
    private let cloudflaredTunnelNameKey = "cloudflaredTunnelName"
    private let enablePublicTunnelKey = "enablePublicTunnel"
    private let portKey = "port"
    private let launchAtLoginKey = "launchAtLogin"
    private let startMCPOnLaunchKey = "startMCPOnLaunch"
    private let multiProjectLanesEnabledKey = "multiProjectLanesEnabled"
    private let showIntermediateCommentaryKey = "showIntermediateCommentary"
    private let autoCheckUpdatesKey = "autoCheckUpdates"
    private let appliedRuntimeVersionKey = "appliedRuntimeVersion"
    private(set) var process: Process?
    private var chatGptRemoteControlSessionOverride: Bool?
    private var activeScreenshotRequestIds = Set<String>()
    private var screenshotCompletionBodies: [String: [String: Any]] = [:]
    private var activeAccessibilityBridgeRequestIds = Set<String>()
    private var accessibilityBridgeCompletionBodies: [String: [String: Any]] = [:]
    private var accessibilityBridgePollInFlight = false
    private let accessibilityBridgeExecutionQueue = DispatchQueue(label: "dev.chatgpttocodex.accessibility-bridge", qos: .userInitiated)

    let appName = "ChatGPT To Codex"
    let defaultWorkspace: String
    let runtimeRoot: URL
    let logFile: URL
    let connectionDiagnosticsFile: URL

    var appVersion: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        return short?.isEmpty == false ? short! : (build?.isEmpty == false ? build! : "0.0.0")
    }

    private var effectiveRuntimeRoot: URL {
        let pointer = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/share/chatgpt2codex/active-runtime")
        guard let value = try? String(contentsOf: pointer, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty
        else {
            return runtimeRoot
        }
        let candidate = URL(fileURLWithPath: value)
        return FileManager.default.fileExists(
            atPath: candidate.appendingPathComponent("dist/cli.js").path
        ) ? candidate : runtimeRoot
    }

    init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        defaultWorkspace = environment["CHATGPT2CODEX_WORKSPACE"] ?? "\(home)/workspace"

        if let developmentRoot = Bundle.main.object(forInfoDictionaryKey: "ChatGPT2CodexRuntimeRoot") as? String,
           FileManager.default.fileExists(atPath: URL(fileURLWithPath: developmentRoot).appendingPathComponent("start-chatgpt.sh").path) {
            runtimeRoot = URL(fileURLWithPath: developmentRoot)
        } else if let resourceRoot = Bundle.main.resourceURL?.appendingPathComponent("chatgpt2codex"),
           FileManager.default.fileExists(atPath: resourceRoot.appendingPathComponent("start-chatgpt.sh").path) {
            runtimeRoot = resourceRoot
        } else {
            runtimeRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        }

        let logDir = URL(fileURLWithPath: home)
            .appendingPathComponent("Library")
            .appendingPathComponent("Logs")
            .appendingPathComponent(appName)
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        logFile = logDir.appendingPathComponent("chatgpt2codex.log")
        connectionDiagnosticsFile = URL(fileURLWithPath: home)
            .appendingPathComponent(".local")
            .appendingPathComponent("share")
            .appendingPathComponent("chatgpt2codex")
            .appendingPathComponent("connection-events.jsonl")
    }

    var port: Int {
        if let envPort = environment["CHATGPT2CODEX_PORT"], let value = Int(envPort) {
            return value
        }
        let saved = defaults.integer(forKey: portKey)
        return saved > 0 ? saved : 7979
    }

    var publicHost: String? {
        let configuredHost = environment["CHATGPT2CODEX_PUBLIC_HOSTNAME"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        if configuredHost?.isEmpty == false {
            return configuredHost
        }
        guard enablePublicTunnel else { return nil }
        return savedPublicHost
    }

    var savedPublicHost: String? {
        let savedHost = defaults.string(forKey: publicHostnameKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return savedHost?.isEmpty == false ? savedHost : nil
    }

    var cloudflaredTunnelName: String? {
        let configured = environment["CLOUDFLARED_TUNNEL_NAME"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        if configured?.isEmpty == false {
            return configured
        }
        let saved = defaults.string(forKey: cloudflaredTunnelNameKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return saved?.isEmpty == false ? saved : nil
    }

    var tunnelMode: String {
        if let configured = environment["CHATGPT2CODEX_TUNNEL_MODE"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
           ["loopback", "cloudflare-quick", "cloudflare-named", "external"].contains(configured) {
            return configured
        }
        if environment["CHATGPT2CODEX_PUBLIC_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            return "external"
        }
        if environment["CLOUDFLARED_TUNNEL_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false || cloudflaredTunnelName != nil {
            return "cloudflare-named"
        }
        if let saved = defaults.string(forKey: tunnelModeKey),
           ["loopback", "cloudflare-quick", "cloudflare-named", "external"].contains(saved) {
            return saved
        }
        if let value = publicHost?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
            let lower = value.lowercased()
            if lower.hasPrefix("https://") || (lower.hasSuffix(".ts.net") && !lower.contains("/") && !lower.contains("@")) {
                return "external"
            }
            return "cloudflare-named"
        }
        return enablePublicTunnel ? "cloudflare-quick" : "loopback"
    }

    private var externalPublicBaseURL: URL? {
        guard tunnelMode == "external" else { return nil }
        let configuredUrl = environment["CHATGPT2CODEX_PUBLIC_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let raw = configuredUrl?.isEmpty == false ? configuredUrl! : (publicHost ?? "")
        let candidate = raw.lowercased().hasPrefix("https://") ? raw : "https://\(raw)"
        guard var components = URLComponents(string: candidate),
              let rawHost = components.host
        else { return nil }
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]."))
        guard components.scheme?.lowercased() == "https",
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              !host.isEmpty,
              host != "localhost",
              !host.hasSuffix(".localhost"),
              host != "::1",
              !host.hasPrefix("127."),
              host != "0.0.0.0"
        else { return nil }
        components.path = ""
        return components.url
    }

    var enablePublicTunnel: Bool {
        if environment["CHATGPT2CODEX_EXPOSE_WEB"] == "1" { return true }
        if let mode = environment["CHATGPT2CODEX_TUNNEL_MODE"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
           ["cloudflare-quick", "cloudflare-named", "external"].contains(mode) { return true }
        if environment["CHATGPT2CODEX_PUBLIC_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false { return true }
        if environment["CHATGPT2CODEX_PUBLIC_HOSTNAME"]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            return true
        }
        return defaults.bool(forKey: enablePublicTunnelKey)
    }

    var launchAtLogin: Bool {
        defaults.bool(forKey: launchAtLoginKey)
    }

    var startMCPOnLaunch: Bool {
        defaults.bool(forKey: startMCPOnLaunchKey)
    }

    var multiProjectLanesEnabled: Bool {
        if environment["CHATGPT2CODEX_MULTI_PROJECT_LANES"] == "0" { return false }
        if environment["CHATGPT2CODEX_MULTI_PROJECT_LANES"] == "1" { return true }
        if defaults.object(forKey: multiProjectLanesEnabledKey) != nil {
            return defaults.bool(forKey: multiProjectLanesEnabledKey)
        }
        return true
    }

    var chatGptRemoteControlEnabled: Bool {
        if let chatGptRemoteControlSessionOverride {
            return chatGptRemoteControlSessionOverride
        }
        if let configured = environment["CHATGPT2CODEX_CONTROL_CHATGPT"] {
            return configured == "1"
        }
        return false
    }

    var showIntermediateCommentary: Bool {
        if let configured = environment["CHATGPT2CODEX_SHOW_INTERMEDIATE_COMMENTARY"] {
            return configured == "1"
        }
        return defaults.bool(forKey: showIntermediateCommentaryKey)
    }

    var autoCheckUpdates: Bool {
        defaults.bool(forKey: autoCheckUpdatesKey)
    }

    var githubRepoURL: URL {
        let configured = environment["CHATGPT2CODEX_UPDATE_REPO_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        return URL(string: configured?.isEmpty == false ? configured! : "https://github.com/ezBuilder/chatgpt2codex")!
    }

    var preferredLanguage: String {
        defaults.string(forKey: preferredLanguageKey) ?? "auto"
    }

    var effectiveLanguageCode: String {
        resolveDesktopLanguage(preferredLanguage)
    }

    func localized(_ key: String) -> String {
        localizedText(key, language: effectiveLanguageCode)
    }

    var screenRecordingAllowed: Bool {
        if #available(macOS 10.15, *) {
            return CGPreflightScreenCaptureAccess()
        }
        return true
    }

    func shouldPromptForScreenRecordingPermission() -> Bool {
        if screenRecordingAllowed { return false }
        let lastShown = defaults.double(forKey: screenRecordingPromptLastShownKey)
        return lastShown == 0 || Date().timeIntervalSince1970 - lastShown > 86_400
    }

    func markScreenRecordingPromptShown() {
        defaults.set(Date().timeIntervalSince1970, forKey: screenRecordingPromptLastShownKey)
    }

    func requestScreenRecordingPermission() -> Bool {
        if #available(macOS 10.15, *) {
            return CGRequestScreenCaptureAccess()
        }
        return true
    }

    func openScreenRecordingSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    /// Whether Option B desktop control is enabled at all, mirroring
    /// src/control/policy.ts isControlEnabled(). Enabled by default (even
    /// with no environment configured, e.g. launched via `open`); set
    /// CHATGPT2CODEX_CONTROL to "0"/"false"/"off" (case-insensitive) to opt
    /// out. This environment is also what launchServer()/runDoctor() forward
    /// to the managed `chatgpt2codex serve` subprocess, so this check tracks
    /// exactly what the subprocess itself would see.
    var controlEnabled: Bool {
        guard let raw = environment["CHATGPT2CODEX_CONTROL"] else { return true }
        let normalized = raw.trimmingCharacters(in: .whitespaces).lowercased()
        return normalized != "0" && normalized != "false" && normalized != "off"
    }

    var accessibilityTrusted: Bool {
        AXIsProcessTrusted()
    }

    /// Prompts the user via the system Accessibility-permission dialog
    /// (kAXTrustedCheckOptionPrompt). Returns the trust state at call time.
    @discardableResult
    func requestAccessibilityPermission() -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    func openAccessibilitySettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    struct PendingControlAction {
        let actionId: String
        let appName: String
        let kind: String
        let targetSummary: String
        /// Human-readable dry-run AX resolve preview (src/control/queue.ts
        /// ResolvedTargetPreview), or nil when the target has no `ax` field.
        /// Always safe to display: never contains the raw `text` payload.
        let resolvedSummary: String?
    }

    struct ActiveSessionSummary {
        let label: String
        let conversationLabel: String?
        let clientName: String?
        let connectedAt: Int
        let lastActiveAt: Int
        let state: String
        let operationId: String?
        let tool: String?
        let startedAt: Int?
        let finishedAt: Int?
        let elapsedMs: Int
        let phase: String?
        let message: String?
        let lastProgressAt: Int?
        let clientCancellationObservedAt: Int?
        let operationContinuesAfterCancellation: Bool
    }

    struct ConversationOperationSummary {
        let operationId: String
        let tool: String
        let state: String
        let startedAt: Int
        let finishedAt: Int?
        let elapsedMs: Int
        let phase: String?
        let message: String?
        let activityHint: String?
        let lastProgressAt: Int?
    }

    struct ConversationActivityHighlight {
        let kind: String
        let state: String
        let startedAt: Int
        let finishedAt: Int?
    }

    struct ConversationSummary {
        let label: String
        let taskLabel: String?
        let displayTitle: String?
        let firstSeenAt: Int
        let lastActiveAt: Int
        let state: String
        let dashboardVisibleUntil: Int?
        let activityHighlights: [ConversationActivityHighlight]
        let operations: [ConversationOperationSummary]
    }

    struct ClientCancellationRecovery {
        let operationId: String?
        let state: String
        let automaticRetrySafe: Bool
        let recommendedAction: String
    }

    struct PendingArmRequest {
        let requestId: String
        let projectName: String
        let clientLabel: String
        let reason: String
        let createdAt: TimeInterval
        let expiresAt: TimeInterval
    }

    struct PendingOperationApproval {
        let requestId: String
        let projectId: String
        let tool: String
        let risk: String
        let preview: String
        let createdAt: TimeInterval
        let expiresAt: TimeInterval
    }

    struct PendingRgRequest {
        let requestId: String
        let projectId: String
        let queryPreview: String
        let patternMode: String
        let caseSensitive: Bool
        let maxResults: Int
        let binaryPath: String
        let binaryVersion: String
        let binarySha256: String
        let createdAt: TimeInterval
        let expiresAt: TimeInterval
    }

    struct RgCapabilitySnapshot {
        let preference: String
        let binaryAvailable: Bool
        let binaryPath: String?
        let binaryVersion: String?
        let binarySha256: String?
        let unavailableReason: String?
        let pendingRequests: [PendingRgRequest]
    }

    struct LocalControlSnapshot {
        struct ProjectSummary {
            let projectId: String
            let name: String
        }

        struct LeaseSummary {
            let preset: String
            let expiresAt: TimeInterval
            let active: Bool
        }

        let project: ProjectSummary?
        let lease: LeaseSummary?
        let armed: Bool
        let killed: Bool
        let pendingActions: [PendingControlAction]
        let pendingArmRequests: [PendingArmRequest]
        let operationApprovals: [PendingOperationApproval]
        let autoEnabled: Bool
        let autoRemainingMs: Int
        let allowlistedAppCount: Int
        let sessions: [ActiveSessionSummary]
        let conversations: [ConversationSummary]
        let clientCancellationRecovery: ClientCancellationRecovery?
        let rg: RgCapabilitySnapshot
    }

    private func summarizeControlTarget(_ target: [String: Any]?) -> String {
        guard let target else { return "" }
        if let ax = target["ax"] as? [String: Any] {
            let role = ax["role"] as? String ?? "element"
            if let label = (ax["title"] as? String) ?? (ax["label"] as? String), !label.isEmpty {
                return "\(role) \"\(label)\""
            }
            return role
        }
        if let point = target["windowPoint"] as? [String: Any],
           let xRel = point["xRel"] as? Double, let yRel = point["yRel"] as? Double {
            return String(format: "point (%.2f, %.2f)", xRel, yRel)
        }
        return ""
    }

    /// Renders the read-only AX resolve preview (src/control/queue.ts
    /// ResolvedTargetPreview / src/control/mac-input.ts resolveAxElement) as
    /// a human sentence for the approval UI, e.g. "Will act on button
    /// \"Send\" at (120, 340, 80, 24) in Slack/Message a channel, 1 match" or
    /// "No accessibility match found (empty/opt-out AX tree) - expect a
    /// windowPoint fallback" when resolve failed.
    private func summarizeResolvedPreview(_ resolved: [String: Any]?) -> String? {
        guard let resolved else { return nil }
        let found = resolved["found"] as? Bool ?? false
        guard found else {
            let reason = resolved["reason"] as? String ?? "not found"
            return "No accessibility match found (\(reason)) — expect a windowPoint fallback"
        }
        let role = resolved["role"] as? String ?? "element"
        let label = (resolved["title"] as? String) ?? (resolved["description"] as? String)
        var target = label.map { "\(role) \"\($0)\"" } ?? role
        if let frame = resolved["frame"] as? [String: Any],
           let x = frame["x"] as? Double, let y = frame["y"] as? Double,
           let w = frame["width"] as? Double, let h = frame["height"] as? Double {
            target += String(format: " at (%.0f, %.0f, %.0f, %.0f)", x, y, w, h)
        }
        var location = ""
        if let app = resolved["app"] as? String { location = app }
        if let window = resolved["window"] as? String, !window.isEmpty {
            location = location.isEmpty ? window : "\(location)/\(window)"
        }
        if !location.isEmpty { target += " in \(location)" }
        if let matchCount = resolved["matchCount"] as? Int {
            target += ", \(matchCount) match\(matchCount == 1 ? "" : "es")"
        }
        return "Will act on \(target)"
    }

    private var localControlTokenURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/share/chatgpt2codex/local-control-token")
    }

    private func localControlToken() -> String? {
        guard let value = try? String(contentsOf: localControlTokenURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty
        else { return nil }
        return value
    }

    private func localControlRequest(
        _ path: String,
        method: String = "GET",
        jsonBody: [String: Any]? = nil,
        completion: @escaping (Data?, Bool) -> Void
    ) {
        guard let token = localControlToken(),
              let url = URL(string: "http://127.0.0.1:\(port)/local-control/v1\(path)")
        else {
            DispatchQueue.main.async { completion(nil, false) }
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 1.5
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let jsonBody = jsonBody {
            request.httpBody = try? JSONSerialization.data(withJSONObject: jsonBody)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        URLSession.shared.dataTask(with: request) { data, response, error in
            let ok = error == nil && (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { completion(data, ok) }
        }.resume()
    }

    private func postScreenshotCompletion(_ requestId: String, body: [String: Any]) {
        screenshotCompletionBodies[requestId] = body
        localControlRequest(
            "/screenshot-capture/\(requestId)/complete",
            method: "POST",
            jsonBody: body
        ) { [weak self] _, ok in
            guard let self else { return }
            self.activeScreenshotRequestIds.remove(requestId)
            if ok {
                self.screenshotCompletionBodies.removeValue(forKey: requestId)
            }
        }
    }

    private func postAccessibilityBridgeCompletion(_ requestId: String, body: [String: Any]) {
        accessibilityBridgeCompletionBodies[requestId] = body
        localControlRequest(
            "/accessibility-bridge/\(requestId)/complete",
            method: "POST",
            jsonBody: body
        ) { [weak self] _, ok in
            guard let self else { return }
            self.activeAccessibilityBridgeRequestIds.remove(requestId)
            if ok {
                self.accessibilityBridgeCompletionBodies.removeValue(forKey: requestId)
            }
        }
    }

    private func handleAccessibilityBridgeRequest(_ entry: [String: Any]) {
        guard let requestId = entry["requestId"] as? String,
              requestId.hasPrefix("ax_"),
              requestId.count <= 80,
              entry["kind"] is String
        else { return }

        if let body = accessibilityBridgeCompletionBodies[requestId] {
            postAccessibilityBridgeCompletion(requestId, body: body)
            return
        }
        guard !activeAccessibilityBridgeRequestIds.contains(requestId) else { return }
        activeAccessibilityBridgeRequestIds.insert(requestId)

        accessibilityBridgeExecutionQueue.async { [weak self] in
            let body = MenuBarAccessibilityBridge.execute(entry)
            DispatchQueue.main.async {
                self?.postAccessibilityBridgeCompletion(requestId, body: body)
            }
        }
    }

    func pollAccessibilityBridgeRequests() {
        guard controlEnabled, !accessibilityBridgePollInFlight else { return }
        accessibilityBridgePollInFlight = true
        localControlRequest("/accessibility-bridge/pending") { [weak self] data, ok in
            guard let self else { return }
            self.accessibilityBridgePollInFlight = false
            guard ok, let data,
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let pending = root["pendingRequests"] as? [[String: Any]]
            else { return }
            for entry in pending.prefix(8) {
                self.handleAccessibilityBridgeRequest(entry)
            }
        }
    }

    @available(macOS 14.0, *)
    private func captureScreenshotImage(_ requestedRect: CGRect?) async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let display = requestedRect.flatMap { rect in
            content.displays.first { $0.frame.intersects(rect) }
        } ?? content.displays.first
        guard let display else {
            throw NSError(
                domain: "ChatGPTToCodexScreenshot",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No on-screen display is available for capture"]
            )
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = false

        if let requestedRect {
            let clipped = requestedRect.intersection(display.frame)
            guard !clipped.isNull, !clipped.isEmpty else {
                throw NSError(
                    domain: "ChatGPTToCodexScreenshot",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Requested screenshot region does not intersect the selected display"]
                )
            }
            let sourceRect = CGRect(
                x: clipped.minX - display.frame.minX,
                y: clipped.minY - display.frame.minY,
                width: clipped.width,
                height: clipped.height
            )
            configuration.sourceRect = sourceRect
            let scale = CGFloat(display.width) / max(display.frame.width, 1)
            configuration.width = max(1, Int((sourceRect.width * scale).rounded()))
            configuration.height = max(1, Int((sourceRect.height * scale).rounded()))
        } else {
            configuration.width = display.width
            configuration.height = display.height
        }

        return try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
    }

    private func handleScreenshotCaptureRequest(_ entry: [String: Any]) {
        guard let requestId = entry["requestId"] as? String,
              requestId.hasPrefix("shot_"),
              requestId.count <= 80,
              let outputPath = entry["outputPath"] as? String
        else { return }

        if let body = screenshotCompletionBodies[requestId] {
            postScreenshotCompletion(requestId, body: body)
            return
        }
        guard !activeScreenshotRequestIds.contains(requestId) else { return }
        activeScreenshotRequestIds.insert(requestId)

        let outputURL = URL(fileURLWithPath: outputPath).standardizedFileURL
        guard outputURL.path.contains("/.chatgpt2codex/e2e/screenshots/"),
              outputURL.path.hasSuffix(".png")
        else {
            postScreenshotCompletion(requestId, body: ["ok": false, "error": "invalid-screenshot-output-path"])
            return
        }

        var captureRect: CGRect? = nil
        if let region = entry["region"] as? String {
            let parts = region.split(separator: ",").compactMap {
                Double($0.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            guard parts.count == 4, parts[2] > 0, parts[3] > 0 else {
                postScreenshotCompletion(requestId, body: ["ok": false, "error": "invalid-screenshot-region"])
                return
            }
            captureRect = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
        }

        guard screenRecordingAllowed else {
            postScreenshotCompletion(requestId, body: ["ok": false, "error": "screen-recording-not-authorized"])
            return
        }

        guard #available(macOS 14.0, *) else {
            postScreenshotCompletion(requestId, body: ["ok": false, "error": "screen-capturekit-unavailable"])
            return
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let image = try await self.captureScreenshotImage(captureRect)
                guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
                    self.postScreenshotCompletion(requestId, body: ["ok": false, "error": "screen-capture-encoding-failed"])
                    return
                }
                try FileManager.default.createDirectory(
                    at: outputURL.deletingLastPathComponent(),
                    withIntermediateDirectories: true,
                    attributes: nil
                )
                try png.write(to: outputURL, options: .atomic)
                self.postScreenshotCompletion(requestId, body: ["ok": true])
            } catch {
                self.postScreenshotCompletion(requestId, body: ["ok": false, "error": "screen-capture-failed"])
            }
        }
    }

    func fetchLocalControlStatus(completion: @escaping (LocalControlSnapshot?) -> Void) {
        localControlRequest("/status") { data, ok in
            guard ok, let data,
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let control = root["control"] as? [String: Any]
            else {
                completion(nil)
                return
            }
            let screenshotCapture = root["screenshotCapture"] as? [String: Any]
            if let firstScreenshotRequest = (screenshotCapture?["pendingRequests"] as? [[String: Any]])?.first {
                self.handleScreenshotCaptureRequest(firstScreenshotRequest)
            }
            let accessibilityBridge = root["accessibilityBridge"] as? [String: Any]
            for entry in (accessibilityBridge?["pendingRequests"] as? [[String: Any]] ?? []).prefix(8) {
                self.handleAccessibilityBridgeRequest(entry)
            }
            let pending = (control["pendingActions"] as? [[String: Any]] ?? []).compactMap { entry -> PendingControlAction? in
                guard entry["status"] as? String == "pending", let actionId = entry["actionId"] as? String else {
                    return nil
                }
                return PendingControlAction(
                    actionId: actionId,
                    appName: entry["appName"] as? String ?? "",
                    kind: entry["kind"] as? String ?? "",
                    targetSummary: self.summarizeControlTarget(entry["target"] as? [String: Any]),
                    resolvedSummary: self.summarizeResolvedPreview(entry["resolved"] as? [String: Any])
                )
            }
            let pendingArmRequests = (control["pendingArmRequests"] as? [[String: Any]] ?? []).compactMap { entry -> PendingArmRequest? in
                guard entry["status"] as? String == "pending",
                      let requestId = entry["requestId"] as? String
                else { return nil }
                return PendingArmRequest(
                    requestId: requestId,
                    projectName: entry["projectName"] as? String ?? entry["projectId"] as? String ?? "Project",
                    clientLabel: entry["clientName"] as? String ?? entry["clientLabel"] as? String ?? "Remote client",
                    reason: entry["reason"] as? String ?? "Remote desktop-control request",
                    createdAt: TimeInterval(entry["createdAt"] as? Int ?? 0) / 1000.0,
                    expiresAt: TimeInterval(entry["expiresAt"] as? Int ?? 0) / 1000.0
                )
            }
            let operationApprovalsRoot = root["operationApprovals"] as? [String: Any] ?? [:]
            let pendingOperationApprovals = (operationApprovalsRoot["pendingRequests"] as? [[String: Any]] ?? []).compactMap { entry -> PendingOperationApproval? in
                guard entry["status"] as? String == "pending",
                      let requestId = entry["requestId"] as? String
                else { return nil }
                return PendingOperationApproval(
                    requestId: requestId,
                    projectId: entry["projectId"] as? String ?? "Project",
                    tool: entry["tool"] as? String ?? "operation",
                    risk: entry["risk"] as? String ?? "destructive",
                    preview: entry["preview"] as? String ?? "Protected operation",
                    createdAt: TimeInterval(entry["createdAt"] as? Int ?? 0) / 1000.0,
                    expiresAt: TimeInterval(entry["expiresAt"] as? Int ?? 0) / 1000.0
                )
            }
            let sessions = (root["sessions"] as? [[String: Any]] ?? []).map { entry -> ActiveSessionSummary in
                let operation = entry["operation"] as? [String: Any]
                let cancellation = operation?["clientCancellation"] as? [String: Any]
                return ActiveSessionSummary(
                    label: entry["sessionLabel"] as? String ?? "session",
                    conversationLabel: entry["conversationLabel"] as? String,
                    clientName: entry["clientName"] as? String,
                    connectedAt: entry["connectedAt"] as? Int ?? 0,
                    lastActiveAt: entry["lastActiveAt"] as? Int ?? 0,
                    state: entry["state"] as? String ?? "idle",
                    operationId: operation?["operationId"] as? String,
                    tool: operation?["tool"] as? String,
                    startedAt: operation?["startedAt"] as? Int,
                    finishedAt: operation?["finishedAt"] as? Int,
                    elapsedMs: operation?["elapsedMs"] as? Int ?? 0,
                    phase: operation?["phase"] as? String,
                    message: operation?["message"] as? String,
                    lastProgressAt: operation?["lastProgressAt"] as? Int,
                    clientCancellationObservedAt: cancellation?["observedAt"] as? Int,
                    operationContinuesAfterCancellation: cancellation?["operationContinues"] as? Bool ?? false
                )
            }
            let conversations = (root["conversations"] as? [[String: Any]] ?? []).compactMap { entry -> ConversationSummary? in
                guard let label = entry["conversationLabel"] as? String else { return nil }
                let activityHighlights = (entry["activityHighlights"] as? [[String: Any]] ?? []).compactMap { highlight -> ConversationActivityHighlight? in
                    guard let kind = highlight["kind"] as? String,
                          let state = highlight["state"] as? String,
                          let startedAt = highlight["startedAt"] as? Int
                    else { return nil }
                    return ConversationActivityHighlight(
                        kind: kind,
                        state: state,
                        startedAt: startedAt,
                        finishedAt: highlight["finishedAt"] as? Int
                    )
                }
                let operations = (entry["operations"] as? [[String: Any]] ?? []).compactMap { operation -> ConversationOperationSummary? in
                    guard let operationId = operation["operationId"] as? String,
                          let tool = operation["tool"] as? String,
                          let startedAt = operation["startedAt"] as? Int
                    else { return nil }
                    return ConversationOperationSummary(
                        operationId: operationId,
                        tool: tool,
                        state: operation["state"] as? String ?? "idle",
                        startedAt: startedAt,
                        finishedAt: operation["finishedAt"] as? Int,
                        elapsedMs: operation["elapsedMs"] as? Int ?? 0,
                        phase: operation["phase"] as? String,
                        message: operation["message"] as? String,
                        activityHint: operation["activityHint"] as? String,
                        lastProgressAt: operation["lastProgressAt"] as? Int
                    )
                }
                return ConversationSummary(
                    label: label,
                    taskLabel: entry["taskLabel"] as? String,
                    displayTitle: entry["displayTitle"] as? String,
                    firstSeenAt: entry["firstSeenAt"] as? Int ?? 0,
                    lastActiveAt: entry["lastActiveAt"] as? Int ?? 0,
                    state: entry["state"] as? String ?? "idle",
                    dashboardVisibleUntil: entry["dashboardVisibleUntil"] as? Int,
                    activityHighlights: activityHighlights,
                    operations: operations
                )
            }
            let project = (root["project"] as? [String: Any]).map { entry in
                LocalControlSnapshot.ProjectSummary(
                    projectId: entry["projectId"] as? String ?? "project",
                    name: entry["name"] as? String ?? entry["projectId"] as? String ?? "Project"
                )
            }
            let lease = (root["lease"] as? [String: Any]).map { entry in
                LocalControlSnapshot.LeaseSummary(
                    preset: entry["preset"] as? String ?? "read-only",
                    expiresAt: TimeInterval(entry["expiresAt"] as? Int ?? 0) / 1000.0,
                    active: entry["active"] as? Bool ?? false
                )
            }
            let diagnostics = root["diagnostics"] as? [String: Any]
            let recoveryEntry = diagnostics?["clientCancellationRecovery"] as? [String: Any]
            let cancellationRecovery = recoveryEntry.map { entry in
                ClientCancellationRecovery(
                    operationId: entry["operationId"] as? String,
                    state: entry["state"] as? String ?? "unknown",
                    automaticRetrySafe: entry["automaticRetrySafe"] as? Bool ?? false,
                    recommendedAction: entry["recommendedAction"] as? String ?? "inspect-connection-audit-before-retry"
                )
            }
            let externalSearch = root["externalSearch"] as? [String: Any]
            let rgRoot = externalSearch?["rg"] as? [String: Any] ?? [:]
            let rgBinary = rgRoot["binary"] as? [String: Any] ?? [:]
            let pendingRgRequests = (rgRoot["pendingRequests"] as? [[String: Any]] ?? []).compactMap { entry -> PendingRgRequest? in
                guard entry["status"] as? String == "pending",
                      let requestId = entry["requestId"] as? String
                else { return nil }
                return PendingRgRequest(
                    requestId: requestId,
                    projectId: entry["projectId"] as? String ?? "Project",
                    queryPreview: entry["queryPreview"] as? String ?? "",
                    patternMode: entry["patternMode"] as? String ?? "literal",
                    caseSensitive: entry["caseSensitive"] as? Bool ?? true,
                    maxResults: entry["maxResults"] as? Int ?? 200,
                    binaryPath: entry["binaryPath"] as? String ?? "",
                    binaryVersion: entry["binaryVersion"] as? String ?? "ripgrep",
                    binarySha256: entry["binarySha256"] as? String ?? "",
                    createdAt: TimeInterval(entry["createdAt"] as? Int ?? 0) / 1000.0,
                    expiresAt: TimeInterval(entry["expiresAt"] as? Int ?? 0) / 1000.0
                )
            }
            let rgSnapshot = RgCapabilitySnapshot(
                preference: rgRoot["preference"] as? String ?? "ask",
                binaryAvailable: rgBinary["available"] as? Bool ?? false,
                binaryPath: (rgBinary["realPath"] as? String) ?? (rgBinary["path"] as? String),
                binaryVersion: rgBinary["version"] as? String,
                binarySha256: rgBinary["sha256"] as? String,
                unavailableReason: rgBinary["reason"] as? String,
                pendingRequests: pendingRgRequests
            )
            completion(LocalControlSnapshot(
                project: project,
                lease: lease,
                armed: control["armed"] as? Bool ?? false,
                killed: control["killed"] as? Bool ?? false,
                pendingActions: pending,
                pendingArmRequests: pendingArmRequests,
                operationApprovals: pendingOperationApprovals,
                autoEnabled: control["autoEnabled"] as? Bool ?? false,
                autoRemainingMs: control["autoRemainingMs"] as? Int ?? 0,
                allowlistedAppCount: control["allowlistedAppCount"] as? Int ?? 0,
                sessions: sessions,
                conversations: conversations,
                clientCancellationRecovery: cancellationRecovery,
                rg: rgSnapshot
            ))
        }
    }

    func performLocalControl(_ path: String, completion: @escaping (Bool) -> Void = { _ in }) {
        localControlRequest(path, method: "POST") { _, ok in completion(ok) }
    }

    private var cliScript: URL {
        effectiveRuntimeRoot.appendingPathComponent("dist").appendingPathComponent("cli.js")
    }

    private func runCli(_ arguments: [String], stdin: String? = nil) throws -> (status: Int32, stdout: String, stderr: String) {
        let activeRoot = effectiveRuntimeRoot
        let nodeCandidates = [
            activeRoot.appendingPathComponent("bin/node"),
            activeRoot.appendingPathComponent("node/bin/node"),
            runtimeRoot.appendingPathComponent("bin/node"),
            runtimeRoot.appendingPathComponent("node/bin/node"),
        ]
        let bundledNode = nodeCandidates.first {
            FileManager.default.isExecutableFile(atPath: $0.path)
        }
        let process = Process()
        process.executableURL = bundledNode ?? URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = bundledNode == nil ? ["node", cliScript.path] + arguments : [cliScript.path] + arguments

        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = [
            activeRoot.appendingPathComponent("bin").path,
            activeRoot.appendingPathComponent("node/bin").path,
            runtimeRoot.appendingPathComponent("bin").path,
            runtimeRoot.appendingPathComponent("node/bin").path,
            "\(NSHomeDirectory())/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
            environment["PATH"] ?? "",
        ].joined(separator: ":")
        process.environment = environment

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        var stdinPipe: Pipe?
        if stdin != nil {
            let pipe = Pipe()
            stdinPipe = pipe
            process.standardInput = pipe
        }

        try process.run()
        if let stdin, let data = stdin.data(using: .utf8), let pipe = stdinPipe {
            pipe.fileHandleForWriting.write(data)
            try? pipe.fileHandleForWriting.close()
        }
        process.waitUntilExit()

        let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (process.terminationStatus, stdout, stderr)
    }

    func ownerTokenStatus() -> OwnerTokenStatus {
        guard let result = try? runCli(["owner-token", "--status", "--workspace", workspace]),
              result.status == 0,
              let data = result.stdout.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let configured = json["configured"] as? Bool
        else {
            return .checkFailed
        }
        return configured ? .configured : .missing
    }

    func generateOwnerToken() throws -> String {
        let result = try runCli(["owner-token", "--generate", "--workspace", workspace])
        guard result.status == 0,
              let data = result.stdout.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["ownerToken"] as? String,
              !token.isEmpty
        else {
            throw NSError(domain: "ChatGPTToCodex", code: 2, userInfo: [
                NSLocalizedDescriptionKey: result.stderr.isEmpty ? "Owner token generation failed." : result.stderr
            ])
        }
        return token
    }

    func setOwnerToken(_ token: String) throws {
        let result = try runCli(["owner-token", "--set-stdin", "--workspace", workspace], stdin: token)
        if result.status != 0 {
            throw NSError(domain: "ChatGPTToCodex", code: 3, userInfo: [
                NSLocalizedDescriptionKey: result.stderr.isEmpty ? "Owner token update failed." : result.stderr
            ])
        }
    }

    var releasesURL: URL {
        githubRepoURL.appendingPathComponent("releases")
    }

    var selectedProjectFolder: URL? {
        guard let value = defaults.string(forKey: selectedProjectFolderKey), !value.isEmpty else {
            return nil
        }
        return URL(fileURLWithPath: value)
    }

    var workspace: String {
        defaultWorkspace
    }

    var additionalWorkspaceRoots: [String] {
        let primary = URL(fileURLWithPath: defaultWorkspace).standardizedFileURL.path
        let primaryPrefix = primary.hasSuffix("/") ? primary : primary + "/"
        var candidates = defaults.stringArray(forKey: additionalWorkspaceRootsKey) ?? []
        if let selectedProjectFolder {
            candidates.append(selectedProjectFolder.standardizedFileURL.path)
        }
        var seen = Set<String>()
        return candidates.compactMap { value in
            let root = URL(fileURLWithPath: value).standardizedFileURL.path
            guard root != primary, !root.hasPrefix(primaryPrefix), seen.insert(root).inserted else {
                return nil
            }
            return root
        }
    }

    var additionalWorkspaceRootsJSON: String? {
        let roots = additionalWorkspaceRoots
        guard !roots.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: roots),
              let value = String(data: data, encoding: .utf8)
        else { return nil }
        return value
    }

    var activeProjectRoot: String? {
        guard let selectedProjectFolder, hasProjectMarker(selectedProjectFolder) else {
            return nil
        }
        return selectedProjectFolder.path
    }

    var projectDisplayName: String {
        selectedProjectFolder?.lastPathComponent ?? localized("defaultWorkspace")
    }

    func setSelectedProjectFolder(_ url: URL) {
        let normalized = url.standardizedFileURL.path
        defaults.set(normalized, forKey: selectedProjectFolderKey)
        let primary = URL(fileURLWithPath: defaultWorkspace).standardizedFileURL.path
        let primaryPrefix = primary.hasSuffix("/") ? primary : primary + "/"
        guard normalized != primary, !normalized.hasPrefix(primaryPrefix) else { return }
        var roots = defaults.stringArray(forKey: additionalWorkspaceRootsKey) ?? []
        if !roots.contains(normalized) {
            roots.append(normalized)
            defaults.set(roots, forKey: additionalWorkspaceRootsKey)
        }
    }

    func clearSelectedProjectFolder() {
        defaults.removeObject(forKey: selectedProjectFolderKey)
    }

    func setPublicHostname(_ value: String) {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        defaults.set(normalized, forKey: publicHostnameKey)
        if !enablePublicTunnel {
            defaults.set("loopback", forKey: tunnelModeKey)
        } else if normalized.isEmpty {
            defaults.set("cloudflare-quick", forKey: tunnelModeKey)
        } else {
            let lower = normalized.lowercased()
            let external = lower.hasPrefix("https://") ||
                (lower.hasSuffix(".ts.net") && !lower.contains("/") && !lower.contains("@") && cloudflaredTunnelName == nil)
            defaults.set(external ? "external" : "cloudflare-named", forKey: tunnelModeKey)
        }
    }

    func setEnablePublicTunnel(_ enabled: Bool) {
        defaults.set(enabled, forKey: enablePublicTunnelKey)
    }

    func setPort(_ value: Int) {
        defaults.set(value, forKey: portKey)
    }

    func setStartMCPOnLaunch(_ enabled: Bool) {
        defaults.set(enabled, forKey: startMCPOnLaunchKey)
    }

    func setMultiProjectLanesEnabled(_ enabled: Bool) {
        defaults.set(enabled, forKey: multiProjectLanesEnabledKey)
    }

    func setChatGptRemoteControlEnabledForSession(_ enabled: Bool) {
        chatGptRemoteControlSessionOverride = enabled
    }

    func setShowIntermediateCommentary(_ enabled: Bool) {
        defaults.set(enabled, forKey: showIntermediateCommentaryKey)
        localControlRequest(
            "/output-policy",
            method: "POST",
            jsonBody: ["showIntermediateCommentary": enabled]
        ) { _, _ in }
    }

    func setAutoCheckUpdates(_ enabled: Bool) {
        defaults.set(enabled, forKey: autoCheckUpdatesKey)
    }

    func setPreferredLanguage(_ value: String) {
        defaults.set(value, forKey: preferredLanguageKey)
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        defaults.set(enabled, forKey: launchAtLoginKey)
        let appPath = Bundle.main.bundleURL.path
        let script: String
        if enabled {
            script = """
            tell application "System Events"
              if not (exists login item \(appleScriptString(appName))) then
                make login item at end with properties {name:\(appleScriptString(appName)), path:\(appleScriptString(appPath)), hidden:true}
              end if
            end tell
            """
        } else {
            script = """
            tell application "System Events"
              delete login items whose name is \(appleScriptString(appName))
            end tell
            """
        }
        runAppleScript(script)
    }

    func hasProjectMarker(_ url: URL) -> Bool {
        let markers = [".git", "package.json", "pubspec.yaml", "go.mod", "Cargo.toml", "requirements.txt", ".chatgpt2codex"]
        return markers.contains { marker in
            FileManager.default.fileExists(atPath: url.appendingPathComponent(marker).path)
        }
    }

    func ensureWorkspaceDirectory(_ url: URL) -> Bool {
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            return true
        } catch {
            return false
        }
    }

    var healthURL: URL {
        URL(string: "http://127.0.0.1:\(port)/healthz")!
    }

    var publicBaseURL: URL? {
        guard enablePublicTunnel else { return nil }
        if tunnelMode == "external" {
            return externalPublicBaseURL
        }
        if tunnelMode == "cloudflare-named", let publicHost {
            return URL(string: "https://\(publicHost)")
        }
        return tunnelMode == "cloudflare-quick" ? discoverQuickTunnelBaseURL() : nil
    }

    var connectorURL: URL? {
        publicBaseURL?.appendingPathComponent("mcp")
    }

    var publicHealthURL: URL? {
        publicBaseURL?.appendingPathComponent("healthz")
    }

    var isManagedProcessRunning: Bool {
        if let process {
            return process.isRunning
        }
        return false
    }

    func checkHealth(completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { data, response, error in
            let okStatus = (response as? HTTPURLResponse)?.statusCode == 200
            let okBody = data.flatMap { String(data: $0, encoding: .utf8) }?.contains("\"ok\":true") == true
            DispatchQueue.main.async {
                completion(error == nil && okStatus && okBody)
            }
        }.resume()
    }

    private func checkHealthBeforeLaunch(remainingAttempts: Int, completion: @escaping (Bool) -> Void) {
        checkHealth { [weak self] healthy in
            guard let self else { return }
            if healthy || remainingAttempts <= 1 {
                completion(healthy)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                self.checkHealthBeforeLaunch(remainingAttempts: remainingAttempts - 1, completion: completion)
            }
        }
    }

    func start(completion: @escaping (Bool) -> Void) {
        // A host/account hiccup or a short event-loop stall must not turn into
        // a second launcher that reclaims a healthy runtime. Require multiple
        // consecutive loopback failures before attempting a new launch.
        checkHealthBeforeLaunch(remainingAttempts: 3) { [weak self] alreadyRunning in
            guard let self else { return }
            if alreadyRunning {
                completion(true)
                return
            }
            do {
                try self.launchServer()
                completion(true)
            } catch {
                self.appendLog("launch failed: \(error.localizedDescription)\n")
                completion(false)
            }
        }
    }

    func stop(terminateExternalRuntime: Bool = true) {
        let managedProcess = process
        if let managedProcess, managedProcess.isRunning {
            managedProcess.terminate()
        }
        process = nil

        if !terminateExternalRuntime {
            return
        }

        let startPattern = shellQuote("start-chatgpt.sh")
        let servePattern = shellQuote("dist/cli.js serve --http --port \(port)")
        let tunnelPattern = shellQuote("cloudflared.*127.0.0.1:\(port)|cloudflared.*localhost:\(port)")
        let stopManagedTunnel = tunnelMode.hasPrefix("cloudflare-") ? "pkill -f \(tunnelPattern) 2>/dev/null || true" : ":"
        let command = """
        pkill -f \(startPattern) 2>/dev/null || true
        pkill -f \(servePattern) 2>/dev/null || true
        \(stopManagedTunnel)
        """
        runDetachedShell(command)
    }

    func restart(completion: @escaping (Bool) -> Void) {
        let ownsManagedRuntime = process?.isRunning == true
        // When this app owns the launcher, terminate only that exact Process.
        // A detached broad pkill can outlive the old process and race the new
        // launch after loopback health has already gone down. Fall back to the
        // broad external cleanup only when there is no live managed handle.
        stop(terminateExternalRuntime: !ownsManagedRuntime)
        waitForRuntimeToStop(remainingAttempts: 24) { [weak self] stopped in
            guard let self else { return }
            guard stopped else {
                self.appendLog("restart failed: previous runtime stayed healthy before managed launch\n")
                completion(false)
                return
            }
            do {
                try self.launchServer()
                completion(true)
            } catch {
                self.appendLog("restart launch failed: \(error.localizedDescription)\n")
                completion(false)
            }
        }
    }

    private func waitForRuntimeToStop(remainingAttempts: Int, completion: @escaping (Bool) -> Void) {
        checkHealth { [weak self] healthy in
            guard let self else { return }
            if !healthy {
                completion(true)
                return
            }
            if remainingAttempts <= 1 {
                completion(false)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                self.waitForRuntimeToStop(remainingAttempts: remainingAttempts - 1, completion: completion)
            }
        }
    }

    func recoverManagedRuntimeAfterHandoff(completion: @escaping (Bool) -> Void) {
        // The fixed app-apply worker stops the exact previous runtime/supervisor
        // before relaunching this app. Do not call stop() here: stop() uses a
        // detached broad pkill, which can race this replacement launch and kill
        // the new managed supervisor after loopback health has already gone down.
        waitForRuntimeToStop(remainingAttempts: 24) { [weak self] stopped in
            guard let self else { return }
            guard stopped else {
                self.appendLog("handoff recovery failed: previous runtime stayed healthy before managed launch\n")
                completion(false)
                return
            }
            do {
                try self.launchServer()
                completion(true)
            } catch {
                self.appendLog("handoff recovery launch failed: \(error.localizedDescription)\n")
                completion(false)
            }
        }
    }

    private func launchServer() throws {
        let script = runtimeRoot.appendingPathComponent("start-chatgpt.sh")
        guard FileManager.default.fileExists(atPath: script.path) else {
            throw NSError(domain: "ChatGPTToCodex", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "start-chatgpt.sh not found at \(script.path)"
            ])
        }

        let stateDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local")
            .appendingPathComponent("share")
            .appendingPathComponent("chatgpt2codex")
        let command = """
        cd \(shellQuote(runtimeRoot.path))
        export PATH=\(shellQuote(runtimeRoot.appendingPathComponent("bin").path))":$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
        export WORKSPACE=\(shellQuote(workspace))
        export CHATGPT2CODEX_STATE_DIR=\(shellQuote(stateDir.path))
        \(additionalWorkspaceRootsJSON.map { "export CHATGPT2CODEX_ADDITIONAL_WORKSPACE_ROOTS_JSON=\(shellQuote($0))" } ?? "unset CHATGPT2CODEX_ADDITIONAL_WORKSPACE_ROOTS_JSON")
        export PORT=\(port)
        \(multiProjectLanesEnabled ? "export CHATGPT2CODEX_MULTI_PROJECT_LANES=1" : "export CHATGPT2CODEX_MULTI_PROJECT_LANES=0")
        \(chatGptRemoteControlEnabled ? "export CHATGPT2CODEX_CONTROL_CHATGPT=1" : "unset CHATGPT2CODEX_CONTROL_CHATGPT")
        \(showIntermediateCommentary ? "export CHATGPT2CODEX_SHOW_INTERMEDIATE_COMMENTARY=1" : "unset CHATGPT2CODEX_SHOW_INTERMEDIATE_COMMENTARY")
        \(enablePublicTunnel ? "export CHATGPT2CODEX_EXPOSE_WEB=1" : "unset CHATGPT2CODEX_EXPOSE_WEB")
        export CHATGPT2CODEX_TUNNEL_MODE=\(shellQuote(tunnelMode))
        \(tunnelMode == "external" ? externalPublicBaseURL.map { "export CHATGPT2CODEX_PUBLIC_URL=\(shellQuote($0.absoluteString))" } ?? "unset CHATGPT2CODEX_PUBLIC_URL" : "unset CHATGPT2CODEX_PUBLIC_URL")
        \(tunnelMode == "cloudflare-named" ? publicHost.map { "export PUBLIC_HOSTNAME=\(shellQuote($0))" } ?? "unset PUBLIC_HOSTNAME" : "unset PUBLIC_HOSTNAME")
        \(cloudflaredTunnelName.map { "export CLOUDFLARED_TUNNEL_NAME=\(shellQuote($0))" } ?? "")
        \(activeProjectRoot.map { "export CHATGPT2CODEX_ACTIVE_PROJECT_ROOT=\(shellQuote($0))" } ?? "")
        exec /bin/bash \(shellQuote(script.path))
        """

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", command]

        if !FileManager.default.fileExists(atPath: logFile.path) {
            FileManager.default.createFile(atPath: logFile.path, contents: nil)
        }
        let logHandle = try FileHandle(forWritingTo: logFile)
        try logHandle.seekToEnd()
        let pipe = Pipe()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { return }
            try? logHandle.write(contentsOf: data)
            if let text = String(data: data, encoding: .utf8) {
                self?.appendLogMirror(text)
            }
        }
        process.standardOutput = pipe
        process.standardError = pipe
        process.terminationHandler = { [weak self] _ in
            pipe.fileHandleForReading.readabilityHandler = nil
            try? logHandle.close()
            DispatchQueue.main.async {
                if self?.process === process {
                    self?.process = nil
                }
            }
        }
        try process.run()
        self.process = process
    }

    private func appendLog(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: logFile.path) {
            FileManager.default.createFile(atPath: logFile.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: logFile) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
            try? handle.close()
        }
    }

    private func appendLogMirror(_ text: String) {
        if text.contains("chatgpt2codex is ready") || text.contains("exited") || text.contains("missing command") {
            NSLog("%@", text)
        }
    }

    private func discoverQuickTunnelBaseURL() -> URL? {
        guard let data = try? Data(contentsOf: logFile),
              let text = String(data: data, encoding: .utf8),
              let regex = try? NSRegularExpression(pattern: #"https://[A-Za-z0-9.-]+\.trycloudflare\.com"#)
        else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.matches(in: text, range: range).last,
              let matchRange = Range(match.range, in: text)
        else {
            return nil
        }
        return URL(string: String(text[matchRange]))
    }

    func checkForUpdates(completion: @escaping (String, RuntimeUpdate?) -> Void) {
        let currentVersion = defaults.string(forKey: appliedRuntimeVersionKey) ?? appVersion
        let apiPath = githubRepoURL.path
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .replacingOccurrences(of: ".git", with: "")
        guard let apiURL = URL(string: "https://api.github.com/repos/\(apiPath)/releases/latest") else {
            completion(localized("updatePageReady"), nil)
            return
        }
        var request = URLRequest(url: apiURL)
        request.timeoutInterval = 5
        request.setValue("chatgpt2codex", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode
            let json = data.flatMap {
                try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
            }
            let latest = json.flatMap { json in
                (json["tag_name"] as? String) ?? (json["name"] as? String)
            }?.trimmingCharacters(in: CharacterSet(charactersIn: "vV "))
            let dmgURL = (json?["assets"] as? [[String: Any]])?
                .first(where: { asset in
                    (asset["name"] as? String)?.lowercased().hasSuffix(".dmg") == true
                })
                .flatMap { asset in
                    (asset["browser_download_url"] as? String).flatMap(URL.init(string:))
                }
            DispatchQueue.main.async {
                guard status == 200, let latest, !latest.isEmpty else {
                    completion(self.localized("updateCheckFailed"), nil)
                    return
                }
                if !versionIsNewer(latest, than: currentVersion) {
                    completion(String(format: self.localized("upToDate"), currentVersion), nil)
                } else {
                    let update = dmgURL.map { RuntimeUpdate(version: latest, dmgURL: $0) }
                    completion(String(format: self.localized("updateAvailable"), latest, currentVersion), update)
                }
            }
        }.resume()
    }

    func applyRuntimeUpdate(
        _ update: RuntimeUpdate,
        completion: @escaping (Bool, String) -> Void
    ) {
        guard let executableDirectory = Bundle.main.executableURL?.deletingLastPathComponent() else {
            completion(false, "Could not locate the application executable directory.")
            return
        }
        let updater = executableDirectory.appendingPathComponent("chatgpt2codex-runtime-updater")
        guard FileManager.default.isExecutableFile(atPath: updater.path) else {
            completion(false, "Runtime updater helper is missing. Install this release's DMG once, then retry.")
            return
        }

        let process = Process()
        process.executableURL = updater
        process.arguments = [
            "--dmg-url", update.dmgURL.absoluteString,
            "--version", update.version,
            "--port", "\(port)",
            "--current-app", Bundle.main.bundleURL.path,
        ]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        process.terminationHandler = { [weak self] process in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8) ?? ""
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let message = json?["message"] as? String
                ?? text.trimmingCharacters(in: .whitespacesAndNewlines)
            let ok = process.terminationStatus == 0
            if ok, let self {
                self.defaults.set(update.version, forKey: self.appliedRuntimeVersionKey)
            }
            DispatchQueue.main.async {
                completion(ok, message.isEmpty ? "Runtime updater did not return a result." : message)
            }
        }
        do {
            try process.run()
        } catch {
            completion(false, error.localizedDescription)
        }
    }

    func runDoctor(repair: Bool = true) -> String {
        let activeRoot = effectiveRuntimeRoot
        let direct = activeRoot.appendingPathComponent("macos-dependency-doctor.sh")
        let source = activeRoot.appendingPathComponent("scripts/macos-dependency-doctor.sh")
        let script = FileManager.default.fileExists(atPath: direct.path) ? direct : source
        guard FileManager.default.fileExists(atPath: script.path) else {
            return "Doctor script not found.\nExpected: \(direct.path)"
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = repair ? [script.path, "--repair"] : [script.path]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "\(activeRoot.appendingPathComponent("bin").path):\(activeRoot.appendingPathComponent("node/bin").path):\(NSHomeDirectory())/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\(environment["PATH"] ?? "")"
        environment["WORKSPACE"] = workspace
        environment["PORT"] = "\(port)"
        environment["CHATGPT2CODEX_DOCTOR_REPAIR"] = repair ? "1" : "0"
        environment["CHATGPT2CODEX_TUNNEL_MODE"] = tunnelMode
        if enablePublicTunnel {
            environment["CHATGPT2CODEX_EXPOSE_WEB"] = "1"
        } else {
            environment.removeValue(forKey: "CHATGPT2CODEX_EXPOSE_WEB")
        }
        if tunnelMode == "external", let externalPublicBaseURL {
            environment["CHATGPT2CODEX_PUBLIC_URL"] = externalPublicBaseURL.absoluteString
            environment.removeValue(forKey: "PUBLIC_HOSTNAME")
        } else if tunnelMode == "cloudflare-named", let publicHost {
            environment["PUBLIC_HOSTNAME"] = publicHost
            environment.removeValue(forKey: "CHATGPT2CODEX_PUBLIC_URL")
        } else {
            environment.removeValue(forKey: "PUBLIC_HOSTNAME")
            environment.removeValue(forKey: "CHATGPT2CODEX_PUBLIC_URL")
        }
        process.environment = environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return "Doctor failed to start: \(error.localizedDescription)"
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        return output + "\nExit code: \(process.terminationStatus)"
    }

    private func runDetachedShell(_ command: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", command]
        try? process.run()
    }

    private func runAppleScript(_ script: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
    }
}

private final class ControlOverlayCoordinator {
    private let badgeSize = NSSize(width: 38, height: 38)
    private let cursorSize = NSSize(width: 30, height: 30)
    private var controlActive = false
    private var lastAgentPoint: CGPoint?

    private lazy var badgePanel: NSPanel = {
        let panel = makeOverlayPanel(size: badgeSize)
        let effect = NSView(frame: NSRect(origin: .zero, size: badgeSize))
        effect.wantsLayer = true
        effect.layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.94).cgColor
        effect.layer?.cornerRadius = 11
        effect.layer?.borderColor = NSColor.systemBlue.withAlphaComponent(0.95).cgColor
        effect.layer?.borderWidth = 2
        effect.layer?.masksToBounds = true

        let icon = NSImageView(frame: NSRect(x: 8, y: 8, width: 22, height: 22))
        icon.image = NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: "Computer control active")
            ?? NSImage(systemSymbolName: "cursorarrow", accessibilityDescription: "Computer control active")
        icon.imageScaling = .scaleProportionallyDown
        icon.contentTintColor = .systemBlue
        effect.addSubview(icon)
        panel.contentView = effect
        return panel
    }()

    private lazy var cursorPanel: NSPanel = {
        let panel = makeOverlayPanel(size: cursorSize)
        let container = NSView(frame: NSRect(origin: .zero, size: cursorSize))
        container.wantsLayer = true

        let halo = NSView(frame: NSRect(x: 3, y: 3, width: 24, height: 24))
        halo.wantsLayer = true
        halo.layer?.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.88).cgColor
        halo.layer?.cornerRadius = 12
        halo.layer?.borderColor = NSColor.white.withAlphaComponent(0.95).cgColor
        halo.layer?.borderWidth = 1.5
        container.addSubview(halo)

        let icon = NSImageView(frame: NSRect(x: 5, y: 5, width: 20, height: 20))
        icon.image = NSImage(systemSymbolName: "cursorarrow", accessibilityDescription: "Agent cursor")
        icon.imageScaling = .scaleProportionallyDown
        icon.contentTintColor = .white
        container.addSubview(icon)
        panel.contentView = container
        return panel
    }()

    private func makeOverlayPanel(size: NSSize) -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.canHide = false
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.isMovable = false
        panel.isMovableByWindowBackground = false
        panel.isExcludedFromWindowsMenu = true
        panel.sharingType = .readOnly
        // `statusBar` proved too easy for a background utility window to lose
        // behind app/full-screen surfaces. The control affordance must remain
        // visibly above normal UI while it is armed, without taking focus or
        // receiving pointer events.
        panel.level = .screenSaver
        panel.animationBehavior = .none
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        return panel
    }

    private func showOverlayPanel(_ panel: NSPanel) {
        panel.alphaValue = 1
        panel.displayIfNeeded()
        panel.orderFrontRegardless()
        panel.setIsVisible(true)
    }


    private func positionBadge(on screen: NSScreen? = nil) {
        guard let targetScreen = screen ?? NSScreen.main ?? NSScreen.screens.first else { return }
        let visible = targetScreen.visibleFrame
        badgePanel.setFrameOrigin(NSPoint(
            x: visible.minX + 14,
            y: visible.maxY - badgeSize.height - 14
        ))
    }

    private func screenAndAppKitPoint(fromCoreGraphics point: CGPoint) -> (screen: NSScreen, point: CGPoint)? {
        for screen in NSScreen.screens {
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
            let cgBounds = CGDisplayBounds(CGDirectDisplayID(number.uint32Value))
            guard cgBounds.contains(point) else { continue }
            return (
                screen,
                CGPoint(
                    x: screen.frame.minX + (point.x - cgBounds.minX),
                    y: screen.frame.maxY - (point.y - cgBounds.minY)
                )
            )
        }
        return nil
    }

    func setControlActive(_ active: Bool) {
        controlActive = active
        guard active else {
            badgePanel.orderOut(nil)
            cursorPanel.orderOut(nil)
            return
        }
        positionBadge()
        showOverlayPanel(badgePanel)
        if lastAgentPoint != nil {
            showOverlayPanel(cursorPanel)
        }
    }

    func moveAgentCursor(to coreGraphicsPoint: CGPoint) {
        lastAgentPoint = coreGraphicsPoint
        if !controlActive {
            setControlActive(true)
        }
        guard let mapped = screenAndAppKitPoint(fromCoreGraphics: coreGraphicsPoint) else { return }
        positionBadge(on: mapped.screen)
        showOverlayPanel(badgePanel)
        let point = mapped.point
        let origin = NSPoint(x: point.x - 4, y: point.y - cursorSize.height + 4)
        if cursorPanel.isVisible {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.10
                cursorPanel.animator().setFrameOrigin(origin)
            }
        } else {
            cursorPanel.setFrameOrigin(origin)
            showOverlayPanel(cursorPanel)
        }
    }
}

private final class StatusBarAppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private let controller = ServiceController()
    private let controlOverlay = ControlOverlayCoordinator()
    private var agentCursorObserver: NSObjectProtocol?
    private var statusItem: NSStatusItem!
    private var statusMenuItem = NSMenuItem(title: "ChatGPT To Codex: checking...", action: nil, keyEquivalent: "")
    private var projectMenuItem = NSMenuItem()
    private var portMenuItem = NSMenuItem()
    private var toggleItem = NSMenuItem()
    private var restartItem = NSMenuItem()
    private var openPublicHealthItem = NSMenuItem()
    private var copyConnectorItem = NSMenuItem()
    private var pendingControlSubmenu: NSMenu?
    private var pendingArmRequestSubmenu: NSMenu?
    private var pendingArmRequestMenuItem = NSMenuItem()
    private var pendingOperationApprovalSubmenu: NSMenu?
    private var pendingOperationApprovalMenuItem = NSMenuItem()
    private var sessionStatusSubmenu: NSMenu?
    private var rgPermissionSubmenu: NSMenu?
    private var rgPermissionMenuItem = NSMenuItem()
    private var chatGptRemoteControlMenuItem = NSMenuItem()
    private var armMenuItem = NSMenuItem()
    private var armExplanationMenuItem = NSMenuItem()
    private var armRemoteRequestExplanationMenuItem = NSMenuItem()
    private var screenPermissionItem = NSMenuItem()
    private var accessibilityPermissionItem = NSMenuItem()
    private var latestControlSnapshot: ServiceController.LocalControlSnapshot?
    private var timer: Timer?
    private var statusRefreshInFlight = false
    private var accessibilityBridgeTimer: Timer?
    private var killHotkeyGlobalMonitor: Any?
    private var killHotkeyLocalMonitor: Any?
    private var settingsHotKeyRef: EventHotKeyRef?
    private var settingsHotKeyEventHandler: EventHandlerRef?
    private var statusMenuHotKeyRef: EventHotKeyRef?
    private var statusMenuHotKeyEventHandler: EventHandlerRef?
    private var presentedArmRequestIDs = Set<String>()
    private var presentedOperationApprovalIDs = Set<String>()
    private var presentedRgRequestIDs = Set<String>()
    private var latestHealth = false
    private var settingsWindow: NSWindow?
    private var activityWindow: NSWindow?
    private weak var activityWebView: WKWebView?
    private weak var activityFallbackView: NSView?
    private let activityDashboardURL = URL(string: "http://127.0.0.1:7980/activity/?embedded=mac")!
    private weak var commandStatusLabel: NSTextField?
    private weak var commandProjectLabel: NSTextField?
    private weak var commandMcpButton: NSButton?
    private weak var commandRemoteControlButton: NSButton?
    private weak var commandAgentArmButton: NSButton?
    private weak var commandKillControlButton: NSButton?
    private weak var commandOperationApprovalsButton: NSButton?
    private var logWindow: NSWindow?
    private var doctorWindow: NSWindow?
    private weak var settingsLanguagePopup: NSPopUpButton?
    private weak var settingsProjectField: NSTextField?
    private weak var settingsLaunchAtLogin: NSButton?
    private weak var settingsStartOnLaunch: NSButton?
    private weak var settingsAutoUpdate: NSButton?
    private weak var settingsMultiProjectLanes: NSButton?
    private weak var settingsShowIntermediateCommentary: NSButton?
    private weak var settingsPublicTunnel: NSButton?
    private weak var settingsOwnerTokenStatus: NSTextField?
    private weak var settingsOwnerTokenButton: NSButton?
    private weak var settingsOwnerTokenCopyButton: NSButton?
    private var settingsOwnerTokenConfigured = false
    private weak var settingsHostField: NSTextField?
    private weak var settingsPortField: NSTextField?

    private func t(_ key: String) -> String {
        controller.localized(key)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        agentCursorObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("C2CTAgentCursorMove"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let x = notification.userInfo?["x"] as? Double,
                  let y = notification.userInfo?["y"] as? Double
            else { return }
            self?.controlOverlay.moveAgentCursor(to: CGPoint(x: x, y: y))
        }
        let isDevelopmentBuild = (Bundle.main.object(forInfoDictionaryKey: "ChatGPT2CodexDevelopmentBuild") as? Bool) == true
        // Keep the status item compact. A variable-length image + title item can
        // be pushed into macOS menu-bar overflow even when the process and menu
        // are otherwise healthy.
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        // Keep the legacy status-item command surface alive internally during
        // the windowed-app migration, but never occupy menu-bar space.
        statusItem.autosaveName = "ChatGPTToCodexStatusItem"
        statusItem.isVisible = false
        if let button = statusItem.button {
            let iconURL = Bundle.main.url(forResource: "StatusIconTemplate", withExtension: "png")
            let statusImage = NSImage(
                systemSymbolName: "arrow.left.arrow.right.square.fill",
                accessibilityDescription: isDevelopmentBuild ? "C2CT DEV" : "C2CT"
            )
                ?? iconURL.flatMap { NSImage(contentsOf: $0) }
                ?? NSImage(named: "StatusIconTemplate")
                ?? NSImage(named: "AppIcon")
            if let image = statusImage {
                image.isTemplate = true
                button.image = image.withSymbolConfiguration(
                    NSImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
                ) ?? image
                button.imageScaling = .scaleProportionallyDown
                button.imagePosition = .imageOnly
            }
            button.title = ""
            button.setAccessibilityLabel(isDevelopmentBuild ? "C2CT DEV" : "C2CT")
            button.toolTip = isDevelopmentBuild ? "ChatGPT To Codex Dev" : "ChatGPT To Codex"
        }
        rebuildMenu()
        refreshStatus()
        registerGlobalKillHotkeyIfNeeded()
        registerSettingsHotKey()
        registerStatusMenuHotKey()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.promptScreenRecordingPermissionIfNeeded(force: false)
        }
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.refreshStatus()
        }
        accessibilityBridgeTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            guard let self, self.latestHealth, self.controller.controlEnabled else { return }
            self.controller.pollAccessibilityBridgeRequests()
        }
        let recoverRuntimeAfterHandoff = CommandLine.arguments.contains("--c2ct-recover-runtime")
        if controller.startMCPOnLaunch || recoverRuntimeAfterHandoff {
            if case .missing = controller.ownerTokenStatus() {
                showSettings()
                return
            }
            let completion: (Bool) -> Void = { [weak self] ok in
                guard let self else { return }
                self.refreshStatus()
                if !ok {
                    self.runDoctor()
                }
            }
            if recoverRuntimeAfterHandoff {
                // A one-shot handoff recovery must re-establish an app-owned
                // supervisor even when an orphaned runtime is still healthy on
                // the port. A normal start would adopt that health result and
                // leave no supervisor to consume future runtime-reload markers.
                controller.recoverManagedRuntimeAfterHandoff(completion: completion)
            } else {
                controller.start(completion: completion)
            }
        }
        if controller.autoCheckUpdates {
            controller.checkForUpdates { [weak self] message, _ in
                self?.statusMenuItem.title = message
            }
        }
        DispatchQueue.main.async { [weak self] in
            self?.showActivityWindow()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            showActivityWindow()
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        controlOverlay.setControlActive(false)
        if let observer = agentCursorObserver {
            NotificationCenter.default.removeObserver(observer)
            agentCursorObserver = nil
        }
        if let monitor = killHotkeyGlobalMonitor { NSEvent.removeMonitor(monitor) }
        if let monitor = killHotkeyLocalMonitor { NSEvent.removeMonitor(monitor) }
        unregisterSettingsHotKey()
        unregisterStatusMenuHotKey()
        controller.stop(terminateExternalRuntime: false)
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "ChatGPT To Codex: \(t("statusChecking"))", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        statusMenuItem.image = symbol("circle.dashed")
        menu.addItem(statusMenuItem)

        menu.addItem(menuItem(t("activityWindowMenu"), #selector(showActivityWindow), "waveform.path.ecg.rectangle"))

        let sessionsSubmenu = NSMenu()
        sessionsSubmenu.delegate = self
        sessionStatusSubmenu = sessionsSubmenu
        let sessionsItem = NSMenuItem(title: t("activeSessionsMenu"), action: nil, keyEquivalent: "")
        sessionsItem.image = symbol("person.2.wave.2")
        sessionsItem.submenu = sessionsSubmenu
        menu.addItem(sessionsItem)

        let rgSubmenu = NSMenu()
        rgSubmenu.delegate = self
        rgPermissionSubmenu = rgSubmenu
        rgPermissionMenuItem = NSMenuItem(title: t("rgPermissionMenu"), action: nil, keyEquivalent: "")
        rgPermissionMenuItem.image = symbol("text.magnifyingglass")
        rgPermissionMenuItem.submenu = rgSubmenu
        menu.addItem(rgPermissionMenuItem)

        let operationApprovalSubmenu = NSMenu()
        operationApprovalSubmenu.delegate = self
        pendingOperationApprovalSubmenu = operationApprovalSubmenu
        pendingOperationApprovalMenuItem = NSMenuItem(title: "작업 승인 요청 대기 (0)", action: nil, keyEquivalent: "")
        pendingOperationApprovalMenuItem.image = symbol("exclamationmark.shield")
        pendingOperationApprovalMenuItem.submenu = operationApprovalSubmenu
        pendingOperationApprovalMenuItem.isEnabled = false
        menu.addItem(pendingOperationApprovalMenuItem)
        menu.addItem(.separator())

        // Desktop-control (Option B) human-approval surface. Hidden entirely
        // when the feature flag is off, matching src/control/policy.ts
        // isControlEnabled(): doing nothing means these tools are never
        // reachable and this UI has nothing to show. The kill switch is
        // placed at the very top of the control section so it is reachable
        // in one click without hunting through a submenu.
        if controller.controlEnabled {
            let armRequestsSubmenu = NSMenu()
            armRequestsSubmenu.delegate = self
            pendingArmRequestSubmenu = armRequestsSubmenu
            pendingArmRequestMenuItem = NSMenuItem(title: "제어 승인 요청 대기 (0)", action: nil, keyEquivalent: "")
            pendingArmRequestMenuItem.image = symbol("person.crop.circle.badge.questionmark")
            pendingArmRequestMenuItem.submenu = armRequestsSubmenu
            pendingArmRequestMenuItem.isEnabled = false
            menu.addItem(pendingArmRequestMenuItem)

            let remoteControlEnabled = controller.chatGptRemoteControlEnabled
            chatGptRemoteControlMenuItem = menuItem(
                "ChatGPT 원격 제어: \(remoteControlEnabled ? "켜짐" : "꺼짐") · 이번 앱 세션만",
                #selector(toggleChatGptRemoteControl),
                remoteControlEnabled ? "network.badge.shield.half.filled" : "network"
            )
            chatGptRemoteControlMenuItem.state = remoteControlEnabled ? .on : .off
            chatGptRemoteControlMenuItem.toolTip = "원격 ChatGPT의 화면·클릭·입력 실행을 허용합니다. 앱을 종료하면 꺼지며, 작업별 승인·허용 목록·민감 앱 차단·강제 종료는 그대로 유지됩니다."
            menu.addItem(chatGptRemoteControlMenuItem)

            armMenuItem = menuItem("\(t("agentArmOffMenu")) · 로컬 직접 제어", #selector(toggleAgentArm), "shield.lefthalf.filled")
            armMenuItem.toolTip = "\(t("agentArmStatusDetail")) · 원격 승인 요청과 별도"
            menu.addItem(armMenuItem)

            armExplanationMenuItem = NSMenuItem(title: t("agentArmOffExplanation"), action: nil, keyEquivalent: "")
            armExplanationMenuItem.image = symbol("info.circle")
            armExplanationMenuItem.indentationLevel = 1
            armExplanationMenuItem.isEnabled = false
            menu.addItem(armExplanationMenuItem)

            armRemoteRequestExplanationMenuItem = NSMenuItem(
                title: t("agentArmRemoteRequestExplanation"),
                action: nil,
                keyEquivalent: ""
            )
            armRemoteRequestExplanationMenuItem.indentationLevel = 1
            armRemoteRequestExplanationMenuItem.isEnabled = false
            menu.addItem(armRemoteRequestExplanationMenuItem)

            let killItem = menuItem(t("killControlMenu"), #selector(killControlAction), "hand.raised.fill")
            menu.addItem(killItem)

            let pendingSubmenu = NSMenu()
            pendingSubmenu.delegate = self
            pendingControlSubmenu = pendingSubmenu
            let pendingItem = NSMenuItem(title: t("pendingControlActionsMenu"), action: nil, keyEquivalent: "")
            pendingItem.image = symbol("checklist")
            pendingItem.submenu = pendingSubmenu
            menu.addItem(pendingItem)
            menu.addItem(.separator())
        }

        toggleItem = NSMenuItem(title: t("startMCP"), action: #selector(toggleServer), keyEquivalent: "s")
        toggleItem.target = self
        toggleItem.image = symbol("play.circle")
        menu.addItem(toggleItem)

        restartItem = NSMenuItem(title: t("restartMCP"), action: #selector(restartServer), keyEquivalent: "r")
        restartItem.target = self
        restartItem.image = symbol("arrow.clockwise.circle")
        menu.addItem(restartItem)
        screenPermissionItem = menuItem(t("screenshotPermissionMenu"), #selector(showScreenRecordingPermission), "camera.viewfinder")
        menu.addItem(screenPermissionItem)
        if controller.controlEnabled {
            accessibilityPermissionItem = menuItem(t("accessibilityPermissionMenu"), #selector(showAccessibilityPermission), "figure.roll")
            menu.addItem(accessibilityPermissionItem)
        }
        menu.addItem(menuItem(t("connectionDiagnosticsMenu"), #selector(showConnectionDiagnostics), "stethoscope"))
        let settingsItem = menuItem(t("settingsMenu"), #selector(showSettings), "gearshape")
        settingsItem.keyEquivalent = ","
        settingsItem.keyEquivalentModifierMask = [.control, .option, .command]
        menu.addItem(settingsItem)
        menu.addItem(.separator())
        menu.addItem(menuItem(t("quit"), #selector(quit), "power"))
        statusItem.menu = menu
        configureMainMenu()
        updatePermissionMenuItems()
    }

    private func configureMainMenu() {
        let mainMenu = NSMenu(title: "MainMenu")

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu(title: "ChatGPT To Codex")
        appMenuItem.submenu = appMenu

        let aboutItem = NSMenuItem(title: t("aboutTitle"), action: #selector(showAbout), keyEquivalent: "")
        aboutItem.target = self
        appMenu.addItem(aboutItem)
        appMenu.addItem(.separator())

        let settingsItem = NSMenuItem(title: t("settingsMenu"), action: #selector(showSettings), keyEquivalent: ",")
        settingsItem.target = self
        settingsItem.keyEquivalentModifierMask = [.command]
        appMenu.addItem(settingsItem)
        appMenu.addItem(.separator())

        let quitItem = NSMenuItem(title: t("quit"), action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        quitItem.keyEquivalentModifierMask = [.command]
        appMenu.addItem(quitItem)
        mainMenu.addItem(appMenuItem)

        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenuItem.submenu = windowMenu

        let activityItem = NSMenuItem(title: t("activityWindowMenu"), action: #selector(showActivityWindow), keyEquivalent: "1")
        activityItem.target = self
        activityItem.keyEquivalentModifierMask = [.command]
        windowMenu.addItem(activityItem)

        let logsItem = NSMenuItem(title: t("showLogs"), action: #selector(showLogs), keyEquivalent: "")
        logsItem.target = self
        windowMenu.addItem(logsItem)

        let diagnosticsItem = NSMenuItem(title: t("connectionDiagnosticsMenu"), action: #selector(showConnectionDiagnostics), keyEquivalent: "")
        diagnosticsItem.target = self
        windowMenu.addItem(diagnosticsItem)

        let doctorItem = NSMenuItem(title: t("doctorTitle"), action: #selector(runDoctor), keyEquivalent: "")
        doctorItem.target = self
        windowMenu.addItem(doctorItem)
        mainMenu.addItem(windowMenuItem)

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }

    private func menuItem(_ title: String, _ action: Selector, _ symbolName: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.image = symbol(symbolName)
        return item
    }

    private func checkMenuItem(_ title: String, _ action: Selector, _ checked: Bool, _ symbolName: String) -> NSMenuItem {
        let item = menuItem(title, action, symbolName)
        item.state = checked ? .on : .off
        return item
    }

    private func symbol(_ name: String) -> NSImage? {
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil) else {
            return nil
        }
        image.isTemplate = true
        return image
    }

    private func finishStatusRefresh() {
        statusRefreshInFlight = false
    }

    private func refreshStatus() {
        guard !statusRefreshInFlight else { return }
        statusRefreshInFlight = true
        controller.checkHealth { [weak self] ok in
            guard let self else { return }
            self.latestHealth = ok
            let state = ok ? self.t("statusOn") : self.t("statusOff")
            self.statusMenuItem.title = "ChatGPT To Codex: \(state)"
            self.statusMenuItem.image = self.symbol(ok ? "checkmark.circle" : "xmark.circle")
            self.projectMenuItem.title = "\(self.t("projectPrefix")): \(self.controller.projectDisplayName)"
            self.portMenuItem.title = "\(self.t("portPrefix")): \(self.controller.port)"
            self.toggleItem.title = ok || self.controller.isManagedProcessRunning ? self.t("stopMCP") : self.t("startMCP")
            self.toggleItem.image = self.symbol(ok || self.controller.isManagedProcessRunning ? "stop.circle" : "play.circle")
            self.toggleItem.keyEquivalent = ok || self.controller.isManagedProcessRunning ? "x" : "s"
            self.restartItem.isEnabled = true
            let hasPublicURL = self.controller.connectorURL != nil
            self.openPublicHealthItem.isEnabled = hasPublicURL
            self.copyConnectorItem.isEnabled = hasPublicURL
            self.statusItem.button?.toolTip = String(format: self.t("tooltipState"), state)
            self.updatePermissionMenuItems()
            self.refreshCommandCenter()
            if ok {
                self.controller.fetchLocalControlStatus { [weak self] snapshot in
                    guard let self else { return }
                    self.latestControlSnapshot = snapshot
                    self.applyControlSnapshot()
                    self.applyRgSnapshot()
                    self.applyOperationApprovalSnapshot()
                    self.refreshSessionSubmenu()
                    self.refreshCommandCenter()
                    self.finishStatusRefresh()
                }
            } else {
                self.latestControlSnapshot = nil
                self.applyControlSnapshot()
                self.applyRgSnapshot()
                self.applyOperationApprovalSnapshot()
                self.refreshSessionSubmenu()
                self.refreshCommandCenter()
                self.finishStatusRefresh()
            }
        }
    }

    private func refreshSessionSubmenu() {
        guard let menu = sessionStatusSubmenu else { return }
        menuNeedsUpdate(menu)
    }

    private func activityLabel(
        _ text: String,
        font: NSFont,
        color: NSColor = .labelColor,
        lines: Int = 1
    ) -> NSTextField {
        let label = lines == 1 ? NSTextField(labelWithString: text) : NSTextField(wrappingLabelWithString: text)
        label.font = font
        label.textColor = color
        label.maximumNumberOfLines = lines
        label.lineBreakMode = lines == 1 ? .byTruncatingTail : .byWordWrapping
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }

    private func commandSectionLabel(_ text: String) -> NSTextField {
        let label = activityLabel(text, font: .systemFont(ofSize: 11, weight: .semibold), color: .secondaryLabelColor)
        label.stringValue = text.uppercased()
        return label
    }

    private func commandButton(_ title: String, action: Selector, symbolName: String) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.image = symbol(symbolName)
        button.imagePosition = .imageLeading
        button.alignment = .left
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: 164).isActive = true
        return button
    }

    @objc private func showUnifiedApprovalsCommandMenu(_ sender: NSButton) {
        let menu = makeNativeApprovalMenu()
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    @objc private func showDiagnosticsCommandMenu(_ sender: NSButton) {
        let menu = NSMenu()
        menu.addItem(menuItem(t("connectionDiagnosticsMenu"), #selector(showConnectionDiagnostics), "stethoscope"))
        menu.addItem(menuItem(t("showLogs"), #selector(showLogs), "doc.text.magnifyingglass"))
        menu.addItem(menuItem(t("runDoctor"), #selector(runDoctor), "cross.case"))
        menu.addItem(.separator())
        menu.addItem(menuItem(t("openLocalHealth"), #selector(openLocalHealth), "heart.text.square"))
        let publicHealth = menuItem(t("openPublicHealth"), #selector(openPublicHealth), "globe")
        publicHealth.isEnabled = controller.connectorURL != nil
        menu.addItem(publicHealth)
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    private func makeCommandCenter() -> NSView {
        let sidebar = NSVisualEffectView()
        sidebar.material = .sidebar
        sidebar.blendingMode = .withinWindow
        sidebar.state = .active
        sidebar.translatesAutoresizingMaskIntoConstraints = false

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        scrollView.documentView = document
        sidebar.addSubview(scrollView)

        let status = activityLabel(t("statusChecking"), font: .systemFont(ofSize: 14, weight: .semibold))
        commandStatusLabel = status
        stack.addArrangedSubview(status)
        let project = activityLabel(controller.projectDisplayName, font: .systemFont(ofSize: 11), color: .secondaryLabelColor, lines: 2)
        commandProjectLabel = project
        stack.addArrangedSubview(project)

        stack.addArrangedSubview(commandSectionLabel(controller.effectiveLanguageCode == "ko" ? "서비스" : "Service"))
        let mcp = commandButton(t("startMCP"), action: #selector(toggleServer), symbolName: "play.circle")
        commandMcpButton = mcp
        stack.addArrangedSubview(mcp)

        if controller.controlEnabled {
            let remote = commandButton("ChatGPT 원격 제어", action: #selector(toggleChatGptRemoteControl), symbolName: "network.badge.shield.half.filled")
            commandRemoteControlButton = remote
            stack.addArrangedSubview(remote)
            let arm = commandButton(t("agentArmOffMenu"), action: #selector(toggleAgentArm), symbolName: "shield.lefthalf.filled")
            commandAgentArmButton = arm
            stack.addArrangedSubview(arm)
            let kill = commandButton(t("killControlMenu"), action: #selector(killControlAction), symbolName: "hand.raised.fill")
            kill.contentTintColor = .systemRed
            kill.isHidden = true
            commandKillControlButton = kill
            stack.addArrangedSubview(kill)
        }

        stack.addArrangedSubview(commandSectionLabel(controller.effectiveLanguageCode == "ko" ? "작업" : "Work"))
        let approvals = commandButton(controller.effectiveLanguageCode == "ko" ? "승인 대기" : "Approvals", action: #selector(showUnifiedApprovalsCommandMenu(_:)), symbolName: "exclamationmark.shield")
        commandOperationApprovalsButton = approvals
        stack.addArrangedSubview(approvals)
        stack.addArrangedSubview(commandButton(controller.effectiveLanguageCode == "ko" ? "진단" : "Diagnostics", action: #selector(showDiagnosticsCommandMenu(_:)), symbolName: "stethoscope"))
        stack.addArrangedSubview(commandButton(controller.effectiveLanguageCode == "ko" ? "권한 / 도구…" : "Permissions / Tools…", action: #selector(showPermissionsToolsCommandMenu(_:)), symbolName: "checkmark.shield"))
        stack.addArrangedSubview(commandButton(t("settingsMenu"), action: #selector(showSettings), symbolName: "gearshape"))

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 12),
            scrollView.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 10),
            scrollView.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -10),
            scrollView.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor, constant: -12),
            document.leadingAnchor.constraint(equalTo: scrollView.contentView.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: scrollView.contentView.trailingAnchor),
            document.topAnchor.constraint(equalTo: scrollView.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 4),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 4),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -4),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -4),
        ])
        return sidebar
    }

    private func refreshCommandCenter() {
        let running = latestHealth || controller.isManagedProcessRunning
        commandStatusLabel?.stringValue = "ChatGPT To Codex: \(running ? t("statusOn") : t("statusOff"))"
        commandStatusLabel?.textColor = running ? .systemGreen : .secondaryLabelColor
        commandProjectLabel?.stringValue = "\(controller.projectDisplayName) · \(t("portPrefix")) \(controller.port)"
        commandMcpButton?.title = running ? t("stopMCP") : t("startMCP")
        commandMcpButton?.image = symbol(running ? "stop.circle" : "play.circle")

        let remoteEnabled = controller.chatGptRemoteControlEnabled
        commandRemoteControlButton?.title = "ChatGPT 원격 제어: \(remoteEnabled ? "켜짐" : "꺼짐")"
        commandRemoteControlButton?.state = remoteEnabled ? .on : .off
        let armed = latestControlSnapshot?.armed == true
        commandAgentArmButton?.title = armed ? t("agentArmOnMenu") : t("agentArmOffMenu")
        commandAgentArmButton?.state = armed ? .on : .off
        let armCount = latestControlSnapshot?.pendingArmRequests.count ?? 0
        let actionCount = latestControlSnapshot?.pendingActions.count ?? 0
        let approvalCount = latestControlSnapshot?.operationApprovals.count ?? 0
        let rgCount = latestControlSnapshot?.rg.pendingRequests.count ?? 0
        let totalApprovalCount = armCount + actionCount + approvalCount + rgCount
        commandOperationApprovalsButton?.title = controller.effectiveLanguageCode == "ko"
            ? "승인 대기 (\(totalApprovalCount))"
            : "Approvals (\(totalApprovalCount))"
        commandOperationApprovalsButton?.contentTintColor = totalApprovalCount > 0 ? .systemOrange : nil
        commandKillControlButton?.isHidden = !(armed || actionCount > 0)
    }

    private func appendNativeApprovalMenuSection(_ title: String, source: NSMenu?, to menu: NSMenu) {
        guard let source else { return }
        menuNeedsUpdate(source)
        if !menu.items.isEmpty { menu.addItem(.separator()) }
        let heading = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        heading.isEnabled = false
        menu.addItem(heading)
        for item in source.items {
            if let clone = item.copy() as? NSMenuItem {
                menu.addItem(clone)
            }
        }
    }

    private func makeNativeApprovalMenu() -> NSMenu {
        let menu = NSMenu()
        appendNativeApprovalMenuSection(
            controller.effectiveLanguageCode == "ko" ? "작업 승인" : "Work approvals",
            source: pendingOperationApprovalSubmenu,
            to: menu
        )
        if controller.controlEnabled {
            appendNativeApprovalMenuSection(
                controller.effectiveLanguageCode == "ko" ? "제어 승인" : "Control approvals",
                source: pendingArmRequestSubmenu,
                to: menu
            )
            appendNativeApprovalMenuSection(
                controller.effectiveLanguageCode == "ko" ? "제어 작업" : "Control actions",
                source: pendingControlSubmenu,
                to: menu
            )
        }
        appendNativeApprovalMenuSection(
            controller.effectiveLanguageCode == "ko" ? "외부 도구 승인" : "External tool approvals",
            source: rgPermissionSubmenu,
            to: menu
        )
        if menu.items.isEmpty {
            let empty = NSMenuItem(
                title: controller.effectiveLanguageCode == "ko" ? "대기 중인 승인이 없습니다" : "No approvals waiting",
                action: nil,
                keyEquivalent: ""
            )
            empty.isEnabled = false
            menu.addItem(empty)
        }
        return menu
    }

    private func showNativeApprovalMenu(from view: NSView) {
        NSApp.activate(ignoringOtherApps: true)
        let menu = makeNativeApprovalMenu()
        menu.popUp(
            positioning: nil,
            at: NSPoint(x: 20, y: max(24, view.bounds.height - 28)),
            in: view
        )
    }

    @objc private func showPermissionsToolsCommandMenu(_ sender: NSButton) {
        let menu = NSMenu()
        menu.addItem(menuItem(t("screenshotPermissionMenu"), #selector(showScreenRecordingPermission), "camera.viewfinder"))
        if controller.controlEnabled {
            menu.addItem(menuItem(t("accessibilityPermissionMenu"), #selector(showAccessibilityPermission), "figure.roll"))
        }
        appendNativeApprovalMenuSection(
            controller.effectiveLanguageCode == "ko" ? "외부 도구" : "External tools",
            source: rgPermissionSubmenu,
            to: menu
        )
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    private func isTrustedActivityDashboardURL(_ url: URL?) -> Bool {
        guard let url,
              url.scheme?.lowercased() == "http",
              url.host?.lowercased() == "127.0.0.1",
              url.port == 7980,
              url.path == "/activity" || url.path == "/activity/"
        else { return false }
        return true
    }

    private func makeActivityFallbackView() -> NSView {
        let fallback = NSVisualEffectView()
        fallback.material = .underWindowBackground
        fallback.blendingMode = .withinWindow
        fallback.state = .active
        fallback.translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: controller.effectiveLanguageCode == "ko"
            ? "작업 현황 대시보드에 연결할 수 없습니다"
            : "Unable to connect to the activity dashboard")
        title.font = .systemFont(ofSize: 16, weight: .semibold)
        title.alignment = .center
        stack.addArrangedSubview(title)

        let detail = NSTextField(wrappingLabelWithString: controller.effectiveLanguageCode == "ko"
            ? "로컬 C2CT runtime이 실행 중인지 확인한 뒤 다시 시도하세요."
            : "Check that the local C2CT runtime is running, then try again.")
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .center
        detail.maximumNumberOfLines = 2
        stack.addArrangedSubview(detail)

        let retry = NSButton(
            title: controller.effectiveLanguageCode == "ko" ? "다시 시도" : "Retry",
            target: self,
            action: #selector(retryActivityDashboard)
        )
        retry.bezelStyle = .rounded
        retry.image = symbol("arrow.clockwise")
        retry.imagePosition = .imageLeading
        stack.addArrangedSubview(retry)

        fallback.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: fallback.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: fallback.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: fallback.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: fallback.trailingAnchor, constant: -24),
        ])
        return fallback
    }

    @objc private func retryActivityDashboard() {
        loadActivityDashboard()
    }

    private func loadActivityDashboard() {
        guard let webView = activityWebView else { return }
        activityFallbackView?.isHidden = true
        let request = URLRequest(
            url: activityDashboardURL,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 5
        )
        webView.load(request)
    }

    @objc private func showActivityWindow() {
        if let window = activityWindow {
            NSApp.activate(ignoringOtherApps: true)
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
            if activityWebView?.url == nil || activityFallbackView?.isHidden == false {
                loadActivityDashboard()
            }
            refreshStatus()
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = t("activityWindowTitle")
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 980, height: 520)
        window.setFrameAutosaveName("ChatGPTToCodexActivityWindow")
        window.collectionBehavior = [.moveToActiveSpace]

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let contentController = WKUserContentController()
        contentController.add(self, name: "c2ctMacApp")
        configuration.userContentController = contentController

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self

        let root = NSView()
        root.translatesAutoresizingMaskIntoConstraints = false
        let commandCenter = makeCommandCenter()
        let fallback = makeActivityFallbackView()
        fallback.isHidden = true

        root.addSubview(commandCenter)
        root.addSubview(webView)
        root.addSubview(fallback)
        NSLayoutConstraint.activate([
            commandCenter.topAnchor.constraint(equalTo: root.topAnchor),
            commandCenter.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            commandCenter.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            commandCenter.widthAnchor.constraint(equalToConstant: 196),
            webView.topAnchor.constraint(equalTo: root.topAnchor),
            webView.leadingAnchor.constraint(equalTo: commandCenter.trailingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            fallback.topAnchor.constraint(equalTo: root.topAnchor),
            fallback.leadingAnchor.constraint(equalTo: commandCenter.trailingAnchor),
            fallback.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            fallback.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])

        window.contentView = root
        activityWindow = window
        activityWebView = webView
        activityFallbackView = fallback

        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
        loadActivityDashboard()
        refreshStatus()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "c2ctMacApp",
              message.webView === activityWebView,
              isTrustedActivityDashboardURL(message.webView?.url),
              let body = message.body as? [String: Any],
              body["action"] as? String == "openApprovals",
              let webView = activityWebView
        else { return }
        showNativeApprovalMenu(from: webView)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        decisionHandler(isTrustedActivityDashboardURL(navigationAction.request.url) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        activityFallbackView?.isHidden = true
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled {
            activityFallbackView?.isHidden = false
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled {
            activityFallbackView?.isHidden = false
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        activityFallbackView?.isHidden = false
    }

    private func updatePermissionMenuItems() {
        let screenAllowed = controller.screenRecordingAllowed
        screenPermissionItem.title = "\(t("screenshotPermissionTitle")): \(t(screenAllowed ? "permissionAllowed" : "permissionRequired"))"
        screenPermissionItem.state = screenAllowed ? .on : .off
        if controller.controlEnabled {
            let accessibilityAllowed = controller.accessibilityTrusted
            accessibilityPermissionItem.title = "\(t("accessibilityPermissionTitle")): \(t(accessibilityAllowed ? "permissionAllowed" : "permissionRequired"))"
            accessibilityPermissionItem.state = accessibilityAllowed ? .on : .off
        }
    }

    private func applyControlSnapshot() {
        guard controller.controlEnabled else {
            controlOverlay.setControlActive(false)
            return
        }
        let armed = latestControlSnapshot?.armed == true
        // `armed` is authoritative for both the local default session and a
        // remote scoped control lease. The top-level lease can intentionally
        // describe a different local project while remote control is active.
        if let snapshot = latestControlSnapshot {
            controlOverlay.setControlActive(snapshot.armed && !snapshot.killed)
        }
        armMenuItem.title = "\(t(armed ? "agentArmOnMenu" : "agentArmOffMenu")) · 로컬 직접 제어"
        armMenuItem.image = symbol(armed ? "shield.fill" : "shield.lefthalf.filled")
        armMenuItem.state = armed ? .on : .off
        armMenuItem.isEnabled = latestHealth
        armExplanationMenuItem.title = t(armed ? "agentArmOnExplanation" : "agentArmOffExplanation")
        armExplanationMenuItem.toolTip = t("agentArmStatusDetail")
        armRemoteRequestExplanationMenuItem.title = t("agentArmRemoteRequestExplanation")
        let pendingArmRequests = latestControlSnapshot?.pendingArmRequests ?? []
        pendingArmRequestMenuItem.title = "제어 승인 요청 대기 (\(pendingArmRequests.count))"
        pendingArmRequestMenuItem.isEnabled = latestHealth && !pendingArmRequests.isEmpty
        presentFirstSeenArmRequest(from: pendingArmRequests)
    }

    private func applyOperationApprovalSnapshot() {
        let requests = latestControlSnapshot?.operationApprovals ?? []
        pendingOperationApprovalMenuItem.title = "작업 승인 요청 대기 (\(requests.count))"
        pendingOperationApprovalMenuItem.isEnabled = latestHealth && !requests.isEmpty
        presentFirstSeenOperationApproval(from: requests)
    }

    private func applyRgSnapshot() {
        let rg = latestControlSnapshot?.rg
        let pendingCount = rg?.pendingRequests.count ?? 0
        let availability: String
        if rg?.binaryAvailable == true {
            availability = rg?.binaryVersion ?? "ripgrep"
        } else {
            availability = t("rgUnavailable")
        }
        rgPermissionMenuItem.title = "\(t("rgPermissionMenu")) · \(availability) · \(pendingCount)"
        rgPermissionMenuItem.isEnabled = latestHealth
        if let requests = rg?.pendingRequests {
            presentFirstSeenRgRequest(from: requests)
        }
    }

    @objc private func toggleServer() {
        if latestHealth || controller.isManagedProcessRunning {
            controller.stop()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.refreshStatus()
            }
        } else {
            if case .missing = controller.ownerTokenStatus() {
                showSettings()
                return
            }
            statusMenuItem.title = "ChatGPT To Codex: \(t("statusStarting"))"
            controller.start { [weak self] ok in
                guard let self else { return }
                self.refreshStatus()
                if !ok {
                    self.runDoctor()
                }
            }
        }
    }

    @objc private func restartServer() {
        statusMenuItem.title = "ChatGPT To Codex: \(t("statusRestarting"))"
        controller.restart { [weak self] _ in
            self?.refreshStatus()
        }
    }

    private func confirmRestartAfterSettingsSave() -> Bool {
        let alert = NSAlert()
        alert.messageText = t("restartAfterSaveTitle")
        alert.informativeText = t("restartAfterSaveInfo")
        alert.alertStyle = .informational
        alert.addButton(withTitle: t("restartMCP"))
        alert.addButton(withTitle: t("cancel"))
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func restartAfterSavedSettingsIfConfirmed(_ shouldRestart: Bool) {
        guard shouldRestart else {
            refreshStatus()
            return
        }
        if confirmRestartAfterSettingsSave() {
            statusMenuItem.title = "ChatGPT To Codex: \(t("statusRestarting"))"
            controller.restart { [weak self] _ in self?.refreshStatus() }
        } else {
            refreshStatus()
        }
    }

    private func promptScreenRecordingPermissionIfNeeded(force: Bool) {
        if controller.screenRecordingAllowed {
            if force {
                let readyAlert = NSAlert()
                readyAlert.messageText = t("screenshotPermissionTitle")
                readyAlert.informativeText = t("screenshotPermissionReadyInfo")
                readyAlert.alertStyle = .informational
                readyAlert.addButton(withTitle: t("ok"))
                NSApp.activate(ignoringOtherApps: true)
                readyAlert.runModal()
            }
            return
        }
        guard force || controller.shouldPromptForScreenRecordingPermission() else { return }
        controller.markScreenRecordingPromptShown()

        let alert = NSAlert()
        alert.messageText = t("screenshotPermissionTitle")
        alert.informativeText = t("screenshotPermissionMissingInfo")
        alert.alertStyle = .warning
        alert.addButton(withTitle: t("openPrivacySettings"))
        alert.addButton(withTitle: t("requestPermission"))
        alert.addButton(withTitle: t("ok"))
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            controller.openScreenRecordingSettings()
        } else if response == .alertSecondButtonReturn {
            _ = controller.requestScreenRecordingPermission()
            if !controller.screenRecordingAllowed {
                controller.openScreenRecordingSettings()
            }
        }
    }

    @objc private func showScreenRecordingPermission() {
        promptScreenRecordingPermissionIfNeeded(force: true)
    }

    @objc private func showAccessibilityPermission() {
        if controller.accessibilityTrusted {
            let readyAlert = NSAlert()
            readyAlert.messageText = t("accessibilityPermissionTitle")
            readyAlert.informativeText = t("accessibilityPermissionReadyInfo")
            readyAlert.alertStyle = .informational
            readyAlert.addButton(withTitle: t("ok"))
            NSApp.activate(ignoringOtherApps: true)
            readyAlert.runModal()
            return
        }

        let alert = NSAlert()
        alert.messageText = t("accessibilityPermissionTitle")
        alert.informativeText = t("accessibilityPermissionMissingInfo")
        alert.alertStyle = .warning
        alert.addButton(withTitle: t("openPrivacySettings"))
        alert.addButton(withTitle: t("requestPermission"))
        alert.addButton(withTitle: t("ok"))
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            controller.openAccessibilitySettings()
        } else if response == .alertSecondButtonReturn {
            if !controller.requestAccessibilityPermission() {
                controller.openAccessibilitySettings()
            }
        }
    }

    private func armRequestExpiryText(_ request: ServiceController.PendingArmRequest) -> String {
        guard request.expiresAt > 0 else { return "알 수 없음" }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter.string(from: Date(timeIntervalSince1970: request.expiresAt))
    }

    private func rgRequestExpiryText(_ request: ServiceController.PendingRgRequest) -> String {
        guard request.expiresAt > 0 else { return "알 수 없음" }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter.string(from: Date(timeIntervalSince1970: request.expiresAt))
    }

    private func operationApprovalExpiryText(_ request: ServiceController.PendingOperationApproval) -> String {
        guard request.expiresAt > 0 else { return "알 수 없음" }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter.string(from: Date(timeIntervalSince1970: request.expiresAt))
    }

    private func runForegroundApprovalAlert(_ alert: NSAlert) -> NSApplication.ModalResponse {
        let window = alert.window
        window.level = .modalPanel
        window.collectionBehavior.insert(.moveToActiveSpace)
        window.hidesOnDeactivate = false
        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        return alert.runModal()
    }

    private func makeUnifiedApprovalAlert(
        category: String,
        details: [String],
        primaryTitle: String,
        secondaryTitle: String = "거부",
        tertiaryTitle: String = "나중에"
    ) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = "C2CT 승인 요청"
        alert.informativeText = (["유형: \(category)"] + details).joined(separator: "\n")
        alert.alertStyle = .warning
        alert.addButton(withTitle: primaryTitle)
        alert.addButton(withTitle: secondaryTitle)
        alert.addButton(withTitle: tertiaryTitle)
        return alert
    }

    private func operationApprovalRiskText(_ risk: String) -> String {
        if risk == "network" { return "네트워크 접근" }
        if risk == "local-file-mutation" { return "고정 로컬 파일 변경" }
        return "파괴적 변경 가능"
    }

    private func presentFirstSeenOperationApproval(from requests: [ServiceController.PendingOperationApproval]) {
        guard let request = requests.first(where: { !presentedOperationApprovalIDs.contains($0.requestId) }) else { return }
        presentedOperationApprovalIDs.insert(request.requestId)
        presentOperationApproval(request)
    }

    private func presentOperationApproval(_ request: ServiceController.PendingOperationApproval) {
        let isRuntimeApply = request.tool == "runtime_apply_local"
        var details = [
            "프로젝트: \(request.projectId)",
            "도구: \(request.tool)",
            "위험 유형: \(operationApprovalRiskText(request.risk))",
            "작업: \(request.preview)",
            "만료: \(operationApprovalExpiryText(request))",
            "",
            "승인은 현재 프로젝트·현재 lease·이 정확한 작업에만 묶이며 한 번 실행하면 즉시 소모됩니다."
        ]
        if isRuntimeApply {
            details.append("메뉴바에서 이 버튼을 직접 누른 경우에만 런타임 교체가 허용됩니다. 앱·커넥터·터널은 교체 대상이 아닙니다.")
        }
        let alert = makeUnifiedApprovalAlert(
            category: isRuntimeApply ? "런타임 교체" : "보호 작업",
            details: details,
            primaryTitle: isRuntimeApply ? t("installRuntimeUpdate") : "이번만 허용"
        )
        let response = runForegroundApprovalAlert(alert)
        if response == .alertFirstButtonReturn {
            resolveOperationApproval(request, decision: "approve")
        } else if response == .alertSecondButtonReturn {
            resolveOperationApproval(request, decision: "reject")
        }
    }

    private func resolveOperationApproval(_ request: ServiceController.PendingOperationApproval, decision: String) {
        let path = request.tool == "runtime_apply_local" && decision == "approve"
            ? "/runtime-apply-approvals/\(request.requestId)/approve"
            : "/operation-approvals/\(request.requestId)/\(decision)"
        controller.performLocalControl(path) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    @objc private func reviewPendingOperationApproval(_ sender: NSMenuItem) {
        guard let requestId = sender.representedObject as? String,
              let request = latestControlSnapshot?.operationApprovals.first(where: { $0.requestId == requestId })
        else { return }
        presentOperationApproval(request)
    }

    private func presentFirstSeenRgRequest(from requests: [ServiceController.PendingRgRequest]) {
        guard let request = requests.first(where: { !presentedRgRequestIDs.contains($0.requestId) }) else { return }
        presentedRgRequestIDs.insert(request.requestId)
        presentRgRequest(request)
    }

    private func presentRgRequest(_ request: ServiceController.PendingRgRequest) {
        let shortHash = String(request.binarySha256.prefix(16))
        let alert = makeUnifiedApprovalAlert(
            category: "외부 검색 도구 (rg)",
            details: [
            "프로젝트: \(request.projectId)",
            "검색: \(request.queryPreview)",
            "방식: \(request.patternMode) · 대소문자 \(request.caseSensitive ? "구분" : "무시") · 최대 \(request.maxResults)개",
            "도구: \(request.binaryVersion)",
            "경로: \(request.binaryPath)",
            "SHA-256: \(shortHash)…",
            "만료: \(rgRequestExpiryText(request))",
            "",
            "승인은 이 프로젝트와 현재 lease, 검증된 rg 실행 파일에만 적용됩니다."
            ],
            primaryTitle: t("rgApproveOnce"),
            secondaryTitle: t("rgReject"),
            tertiaryTitle: "추가 옵션…"
        )
        let response = runForegroundApprovalAlert(alert)
        if response == .alertFirstButtonReturn {
            resolveRgRequest(request.requestId, decision: "once")
        } else if response == .alertSecondButtonReturn {
            resolveRgRequest(request.requestId, decision: "reject")
        } else if response == .alertThirdButtonReturn {
            presentRgExtendedApprovalOptions(request)
        }
    }

    private func presentRgExtendedApprovalOptions(_ request: ServiceController.PendingRgRequest) {
        let alert = makeUnifiedApprovalAlert(
            category: "외부 검색 도구 (rg) · 추가 옵션",
            details: [
                "프로젝트: \(request.projectId)",
                "검색: \(request.queryPreview)",
                "승인 범위를 넓히면 이후 같은 범위의 rg 요청에서는 승인 횟수가 줄어듭니다."
            ],
            primaryTitle: t("rgApproveSession"),
            secondaryTitle: t("rgApproveAlways"),
            tertiaryTitle: t("cancel")
        )
        let response = runForegroundApprovalAlert(alert)
        if response == .alertFirstButtonReturn {
            resolveRgRequest(request.requestId, decision: "session")
        } else if response == .alertSecondButtonReturn {
            resolveRgRequest(request.requestId, decision: "always")
        }
    }

    private func resolveRgRequest(_ requestId: String, decision: String) {
        controller.performLocalControl("/external-search/rg/requests/\(requestId)/\(decision)") { [weak self] _ in
            self?.refreshStatus()
        }
    }

    @objc private func reviewPendingRgRequest(_ sender: NSMenuItem) {
        guard let requestId = sender.representedObject as? String,
              let request = latestControlSnapshot?.rg.pendingRequests.first(where: { $0.requestId == requestId })
        else { return }
        presentRgRequest(request)
    }

    @objc private func approveRgOnce(_ sender: NSMenuItem) {
        guard let requestId = sender.representedObject as? String else { return }
        resolveRgRequest(requestId, decision: "once")
    }

    @objc private func approveRgSession(_ sender: NSMenuItem) {
        guard let requestId = sender.representedObject as? String else { return }
        resolveRgRequest(requestId, decision: "session")
    }

    @objc private func approveRgAlways(_ sender: NSMenuItem) {
        guard let requestId = sender.representedObject as? String else { return }
        resolveRgRequest(requestId, decision: "always")
    }

    @objc private func rejectRgRequest(_ sender: NSMenuItem) {
        guard let requestId = sender.representedObject as? String else { return }
        resolveRgRequest(requestId, decision: "reject")
    }

    @objc private func setRgAskPreference() {
        controller.performLocalControl("/external-search/rg/preference/ask") { [weak self] _ in
            self?.refreshStatus()
        }
    }

    @objc private func setRgCodeSearchOnlyPreference() {
        controller.performLocalControl("/external-search/rg/preference/code-search-only") { [weak self] _ in
            self?.refreshStatus()
        }
    }

    private func presentFirstSeenArmRequest(from requests: [ServiceController.PendingArmRequest]) {
        guard let request = requests.first(where: { !presentedArmRequestIDs.contains($0.requestId) }) else { return }
        presentedArmRequestIDs.insert(request.requestId)
        presentArmRequest(request)
    }

    private func presentArmRequest(_ request: ServiceController.PendingArmRequest) {
        let alert = makeUnifiedApprovalAlert(
            category: "원격 제어",
            details: [
            "프로젝트: \(request.projectName)",
            "클라이언트: \(request.clientLabel)",
            "사유: \(request.reason)",
            "만료: \(armRequestExpiryText(request))",
            "",
            "허용할 때만 로컬 control lease가 발급되고 KILL 상태가 해제됩니다."
            ],
            primaryTitle: "제어 허용"
        )
        let response = runForegroundApprovalAlert(alert)
        if response == .alertFirstButtonReturn {
            controller.performLocalControl("/control/arm-requests/\(request.requestId)/approve") { [weak self] _ in
                self?.refreshStatus()
            }
        } else if response == .alertSecondButtonReturn {
            controller.performLocalControl("/control/arm-requests/\(request.requestId)/reject") { [weak self] _ in
                self?.refreshStatus()
            }
        } else if response == .alertThirdButtonReturn {
            // Keep the request pending. The user can reopen it from the status menu.
        }
    }

    @objc private func reviewPendingArmRequest(_ sender: NSMenuItem) {
        guard let requestId = sender.representedObject as? String,
              let request = latestControlSnapshot?.pendingArmRequests.first(where: { $0.requestId == requestId })
        else { return }
        presentArmRequest(request)
    }

    /// NSMenuDelegate: rebuild the pending-control-actions submenu with the
    /// live queue state each time the user opens it, rather than on a timer,
    /// so approve/reject always act on current data.
    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === pendingOperationApprovalSubmenu {
            menu.removeAllItems()
            let requests = latestControlSnapshot?.operationApprovals ?? []
            if requests.isEmpty {
                let empty = NSMenuItem(title: "대기 중인 작업 승인 요청 없음", action: nil, keyEquivalent: "")
                empty.isEnabled = false
                menu.addItem(empty)
                return
            }
            for request in requests {
                let item = NSMenuItem(
                    title: "\(request.tool) · \(operationApprovalRiskText(request.risk)) · \(operationApprovalExpiryText(request))",
                    action: #selector(reviewPendingOperationApproval(_:)),
                    keyEquivalent: ""
                )
                item.target = self
                item.representedObject = request.requestId
                item.toolTip = request.preview
                menu.addItem(item)
            }
            return
        }
        if menu === rgPermissionSubmenu {
            menu.removeAllItems()
            let rg = latestControlSnapshot?.rg
            let binaryTitle: String
            if rg?.binaryAvailable == true {
                binaryTitle = "✓ \(rg?.binaryVersion ?? "ripgrep") · \(rg?.binaryPath ?? "")"
            } else {
                binaryTitle = "⚠︎ \(t("rgUnavailable")) · \(rg?.unavailableReason ?? "")"
            }
            let binaryItem = NSMenuItem(title: binaryTitle, action: nil, keyEquivalent: "")
            binaryItem.isEnabled = false
            binaryItem.toolTip = rg?.binarySha256
            menu.addItem(binaryItem)
            menu.addItem(.separator())

            let askItem = NSMenuItem(title: t("rgAskEveryTime"), action: #selector(setRgAskPreference), keyEquivalent: "")
            askItem.target = self
            askItem.state = rg?.preference == "ask" ? .on : .off
            menu.addItem(askItem)
            let codeSearchOnlyItem = NSMenuItem(title: t("rgCodeSearchOnly"), action: #selector(setRgCodeSearchOnlyPreference), keyEquivalent: "")
            codeSearchOnlyItem.target = self
            codeSearchOnlyItem.state = rg?.preference == "code-search-only" ? .on : .off
            menu.addItem(codeSearchOnlyItem)
            menu.addItem(.separator())

            let requests = rg?.pendingRequests ?? []
            if requests.isEmpty {
                let empty = NSMenuItem(title: t("rgPendingNone"), action: nil, keyEquivalent: "")
                empty.isEnabled = false
                menu.addItem(empty)
                return
            }
            for request in requests {
                let requestMenu = NSMenu()
                let detail = NSMenuItem(
                    title: "\(request.queryPreview) · \(rgRequestExpiryText(request))",
                    action: #selector(reviewPendingRgRequest(_:)),
                    keyEquivalent: ""
                )
                detail.target = self
                detail.representedObject = request.requestId
                detail.submenu = requestMenu

                let metadata = NSMenuItem(
                    title: "\(request.binaryVersion) · \(request.patternMode) · max \(request.maxResults)",
                    action: nil,
                    keyEquivalent: ""
                )
                metadata.isEnabled = false
                requestMenu.addItem(metadata)
                requestMenu.addItem(.separator())

                let actions: [(String, Selector)] = [
                    (t("rgApproveOnce"), #selector(approveRgOnce(_:))),
                    (t("rgApproveSession"), #selector(approveRgSession(_:))),
                    (t("rgApproveAlways"), #selector(approveRgAlways(_:))),
                    (t("rgReject"), #selector(rejectRgRequest(_:)))
                ]
                for (title, selector) in actions {
                    let action = NSMenuItem(title: title, action: selector, keyEquivalent: "")
                    action.target = self
                    action.representedObject = request.requestId
                    requestMenu.addItem(action)
                }
                menu.addItem(detail)
            }
            return
        }
        if menu === pendingArmRequestSubmenu {
            menu.removeAllItems()
            let requests = latestControlSnapshot?.pendingArmRequests ?? []
            if requests.isEmpty {
                let empty = NSMenuItem(title: "대기 중인 원격 제어 승인 요청 없음", action: nil, keyEquivalent: "")
                empty.isEnabled = false
                menu.addItem(empty)
                return
            }
            for request in requests {
                let item = NSMenuItem(
                    title: "\(request.projectName) · \(request.clientLabel) · \(armRequestExpiryText(request))",
                    action: #selector(reviewPendingArmRequest(_:)),
                    keyEquivalent: ""
                )
                item.target = self
                item.representedObject = request.requestId
                item.toolTip = request.reason
                menu.addItem(item)
            }
            return
        }
        if menu === sessionStatusSubmenu {
            menu.removeAllItems()
            let sessions = latestControlSnapshot?.sessions ?? []
            if sessions.isEmpty {
                let empty = NSMenuItem(title: t("sessionNoActive"), action: nil, keyEquivalent: "")
                empty.isEnabled = false
                menu.addItem(empty)
                return
            }
            for session in sessions {
                let identity = [session.clientName, session.label].compactMap { $0 }.joined(separator: " · ")
                let header = NSMenuItem(title: identity, action: nil, keyEquivalent: "")
                header.isEnabled = false
                menu.addItem(header)
                let elapsed = session.elapsedMs > 0 ? " · \(max(1, session.elapsedMs / 1000))s" : ""
                let operation = session.tool.map { "\($0) · \(session.state)\(elapsed)" } ?? session.state
                let detail = NSMenuItem(title: "  \(operation)", action: nil, keyEquivalent: "")
                detail.isEnabled = false
                menu.addItem(detail)
                if let phase = session.phase {
                    let heartbeatAge: String
                    if let lastProgressAt = session.lastProgressAt {
                        let ageSeconds = max(0, (Int(Date().timeIntervalSince1970 * 1000) - lastProgressAt) / 1000)
                        heartbeatAge = " · \(t("sessionHeartbeat")) \(ageSeconds)s"
                    } else {
                        heartbeatAge = ""
                    }
                    let phaseItem = NSMenuItem(
                        title: "  \(t("sessionPhase")): \(phase)\(heartbeatAge)",
                        action: nil,
                        keyEquivalent: ""
                    )
                    phaseItem.isEnabled = false
                    phaseItem.toolTip = session.message
                    menu.addItem(phaseItem)
                }
                if session.clientCancellationObservedAt != nil {
                    let recovery = latestControlSnapshot?.clientCancellationRecovery
                    let matchingRecovery = recovery?.operationId == session.operationId ? recovery : nil
                    let recoveryState = matchingRecovery?.state
                        ?? (session.operationContinuesAfterCancellation ? "still-running" : session.state)
                    let cancellationItem = NSMenuItem(
                        title: "  ⚠︎ \(t("sessionClientCancelled")) · \(recoveryState) · \(t("sessionNoAutomaticRetry"))",
                        action: nil,
                        keyEquivalent: ""
                    )
                    cancellationItem.isEnabled = false
                    cancellationItem.toolTip = matchingRecovery?.recommendedAction
                    menu.addItem(cancellationItem)
                }
                menu.addItem(.separator())
            }
            return
        }
        guard menu === pendingControlSubmenu else { return }
        menu.removeAllItems()

        // Auto-approve toggle: local-human-only through the authenticated
        // loopback control API. Shown disabled when the current control
        // allowlist is empty since there is nothing it could ever scope to.
        let autoEnabled = latestControlSnapshot?.autoEnabled == true
        let autoRemainingMs = latestControlSnapshot?.autoRemainingMs ?? 0
        let autoItem: NSMenuItem
        if autoEnabled {
            let minutesLeft = max(1, autoRemainingMs / 60000)
            autoItem = NSMenuItem(title: "\(t("autoApproveStatusMenu")) (\(minutesLeft)m) — \(t("autoApproveOffMenu"))", action: #selector(toggleAutoApprove), keyEquivalent: "")
        } else {
            autoItem = NSMenuItem(title: t("autoApproveOnMenu"), action: #selector(toggleAutoApprove), keyEquivalent: "")
        }
        autoItem.target = self
        autoItem.isEnabled = autoEnabled || (latestControlSnapshot?.allowlistedAppCount ?? 0) > 0
        if !autoEnabled && (latestControlSnapshot?.allowlistedAppCount ?? 0) == 0 {
            autoItem.toolTip = t("autoApproveUnavailableMenu")
        }
        menu.addItem(autoItem)
        menu.addItem(.separator())

        let pending = latestControlSnapshot?.pendingActions ?? []
        if pending.isEmpty {
            let empty = NSMenuItem(title: t("controlNoPendingActions"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }

        let approveAll = NSMenuItem(title: t("approveAllControlMenu"), action: #selector(approveAllPendingControlActions), keyEquivalent: "")
        approveAll.target = self
        menu.addItem(approveAll)
        menu.addItem(.separator())

        for action in pending {
            let summary = [action.appName, action.kind, action.targetSummary].filter { !$0.isEmpty }.joined(separator: " · ")
            let header = NSMenuItem(title: summary, action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)

            // Dry-run AX resolve preview, shown to the approver before
            // anything executes (see src/control/tools.ts
            // handleComputerRequestAction / summarizeResolvedPreview above).
            if let resolvedSummary = action.resolvedSummary {
                let preview = NSMenuItem(title: "  \(resolvedSummary)", action: nil, keyEquivalent: "")
                preview.isEnabled = false
                menu.addItem(preview)
            }

            let approve = NSMenuItem(title: "  \(t("controlApprove"))", action: #selector(approvePendingControlAction(_:)), keyEquivalent: "")
            approve.target = self
            approve.representedObject = action.actionId
            menu.addItem(approve)

            let reject = NSMenuItem(title: "  \(t("controlReject"))", action: #selector(rejectPendingControlAction(_:)), keyEquivalent: "")
            reject.target = self
            reject.representedObject = action.actionId
            menu.addItem(reject)

            menu.addItem(.separator())
        }
    }

    @objc private func approvePendingControlAction(_ sender: NSMenuItem) {
        guard let actionId = sender.representedObject as? String else { return }
        controller.performLocalControl("/control/actions/\(actionId)/approve") { [weak self] _ in self?.refreshStatus() }
    }

    @objc private func rejectPendingControlAction(_ sender: NSMenuItem) {
        guard let actionId = sender.representedObject as? String else { return }
        controller.performLocalControl("/control/actions/\(actionId)/reject") { [weak self] _ in self?.refreshStatus() }
    }

    @objc private func approveAllPendingControlActions() {
        controller.performLocalControl("/control/actions/approve-all") { [weak self] _ in self?.refreshStatus() }
    }

    /// Local-human-only auto-approve toggle: always shells out to
    /// `chatgpt2codex control auto on|off` (ServiceController above), never
    /// writes the AUTO scope file directly.
    @objc private func toggleAutoApprove() {
        let path = latestControlSnapshot?.autoEnabled == true ? "/control/auto/off" : "/control/auto/on"
        controller.performLocalControl(path) { [weak self] _ in self?.refreshStatus() }
    }

    @objc private func toggleAgentArm() {
        let path = latestControlSnapshot?.armed == true ? "/control/disarm" : "/control/arm"
        controller.performLocalControl(path) { [weak self] _ in self?.refreshStatus() }
    }

    @objc private func toggleChatGptRemoteControl() {
        let enabled = !controller.chatGptRemoteControlEnabled
        controller.setChatGptRemoteControlEnabledForSession(enabled)
        rebuildMenu()
        let shouldRestart = latestHealth || controller.isManagedProcessRunning || controller.startMCPOnLaunch
        guard shouldRestart else {
            refreshStatus()
            return
        }
        statusMenuItem.title = "ChatGPT To Codex: \(t("statusRestarting"))"
        controller.restart { [weak self] _ in
            self?.refreshStatus()
        }
    }

    private static let settingsHotKeySignature: OSType = 0x43324353 // C2CS
    private static let settingsHotKeyIdentifier: UInt32 = 1
    private static let settingsHotKeyHandler: EventHandlerUPP = { _, event, userData in
        guard let event, let userData else { return OSStatus(eventNotHandledErr) }
        var hotKeyID = EventHotKeyID()
        let readStatus = GetEventParameter(
            event,
            EventParamName(kEventParamDirectObject),
            EventParamType(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &hotKeyID
        )
        guard readStatus == noErr,
              hotKeyID.signature == settingsHotKeySignature,
              hotKeyID.id == settingsHotKeyIdentifier
        else { return OSStatus(eventNotHandledErr) }
        let delegate = Unmanaged<StatusBarAppDelegate>.fromOpaque(userData).takeUnretainedValue()
        DispatchQueue.main.async { delegate.showSettingsFromGlobalHotKey() }
        return noErr
    }

    private func registerSettingsHotKey() {
        guard settingsHotKeyRef == nil, settingsHotKeyEventHandler == nil else { return }
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        var handler: EventHandlerRef?
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            Self.settingsHotKeyHandler,
            1,
            &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            &handler
        )
        guard installStatus == noErr, let handler else {
            NSLog("ChatGPT To Codex: settings hotkey event handler registration failed: %d", installStatus)
            return
        }
        var hotKey: EventHotKeyRef?
        let hotKeyID = EventHotKeyID(signature: Self.settingsHotKeySignature, id: Self.settingsHotKeyIdentifier)
        let modifiers = UInt32(controlKey) | UInt32(optionKey) | UInt32(cmdKey)
        let registrationStatus = RegisterEventHotKey(
            UInt32(kVK_ANSI_Comma),
            modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKey
        )
        guard registrationStatus == noErr, let hotKey else {
            RemoveEventHandler(handler)
            NSLog("ChatGPT To Codex: settings hotkey registration failed: %d", registrationStatus)
            return
        }
        settingsHotKeyEventHandler = handler
        settingsHotKeyRef = hotKey
    }

    private func unregisterSettingsHotKey() {
        if let hotKey = settingsHotKeyRef { UnregisterEventHotKey(hotKey) }
        if let handler = settingsHotKeyEventHandler { RemoveEventHandler(handler) }
        settingsHotKeyRef = nil
        settingsHotKeyEventHandler = nil
    }

    private func showSettingsFromGlobalHotKey() {
        showSettings()
    }

    private static let statusMenuHotKeySignature: OSType = 0x4332434D // C2CM
    private static let statusMenuHotKeyIdentifier: UInt32 = 2
    private static let statusMenuHotKeyHandler: EventHandlerUPP = { _, event, userData in
        guard let event, let userData else { return OSStatus(eventNotHandledErr) }
        var hotKeyID = EventHotKeyID()
        let readStatus = GetEventParameter(
            event,
            EventParamName(kEventParamDirectObject),
            EventParamType(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &hotKeyID
        )
        guard readStatus == noErr,
              hotKeyID.signature == statusMenuHotKeySignature,
              hotKeyID.id == statusMenuHotKeyIdentifier
        else { return OSStatus(eventNotHandledErr) }
        let delegate = Unmanaged<StatusBarAppDelegate>.fromOpaque(userData).takeUnretainedValue()
        DispatchQueue.main.async { delegate.showStatusMenuFromGlobalHotKey() }
        return noErr
    }

    /// Opens the exact menu owned by the status item, so this temporary global
    /// shortcut follows the same target/action path as a physical menu-bar click.
    private func registerStatusMenuHotKey() {
        guard statusMenuHotKeyRef == nil, statusMenuHotKeyEventHandler == nil else { return }
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        var handler: EventHandlerRef?
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            Self.statusMenuHotKeyHandler,
            1,
            &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            &handler
        )
        guard installStatus == noErr, let handler else {
            NSLog("ChatGPT To Codex: status-menu hotkey event handler registration failed: %d", installStatus)
            return
        }
        var hotKey: EventHotKeyRef?
        let hotKeyID = EventHotKeyID(signature: Self.statusMenuHotKeySignature, id: Self.statusMenuHotKeyIdentifier)
        let modifiers = UInt32(controlKey) | UInt32(optionKey) | UInt32(cmdKey)
        let registrationStatus = RegisterEventHotKey(
            UInt32(kVK_ANSI_M),
            modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKey
        )
        guard registrationStatus == noErr, let hotKey else {
            RemoveEventHandler(handler)
            NSLog("ChatGPT To Codex: status-menu hotkey registration failed: %d", registrationStatus)
            return
        }
        statusMenuHotKeyEventHandler = handler
        statusMenuHotKeyRef = hotKey
    }

    private func unregisterStatusMenuHotKey() {
        if let hotKey = statusMenuHotKeyRef { UnregisterEventHotKey(hotKey) }
        if let handler = statusMenuHotKeyEventHandler { RemoveEventHandler(handler) }
        statusMenuHotKeyRef = nil
        statusMenuHotKeyEventHandler = nil
    }

    private func showStatusMenuFromGlobalHotKey() {
        showActivityWindow()
        refreshStatus()
    }

    /// Global emergency-stop hotkey (⌃⌥⌘.) for Option B desktop control:
    /// pressed anywhere on the system, it calls `chatgpt2codex control kill`
    /// immediately via the same runCli path as the menu item, with no
    /// confirmation dialog — unlike the menu's killControlAction, a
    /// deliberately pressed panic-button combo shouldn't need a second click
    /// to take effect. Registered only when control is enabled at all
    /// (isControlEnabled()); doing nothing when it's off means the hotkey is
    /// never even listened for, matching every other control gate.
    private func isKillHotkeyEvent(_ event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        // kVK_ANSI_Period = 47 on a US layout; deviceIndependentFlagsMask
        // keeps this keyCode-based match layout-agnostic for the modifiers.
        return mods == [.control, .option, .command] && event.keyCode == 47
    }

    private func registerGlobalKillHotkeyIfNeeded() {
        guard controller.controlEnabled else { return }
        killHotkeyGlobalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.isKillHotkeyEvent(event) else { return }
            self.controller.performLocalControl("/control/kill")
        }
        killHotkeyLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            if self.isKillHotkeyEvent(event) {
                self.controller.performLocalControl("/control/kill")
                return nil
            }
            return event
        }
    }

    @objc private func killControlAction() {
        let alert = NSAlert()
        alert.messageText = t("killControlConfirmTitle")
        alert.informativeText = t("killControlConfirmInfo")
        alert.alertStyle = .warning
        alert.addButton(withTitle: t("killControlMenu"))
        alert.addButton(withTitle: t("cancel"))
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        controller.performLocalControl("/control/kill") { [weak self] _ in self?.refreshStatus() }
    }

    @objc private func selectProjectFolder() {
        let panel = NSOpenPanel()
        panel.title = t("selectProjectFolderTitle")
        panel.prompt = t("select")
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = controller.selectedProjectFolder ?? URL(fileURLWithPath: controller.workspace)
        NSApp.activate(ignoringOtherApps: true)
        panel.begin { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            _ = self.controller.ensureWorkspaceDirectory(url)
            let shouldRestart = self.latestHealth || self.controller.isManagedProcessRunning
            self.controller.setSelectedProjectFolder(url)
            self.rebuildMenu()
            self.restartAfterSavedSettingsIfConfirmed(shouldRestart)
        }
    }

    @objc private func showSettings() {
        if let existingWindow = settingsWindow {
            NSApp.activate(ignoringOtherApps: true)
            existingWindow.makeKeyAndOrderFront(nil)
            return
        }
        let width: CGFloat = 540
        let hintWidth: CGFloat = 322
        let publicHintY: CGFloat = 450
        let hintFont = NSFont.systemFont(ofSize: 10)
        func measuredHintHeight(_ text: String, width: CGFloat) -> CGFloat {
            let rect = (text as NSString).boundingRect(
                with: NSSize(width: width, height: CGFloat.greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: [.font: hintFont]
            )
            return max(58, ceil(rect.height) + 8)
        }
        let publicHintText = controller.effectiveLanguageCode == "ko"
            ? "비워두면 Cloudflare Quick Tunnel을 사용합니다. 호스트명은 기존 Cloudflare named tunnel token/name이 함께 설정된 경우에만 고정 주소로 사용됩니다. https:// URL은 Tailscale Funnel 같은 외부 관리 터널로 사용하며 앱이 해당 터널을 시작하거나 종료하지 않습니다."
            : "Blank uses a Cloudflare Quick Tunnel. A hostname is fixed only when an existing Cloudflare named-tunnel token/name is configured. An https:// URL is treated as an externally managed tunnel and is never started or stopped by this app."
        let publicHintHeight = measuredHintHeight(publicHintText, width: hintWidth)
        let localPortY = publicHintY + publicHintHeight + 18
        let portFieldY = localPortY - 4
        let actionRow1Y = localPortY + 44
        let actionRow2Y = actionRow1Y + 38
        let footerY = actionRow2Y + 54
        let footerButtonY = footerY - 6
        let height: CGFloat = max(690, footerButtonY + 76)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = t("settingsTitle")
        window.isReleasedWhenClosed = false
        let content = FlippedView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        window.contentView = content

        func label(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat = 12, bold: Bool = false) -> NSTextField {
            let field = NSTextField(labelWithString: text)
            field.frame = NSRect(x: x, y: y, width: width, height: 20)
            field.font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
            field.textColor = .secondaryLabelColor
            return field
        }

        func hint(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat) -> NSTextField {
            let field = NSTextField(wrappingLabelWithString: text)
            field.frame = NSRect(x: x, y: y, width: width, height: height)
            field.font = hintFont
            field.textColor = .secondaryLabelColor
            field.maximumNumberOfLines = 0
            field.cell?.wraps = true
            return field
        }

        func field(_ value: String, x: CGFloat, y: CGFloat, width: CGFloat, placeholder: String = "") -> NSTextField {
            let textField = NSTextField(string: value)
            textField.frame = NSRect(x: x, y: y, width: width, height: 28)
            textField.placeholderString = placeholder
            return textField
        }

        func button(_ title: String, x: CGFloat, y: CGFloat, width: CGFloat, action: Selector) -> NSButton {
            let item = NSButton(title: title, target: self, action: action)
            item.frame = NSRect(x: x, y: y, width: width, height: 30)
            item.bezelStyle = .rounded
            return item
        }

        let iconFile = Bundle.main.resourceURL?.appendingPathComponent("chatgpt2codex-icon.png")
        let settingsIcon = iconFile.flatMap { NSImage(contentsOf: $0) } ?? NSImage(named: "AppIcon") ?? NSImage(named: "StatusIconTemplate")
        if let image = settingsIcon {
            let imageView = NSImageView(frame: NSRect(x: (width - 82) / 2, y: 12, width: 82, height: 82))
            imageView.image = image
            imageView.imageScaling = .scaleProportionallyUpOrDown
            content.addSubview(imageView)
        }
        content.addSubview(label(t("language"), x: 28, y: 142, width: 170))
        let languagePopup = NSPopUpButton(frame: .zero, pullsDown: false)
        languagePopup.frame = NSRect(x: 190, y: 138, width: 220, height: 28)
        for option in desktopLanguageOptions {
            languagePopup.addItem(withTitle: option.name)
            languagePopup.lastItem?.representedObject = option.code
        }
        if let selected = languagePopup.itemArray.first(where: { ($0.representedObject as? String) == controller.preferredLanguage }) {
            languagePopup.select(selected)
        }
        languagePopup.target = self
        languagePopup.action = #selector(settingsLanguageChanged)
        settingsLanguagePopup = languagePopup
        content.addSubview(languagePopup)

        content.addSubview(label(t("projectFolder"), x: 28, y: 184, width: 170))
        let projectField = field(controller.selectedProjectFolder?.path ?? "", x: 190, y: 180, width: 230, placeholder: controller.defaultWorkspace)
        projectField.placeholderString = controller.defaultWorkspace
        projectField.isEditable = false
        projectField.isSelectable = true
        projectField.focusRingType = .none
        settingsProjectField = projectField
        content.addSubview(projectField)
        content.addSubview(button(t("browse"), x: 428, y: 179, width: 84, action: #selector(browseProjectFolderFromSettings)))

        let launchAtLogin = NSButton(checkboxWithTitle: t("launchAtLoginSetting"), target: nil, action: nil)
        launchAtLogin.frame = NSRect(x: 190, y: 220, width: 320, height: 22)
        launchAtLogin.state = controller.launchAtLogin ? .on : .off
        settingsLaunchAtLogin = launchAtLogin
        content.addSubview(launchAtLogin)
        let startOnLaunch = NSButton(checkboxWithTitle: t("startOnOpenSetting"), target: nil, action: nil)
        startOnLaunch.frame = NSRect(x: 190, y: 246, width: 320, height: 22)
        startOnLaunch.state = controller.startMCPOnLaunch ? .on : .off
        settingsStartOnLaunch = startOnLaunch
        content.addSubview(startOnLaunch)
        let ownerTokenStatus = controller.ownerTokenStatus()
        let tokenConfigured: Bool
        let tokenStatusText: String
        let tokenStatusColor: NSColor
        switch ownerTokenStatus {
        case .configured:
            tokenConfigured = true
            tokenStatusText = t("ownerTokenReady")
            tokenStatusColor = .systemGreen
        case .missing:
            tokenConfigured = false
            tokenStatusText = t("ownerTokenMissing")
            tokenStatusColor = .systemOrange
        case .checkFailed:
            tokenConfigured = false
            tokenStatusText = t("ownerTokenCheckFailed")
            tokenStatusColor = .systemRed
        }
        settingsOwnerTokenConfigured = tokenConfigured
        content.addSubview(label(t("ownerToken"), x: 28, y: 272, width: 170))
        let tokenStatus = label(tokenStatusText, x: 190, y: 272, width: 170)
        tokenStatus.textColor = tokenStatusColor
        settingsOwnerTokenStatus = tokenStatus
        content.addSubview(tokenStatus)
        let tokenButton = button(t("ownerTokenGenerateCopy"), x: 190, y: 296, width: 210, action: #selector(generateAndCopyOwnerToken))
        tokenButton.isEnabled = ownerTokenStatus != .checkFailed
        settingsOwnerTokenButton = tokenButton
        content.addSubview(tokenButton)
        let tokenCopyButton = button(t("ownerTokenCopy"), x: 410, y: 296, width: 102, action: #selector(copyStoredOwnerToken))
        tokenCopyButton.isEnabled = loadOwnerTokenFromKeychain() != nil
        settingsOwnerTokenCopyButton = tokenCopyButton
        content.addSubview(tokenCopyButton)

        let multiProjectLanes = NSButton(checkboxWithTitle: t("multiProjectLanesSetting"), target: nil, action: nil)
        multiProjectLanes.frame = NSRect(x: 190, y: 334, width: 322, height: 22)
        multiProjectLanes.state = controller.multiProjectLanesEnabled ? .on : .off
        settingsMultiProjectLanes = multiProjectLanes
        content.addSubview(multiProjectLanes)

        let showIntermediateCommentary = NSButton(
            checkboxWithTitle: t("showIntermediateCommentarySetting"),
            target: self,
            action: #selector(toggleIntermediateCommentarySetting(_:))
        )
        showIntermediateCommentary.frame = NSRect(x: 190, y: 360, width: 322, height: 22)
        showIntermediateCommentary.state = controller.showIntermediateCommentary ? .on : .off
        settingsShowIntermediateCommentary = showIntermediateCommentary
        content.addSubview(showIntermediateCommentary)

        let publicTunnel = NSButton(checkboxWithTitle: t("publicTunnelSetting"), target: nil, action: nil)
        publicTunnel.frame = NSRect(x: 190, y: 386, width: 322, height: 22)
        publicTunnel.state = controller.enablePublicTunnel ? .on : .off
        settingsPublicTunnel = publicTunnel
        content.addSubview(publicTunnel)

        let publicEndpointLabel = controller.effectiveLanguageCode == "ko" ? "공개 호스트 / 외부 HTTPS URL" : "Public host / external HTTPS URL"
        content.addSubview(label(publicEndpointLabel, x: 28, y: 422, width: 170))
        let hostField = field(controller.savedPublicHost ?? "", x: 190, y: 418, width: 230, placeholder: "host.example.com or https://...")
        settingsHostField = hostField
        content.addSubview(hostField)
        content.addSubview(button(t("fixedDomainSetup"), x: 428, y: 417, width: 84, action: #selector(showFixedDomainSetup)))
        content.addSubview(hint(publicHintText, x: 190, y: publicHintY, width: hintWidth, height: publicHintHeight))
        content.addSubview(label(t("localPort"), x: 28, y: localPortY, width: 170))
        let portField = field("\(controller.port)", x: 190, y: portFieldY, width: 120)
        settingsPortField = portField
        content.addSubview(portField)

        let actionColW: CGFloat = 235
        let actionCol2X: CGFloat = 277
        content.addSubview(button(t("copyConnector"), x: 28, y: actionRow1Y, width: actionColW, action: #selector(copyConnectorURL)))
        content.addSubview(button(t("openStatus"), x: actionCol2X, y: actionRow1Y, width: actionColW, action: #selector(openStatus)))
        content.addSubview(button(controller.effectiveLanguageCode == "ko" ? "권한 / 도구…" : "Permissions / Tools…", x: 28, y: actionRow2Y, width: actionColW, action: #selector(showPermissionsToolsCommandMenu(_:))))
        content.addSubview(button(t("checkUpdates"), x: actionCol2X, y: actionRow2Y, width: actionColW, action: #selector(checkForUpdates)))
        let copyright = label("v\(controller.appVersion) - Copyright 2026 ezBuilder. All rights reserved.", x: 28, y: footerY, width: 340, size: 11)
        content.addSubview(copyright)
        content.addSubview(button(t("cancel"), x: 338, y: footerButtonY, width: 78, action: #selector(cancelSettings)))
        let saveButton = button(t("save"), x: 426, y: footerButtonY, width: 86, action: #selector(saveSettings))
        saveButton.keyEquivalent = "\r"
        content.addSubview(saveButton)

        settingsWindow = window
        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func settingsLanguageChanged(_ sender: NSPopUpButton) {
        if let language = sender.selectedItem?.representedObject as? String {
            controller.setPreferredLanguage(language)
            rebuildMenu()
            refreshStatus()
            settingsWindow?.close()
            settingsWindow = nil
            showSettings()
        }
    }

    @objc private func cancelSettings() {
        settingsWindow?.close()
        settingsWindow = nil
    }

    @objc private func toggleIntermediateCommentarySetting(_ sender: NSButton) {
        controller.setShowIntermediateCommentary(sender.state == .on)
    }

    @objc private func showFixedDomainSetup() {
        let host = settingsHostField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayHost = host?.isEmpty == false ? host! : "chatgpt2codex.example.com"
        let message = String(format: t("fixedDomainSetupInfo"), "\(controller.port)", displayHost)
        let alert = NSAlert()
        alert.messageText = t("fixedDomainSetupTitle")
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.addButton(withTitle: t("openCloudflare"))
        alert.addButton(withTitle: t("copyFixedDomainSteps"))
        alert.addButton(withTitle: t("ok"))
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            if let url = URL(string: "https://dash.cloudflare.com/?to=/:account/zero-trust/networks/tunnels") {
                NSWorkspace.shared.open(url)
            }
        } else if response == .alertSecondButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(message, forType: .string)
            let copiedAlert = NSAlert()
            copiedAlert.messageText = t("fixedDomainSetupTitle")
            copiedAlert.informativeText = t("fixedDomainStepsCopied")
            copiedAlert.alertStyle = .informational
            copiedAlert.addButton(withTitle: t("ok"))
            copiedAlert.runModal()
        }
    }

    @objc private func saveSettings() {
        guard let projectField = settingsProjectField,
              let launchAtLogin = settingsLaunchAtLogin,
              let startOnLaunch = settingsStartOnLaunch,
              let multiProjectLanes = settingsMultiProjectLanes,
              let publicTunnel = settingsPublicTunnel,
              let hostField = settingsHostField,
              let portField = settingsPortField
        else { return }
        let projectPath = projectField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedHost = hostField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let parsedPort = Int(portField.stringValue)
        let requestedPort = (parsedPort ?? 0) > 0 ? parsedPort! : controller.port
        let runtimeSettingsChanged =
            projectPath != (controller.selectedProjectFolder?.path ?? "") ||
            (multiProjectLanes.state == .on) != controller.multiProjectLanesEnabled ||
            (publicTunnel.state == .on) != controller.enablePublicTunnel ||
            requestedHost != (controller.savedPublicHost ?? "") ||
            requestedPort != controller.port
        if projectPath.isEmpty {
            controller.clearSelectedProjectFolder()
        } else {
            let projectURL = URL(fileURLWithPath: projectPath)
            guard controller.ensureWorkspaceDirectory(projectURL) else {
                let invalidProjectAlert = NSAlert()
                invalidProjectAlert.messageText = t("projectMarkerTitle")
                invalidProjectAlert.informativeText = t("projectMarkerInfo")
                invalidProjectAlert.addButton(withTitle: t("ok"))
                invalidProjectAlert.runModal()
                return
            }
            controller.setSelectedProjectFolder(projectURL)
        }
        controller.setLaunchAtLogin(launchAtLogin.state == .on)
        controller.setStartMCPOnLaunch(startOnLaunch.state == .on)
        controller.setMultiProjectLanesEnabled(multiProjectLanes.state == .on)
        controller.setEnablePublicTunnel(publicTunnel.state == .on)
        controller.setPublicHostname(requestedHost)
        controller.setPort(requestedPort)
        let shouldRestart = (latestHealth || controller.isManagedProcessRunning) && runtimeSettingsChanged
        settingsWindow?.close()
        settingsWindow = nil
        rebuildMenu()
        restartAfterSavedSettingsIfConfirmed(shouldRestart)
    }

    @objc private func browseProjectFolderFromSettings() {
        let panel = NSOpenPanel()
        panel.title = t("selectProjectFolderTitle")
        panel.prompt = t("select")
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = controller.selectedProjectFolder ?? URL(fileURLWithPath: controller.workspace)
        NSApp.activate(ignoringOtherApps: true)
        let applySelection: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            _ = self.controller.ensureWorkspaceDirectory(url)
            self.settingsProjectField?.stringValue = url.path
        }
        if let window = settingsWindow {
            panel.beginSheetModal(for: window, completionHandler: applySelection)
        } else {
            panel.begin(completionHandler: applySelection)
        }
    }

    @objc private func toggleLaunchAtLogin(_ sender: NSMenuItem) {
        controller.setLaunchAtLogin(sender.state != .on)
        rebuildMenu()
        refreshStatus()
    }

    @objc private func toggleStartOnLaunch(_ sender: NSMenuItem) {
        controller.setStartMCPOnLaunch(sender.state != .on)
        rebuildMenu()
        refreshStatus()
    }

    @objc private func toggleAutoCheckUpdates(_ sender: NSMenuItem) {
        controller.setAutoCheckUpdates(sender.state != .on)
        rebuildMenu()
        refreshStatus()
    }

    @objc private func openLocalHealth() {
        NSWorkspace.shared.open(controller.healthURL)
    }

    @objc private func openPublicHealth() {
        guard let url = controller.publicHealthURL else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openStatus() {
        NSWorkspace.shared.open(controller.publicHealthURL ?? controller.healthURL)
    }

    @objc private func copyConnectorURL() {
        guard let url = controller.connectorURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }

    private func copySecret(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }

    private func ownerTokenKeychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: ownerTokenKeychainService,
            kSecAttrAccount as String: ownerTokenKeychainAccount,
        ]
    }

    private func storeOwnerTokenInKeychain(_ token: String) {
        guard let data = token.data(using: .utf8) else { return }
        var query = ownerTokenKeychainQuery()
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    private func loadOwnerTokenFromKeychain() -> String? {
        var query = ownerTokenKeychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty
        else {
            return nil
        }
        return token
    }

    private func showInfo(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: t("ok"))
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    private func restartAfterOwnerTokenChange() {
        let shouldRestart = latestHealth || controller.isManagedProcessRunning || controller.startMCPOnLaunch
        rebuildMenu()
        if shouldRestart {
            statusMenuItem.title = "ChatGPT To Codex: \(t("statusRestarting"))"
            controller.restart { [weak self] _ in
                self?.refreshStatus()
            }
        } else {
            refreshStatus()
        }
    }

    @objc private func generateAndCopyOwnerToken() {
        if settingsOwnerTokenConfigured {
            let confirm = NSAlert()
            confirm.messageText = t("ownerTokenRegenerateTitle")
            confirm.informativeText = t("ownerTokenRegenerateInfo")
            confirm.addButton(withTitle: t("ownerTokenGenerateCopy"))
            confirm.addButton(withTitle: t("cancel"))
            NSApp.activate(ignoringOtherApps: true)
            guard confirm.runModal() == .alertFirstButtonReturn else { return }
        }
        settingsOwnerTokenButton?.isEnabled = false
        settingsOwnerTokenButton?.title = t("ownerTokenGenerating")
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let token = try self.controller.generateOwnerToken()
                DispatchQueue.main.async {
                    self.storeOwnerTokenInKeychain(token)
                    self.copySecret(token)
                    self.settingsOwnerTokenConfigured = true
                    self.settingsOwnerTokenStatus?.stringValue = self.t("ownerTokenCopiedStatus")
                    self.settingsOwnerTokenStatus?.textColor = .systemGreen
                    self.settingsOwnerTokenButton?.isEnabled = true
                    self.settingsOwnerTokenButton?.title = self.t("ownerTokenGenerateCopy")
                    self.settingsOwnerTokenCopyButton?.isEnabled = true
                    self.refreshStatus()
                }
            } catch {
                DispatchQueue.main.async {
                    self.settingsOwnerTokenButton?.isEnabled = true
                    self.settingsOwnerTokenButton?.title = self.t("ownerTokenGenerateCopy")
                    self.showInfo(self.t("doctorTitle"), error.localizedDescription)
                }
            }
        }
    }

    @objc private func copyStoredOwnerToken() {
        guard let token = loadOwnerTokenFromKeychain() else {
            showInfo(t("ownerTokenGeneratedTitle"), t("ownerTokenCopyUnavailable"))
            return
        }
        copySecret(token)
        settingsOwnerTokenStatus?.stringValue = t("ownerTokenCopiedStatus")
        settingsOwnerTokenStatus?.textColor = .systemGreen
    }

    @objc private func openGithubRepository() {
        NSWorkspace.shared.open(controller.githubRepoURL)
    }

    @objc private func checkForUpdates() {
        controller.checkForUpdates { [weak self] message, update in
            guard let self else { return }
            let alert = NSAlert()
            alert.messageText = self.t("updatesTitle")
            alert.informativeText = update == nil
                ? message
                : "\(message)\n\n\(self.t("updateRuntimeExplanation"))"
            if update != nil {
                alert.addButton(withTitle: self.t("installRuntimeUpdate"))
                alert.addButton(withTitle: self.t("openReleases"))
                alert.addButton(withTitle: self.t("close"))
            } else {
                alert.addButton(withTitle: self.t("ok"))
                alert.addButton(withTitle: self.t("openReleases"))
            }
            NSApp.activate(ignoringOtherApps: true)
            let response = alert.runModal()
            if response == .alertFirstButtonReturn, let update {
                self.statusMenuItem.title = self.t("updateDownloading")
                self.controller.applyRuntimeUpdate(update) { [weak self] ok, result in
                    guard let self else { return }
                    self.showInfo(
                        ok ? self.t("updateApplyComplete") : self.t("updateApplyFailed"),
                        result
                    )
                    self.refreshStatus()
                }
            } else if (update != nil && response == .alertSecondButtonReturn)
                        || (update == nil && response == .alertSecondButtonReturn) {
                NSWorkspace.shared.open(self.controller.releasesURL)
            }
            self.refreshStatus()
        }
    }

    @objc private func showAbout() {
        let alert = NSAlert()
        alert.messageText = t("aboutTitle")
        alert.informativeText = t("aboutInfo")
        alert.addButton(withTitle: t("openGithubButton"))
        alert.addButton(withTitle: t("ok"))
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.open(controller.githubRepoURL)
        }
    }

    @objc private func showLogs() {
        if !FileManager.default.fileExists(atPath: controller.logFile.path) {
            FileManager.default.createFile(atPath: controller.logFile.path, contents: nil)
        }
        let text = (try? String(contentsOf: controller.logFile, encoding: .utf8)) ?? ""
        showTextWindow(title: t("showLogs"), text: text.isEmpty ? controller.logFile.path : text, doctor: false)
    }

    @objc private func showConnectionDiagnostics() {
        let file = controller.connectionDiagnosticsFile
        let text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        let emptyMessage = "No connection events recorded yet.\n\(file.path)"
        showTextWindow(
            title: t("connectionDiagnosticsMenu").replacingOccurrences(of: "...", with: ""),
            text: text.isEmpty ? emptyMessage : text,
            doctor: false
        )
    }

    @objc private func runDoctor() {
        showTextWindow(title: t("doctorTitle"), text: t("doctorRunning"), doctor: true)
        DispatchQueue.global(qos: .userInitiated).async {
            let report = self.controller.runDoctor(repair: true)
            DispatchQueue.main.async {
                self.showTextWindow(title: self.t("doctorTitle"), text: report, doctor: true)
            }
        }
    }

    private func showTextWindow(title: String, text: String, doctor: Bool) {
        let maxLength = 200_000
        let displayText = text.count > maxLength ? String(text.suffix(maxLength)) : text

        if doctor {
            doctorWindow?.close()
        } else {
            logWindow?.close()
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 860, height: 560),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.isReleasedWhenClosed = false

        let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 860, height: 560))
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autoresizingMask = [.width, .height]

        let textView = NSTextView(frame: scrollView.bounds)
        textView.isEditable = false
        textView.isSelectable = true
        textView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.string = displayText
        textView.autoresizingMask = [.width, .height]
        scrollView.documentView = textView
        window.contentView = scrollView
        if doctor {
            doctorWindow = window
        } else {
            logWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
private let delegate = StatusBarAppDelegate()
app.delegate = delegate
app.run()
