Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$AppName = "ChatGPT To Codex"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeRoot = Resolve-Path (Join-Path $ScriptDir "..")
$SettingsDir = Join-Path $env:APPDATA $AppName
$LogDir = Join-Path $env:LOCALAPPDATA $AppName
$SettingsPath = Join-Path $SettingsDir "settings.json"
$LogPath = Join-Path $LogDir "chatgpt2codex.log"
$RepoUrlDefault = if ($env:CHATGPT2CODEX_UPDATE_REPO_URL) { $env:CHATGPT2CODEX_UPDATE_REPO_URL } else { "https://github.com/ezBuilder/chatgpt2codex" }
$StartupShortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) "ChatGPT To Codex.lnk"
New-Item -ItemType Directory -Force -Path $SettingsDir, $LogDir | Out-Null

$LanguageCodes = @(
    "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt-BR", "it",
    "nl", "pl", "ru", "tr", "vi", "id", "th", "ar", "hi", "uk"
)
$LanguageOptions = @(
    @{ Code = "auto"; Name = "Auto (System)" },
    @{ Code = "en"; Name = "English" },
    @{ Code = "ko"; Name = "한국어" },
    @{ Code = "ja"; Name = "日本語" },
    @{ Code = "zh-Hans"; Name = "简体中文" },
    @{ Code = "zh-Hant"; Name = "繁體中文" },
    @{ Code = "es"; Name = "Español" },
    @{ Code = "fr"; Name = "Français" },
    @{ Code = "de"; Name = "Deutsch" },
    @{ Code = "pt-BR"; Name = "Português (Brasil)" },
    @{ Code = "it"; Name = "Italiano" },
    @{ Code = "nl"; Name = "Nederlands" },
    @{ Code = "pl"; Name = "Polski" },
    @{ Code = "ru"; Name = "Русский" },
    @{ Code = "tr"; Name = "Türkçe" },
    @{ Code = "vi"; Name = "Tiếng Việt" },
    @{ Code = "id"; Name = "Bahasa Indonesia" },
    @{ Code = "th"; Name = "ไทย" },
    @{ Code = "ar"; Name = "العربية" },
    @{ Code = "hi"; Name = "हिन्दी" },
    @{ Code = "uk"; Name = "Українська" }
)
$Localization = @{
    defaultWorkspace = @("Default workspace", "기본 작업공간", "デフォルトワークスペース", "默认工作区", "預設工作區", "Espacio predeterminado", "Espace par défaut", "Standardarbeitsbereich", "Espaço padrão", "Area predefinita", "Standaardwerkruimte", "Domyślny obszar roboczy", "Рабочая область по умолчанию", "Varsayılan çalışma alanı", "Không gian mặc định", "Ruang kerja default", "พื้นที่ทำงานเริ่มต้น", "مساحة العمل الافتراضية", "डिफ़ॉल्ट कार्यक्षेत्र", "Типова робоча область")
    statusChecking = @("checking...", "확인 중...", "確認中...", "正在检查...", "正在檢查...", "comprobando...", "vérification...", "wird geprüft...", "verificando...", "controllo...", "controleren...", "sprawdzanie...", "проверка...", "kontrol ediliyor...", "đang kiểm tra...", "memeriksa...", "กำลังตรวจสอบ...", "جار التحقق...", "जांच हो रही है...", "перевірка...")
    statusOn = @("on", "켜짐", "オン", "开启", "開啟", "activo", "actif", "ein", "ligado", "attivo", "aan", "włączone", "вкл", "açık", "bật", "aktif", "เปิด", "تشغيل", "चालू", "увімкнено")
    statusOff = @("off", "꺼짐", "オフ", "关闭", "關閉", "inactivo", "inactif", "aus", "desligado", "spento", "uit", "wyłączone", "выкл", "kapalı", "tắt", "nonaktif", "ปิด", "إيقاف", "बंद", "вимкнено")
    projectPrefix = @("Project", "프로젝트", "プロジェクト", "项目", "專案", "Proyecto", "Projet", "Projekt", "Projeto", "Progetto", "Project", "Projekt", "Проект", "Proje", "Dự án", "Proyek", "โปรเจกต์", "المشروع", "प्रोजेक्ट", "Проєкт")
    portPrefix = @("Port", "포트", "ポート", "端口", "連接埠", "Puerto", "Port", "Port", "Porta", "Porta", "Poort", "Port", "Порт", "Bağlantı noktası", "Cổng", "Port", "พอร์ต", "المنفذ", "पोर्ट", "Порт")
    startMCP = @("Start MCP", "MCP 시작", "MCP を開始", "启动 MCP", "啟動 MCP", "Iniciar MCP", "Démarrer MCP", "MCP starten", "Iniciar MCP", "Avvia MCP", "MCP starten", "Uruchom MCP", "Запустить MCP", "MCP başlat", "Khởi động MCP", "Mulai MCP", "เริ่ม MCP", "بدء MCP", "MCP शुरू करें", "Запустити MCP")
    stopMCP = @("Stop MCP", "MCP 중지", "MCP を停止", "停止 MCP", "停止 MCP", "Detener MCP", "Arrêter MCP", "MCP stoppen", "Parar MCP", "Ferma MCP", "MCP stoppen", "Zatrzymaj MCP", "Остановить MCP", "MCP durdur", "Dừng MCP", "Hentikan MCP", "หยุด MCP", "إيقاف MCP", "MCP रोकें", "Зупинити MCP")
    restartMCP = @("Restart MCP", "MCP 재시작", "MCP を再起動", "重启 MCP", "重新啟動 MCP", "Reiniciar MCP", "Redémarrer MCP", "MCP neu starten", "Reiniciar MCP", "Riavvia MCP", "MCP herstarten", "Uruchom ponownie MCP", "Перезапустить MCP", "MCP yeniden başlat", "Khởi động lại MCP", "Mulai ulang MCP", "รีสตาร์ท MCP", "إعادة تشغيل MCP", "MCP फिर शुरू करें", "Перезапустити MCP")
    selectProjectFolderMenu = @("Select Project Folder...", "프로젝트 폴더 선택...", "プロジェクトフォルダを選択...", "选择项目文件夹...", "選擇專案資料夾...", "Seleccionar carpeta del proyecto...", "Choisir le dossier du projet...", "Projektordner auswählen...", "Selecionar pasta do projeto...", "Seleziona cartella progetto...", "Projectmap kiezen...", "Wybierz folder projektu...", "Выбрать папку проекта...", "Proje klasörü seç...", "Chọn thư mục dự án...", "Pilih folder proyek...", "เลือกโฟลเดอร์โปรเจกต์...", "اختيار مجلد المشروع...", "प्रोजेक्ट फ़ोल्डर चुनें...", "Вибрати теку проєкту...")
    settingsMenu = @("Settings...", "설정...", "設定...", "设置...", "設定...", "Ajustes...", "Réglages...", "Einstellungen...", "Configurações...", "Impostazioni...", "Instellingen...", "Ustawienia...", "Настройки...", "Ayarlar...", "Cài đặt...", "Pengaturan...", "การตั้งค่า...", "الإعدادات...", "सेटिंग्स...", "Налаштування...")
    launchAtWindowsStartup = @("Launch at Windows Startup", "Windows 시작 시 실행", "Windows 起動時に起動", "Windows 启动时启动", "Windows 啟動時啟動", "Iniciar con Windows", "Lancer au démarrage de Windows", "Beim Windows-Start starten", "Abrir ao iniciar o Windows", "Avvia con Windows", "Starten met Windows", "Uruchamiaj z Windows", "Запускать с Windows", "Windows açılışında başlat", "Mở cùng Windows", "Jalankan saat Windows mulai", "เปิดพร้อม Windows", "التشغيل مع بدء Windows", "Windows शुरू होने पर चलाएं", "Запускати з Windows")
    startOnOpenMenu = @("Start MCP When App Opens", "앱 열 때 MCP 시작", "アプリ起動時に MCP を開始", "应用打开时启动 MCP", "App 開啟時啟動 MCP", "Iniciar MCP al abrir la app", "Démarrer MCP à l'ouverture", "MCP beim Öffnen starten", "Iniciar MCP ao abrir o app", "Avvia MCP all'apertura", "Start MCP bij openen", "Uruchamiaj MCP przy otwarciu", "Запускать MCP при открытии", "Uygulama açılınca MCP başlat", "Khởi động MCP khi mở ứng dụng", "Mulai MCP saat app dibuka", "เริ่ม MCP เมื่อเปิดแอป", "بدء MCP عند فتح التطبيق", "ऐप खुलने पर MCP शुरू करें", "Запускати MCP під час відкриття")
    autoUpdatesMenu = @("Auto Check for Updates", "업데이트 자동 확인", "更新を自動確認", "自动检查更新", "自動檢查更新", "Buscar actualizaciones automáticamente", "Recherche auto des mises à jour", "Automatisch nach Updates suchen", "Verificar atualizações automaticamente", "Controlla aggiornamenti automaticamente", "Automatisch updates zoeken", "Automatycznie sprawdzaj aktualizacje", "Автопроверка обновлений", "Güncellemeleri otomatik denetle", "Tự động kiểm tra cập nhật", "Periksa pembaruan otomatis", "ตรวจอัปเดตอัตโนมัติ", "التحقق التلقائي من التحديثات", "अपडेट अपने-आप जांचें", "Автоматично перевіряти оновлення")
    copyConnector = @("Copy Connector URL", "커넥터 URL 복사", "コネクタ URL をコピー", "复制连接器 URL", "複製連接器 URL", "Copiar URL del conector", "Copier l'URL du connecteur", "Connector-URL kopieren", "Copiar URL do conector", "Copia URL connettore", "Connector-URL kopiëren", "Kopiuj URL konektora", "Копировать URL коннектора", "Bağlayıcı URL'sini kopyala", "Sao chép URL kết nối", "Salin URL konektor", "คัดลอก URL ตัวเชื่อมต่อ", "نسخ رابط الموصل", "कनेक्टर URL कॉपी करें", "Скопіювати URL конектора")
    openLocalHealth = @("Open Local Health", "로컬 상태 열기", "ローカルヘルスを開く", "打开本地健康检查", "開啟本機健康檢查", "Abrir estado local", "Ouvrir l'état local", "Lokalen Status öffnen", "Abrir saúde local", "Apri stato locale", "Lokale status openen", "Otwórz status lokalny", "Открыть локальный статус", "Yerel durumu aç", "Mở trạng thái cục bộ", "Buka kesehatan lokal", "เปิดสถานะภายใน", "فتح حالة الجهاز", "स्थानीय हेल्थ खोलें", "Відкрити локальний стан")
    openPublicHealth = @("Open Public Health", "공개 상태 열기", "公開ヘルスを開く", "打开公开健康检查", "開啟公開健康檢查", "Abrir estado público", "Ouvrir l'état public", "Öffentlichen Status öffnen", "Abrir saúde pública", "Apri stato pubblico", "Publieke status openen", "Otwórz status publiczny", "Открыть публичный статус", "Genel durumu aç", "Mở trạng thái công khai", "Buka kesehatan publik", "เปิดสถานะสาธารณะ", "فتح الحالة العامة", "सार्वजनिक हेल्थ खोलें", "Відкрити публічний стан")
    openGithub = @("Open GitHub Repository", "GitHub 저장소 열기", "GitHub リポジトリを開く", "打开 GitHub 仓库", "開啟 GitHub 儲存庫", "Abrir repositorio GitHub", "Ouvrir le dépôt GitHub", "GitHub-Repository öffnen", "Abrir repositório GitHub", "Apri repository GitHub", "GitHub-repository openen", "Otwórz repozytorium GitHub", "Открыть репозиторий GitHub", "GitHub deposunu aç", "Mở kho GitHub", "Buka repositori GitHub", "เปิด GitHub repository", "فتح مستودع GitHub", "GitHub रिपॉज़िटरी खोलें", "Відкрити репозиторій GitHub")
    checkUpdates = @("Check for Updates...", "업데이트 확인...", "更新を確認...", "检查更新...", "檢查更新...", "Buscar actualizaciones...", "Rechercher les mises à jour...", "Nach Updates suchen...", "Verificar atualizações...", "Controlla aggiornamenti...", "Updates zoeken...", "Sprawdź aktualizacje...", "Проверить обновления...", "Güncellemeleri denetle...", "Kiểm tra cập nhật...", "Periksa pembaruan...", "ตรวจหาอัปเดต...", "التحقق من التحديثات...", "अपडेट जांचें...", "Перевірити оновлення...")
    showLogs = @("Show Logs", "로그 보기", "ログを表示", "显示日志", "顯示日誌", "Mostrar registros", "Afficher les journaux", "Logs anzeigen", "Mostrar logs", "Mostra log", "Logs tonen", "Pokaż logi", "Показать журналы", "Günlükleri göster", "Hiện nhật ký", "Tampilkan log", "แสดงบันทึก", "عرض السجلات", "लॉग दिखाएं", "Показати журнали")
    openLogFolder = @("Open Log Folder", "로그 폴더 열기", "ログフォルダを開く", "打开日志文件夹", "開啟日誌資料夾", "Abrir carpeta de registros", "Ouvrir le dossier des journaux", "Logordner öffnen", "Abrir pasta de logs", "Apri cartella log", "Logmap openen", "Otwórz folder logów", "Открыть папку журналов", "Günlük klasörünü aç", "Mở thư mục nhật ký", "Buka folder log", "เปิดโฟลเดอร์บันทึก", "فتح مجلد السجلات", "लॉग फ़ोल्डर खोलें", "Відкрити теку журналів")
    about = @("About ezBuilder", "ezBuilder 정보", "ezBuilder について", "关于 ezBuilder", "關於 ezBuilder", "Acerca de ezBuilder", "À propos d'ezBuilder", "Über ezBuilder", "Sobre ezBuilder", "Informazioni su ezBuilder", "Over ezBuilder", "O ezBuilder", "О ezBuilder", "ezBuilder hakkında", "Giới thiệu ezBuilder", "Tentang ezBuilder", "เกี่ยวกับ ezBuilder", "حول ezBuilder", "ezBuilder के बारे में", "Про ezBuilder")
    quit = @("Quit", "종료", "終了", "退出", "結束", "Salir", "Quitter", "Beenden", "Sair", "Esci", "Afsluiten", "Zakończ", "Выход", "Çık", "Thoát", "Keluar", "ออก", "إنهاء", "बंद करें", "Вийти")
    settingsTitle = @("ChatGPT To Codex Settings", "ChatGPT To Codex 설정", "ChatGPT To Codex 設定", "ChatGPT To Codex 设置", "ChatGPT To Codex 設定", "Ajustes de ChatGPT To Codex", "Réglages de ChatGPT To Codex", "ChatGPT To Codex Einstellungen", "Configurações do ChatGPT To Codex", "Impostazioni ChatGPT To Codex", "ChatGPT To Codex instellingen", "Ustawienia ChatGPT To Codex", "Настройки ChatGPT To Codex", "ChatGPT To Codex ayarları", "Cài đặt ChatGPT To Codex", "Pengaturan ChatGPT To Codex", "การตั้งค่า ChatGPT To Codex", "إعدادات ChatGPT To Codex", "ChatGPT To Codex सेटिंग्स", "Налаштування ChatGPT To Codex")
    language = @("Language", "언어", "言語", "语言", "語言", "Idioma", "Langue", "Sprache", "Idioma", "Lingua", "Taal", "Język", "Язык", "Dil", "Ngôn ngữ", "Bahasa", "ภาษา", "اللغة", "भाषा", "Мова")
    projectFolder = @("Project folder", "프로젝트 폴더", "プロジェクトフォルダ", "项目文件夹", "專案資料夾", "Carpeta del proyecto", "Dossier du projet", "Projektordner", "Pasta do projeto", "Cartella progetto", "Projectmap", "Folder projektu", "Папка проекта", "Proje klasörü", "Thư mục dự án", "Folder proyek", "โฟลเดอร์โปรเจกต์", "مجلد المشروع", "प्रोजेक्ट फ़ोल्डर", "Тека проєкту")
    browse = @("Browse...", "찾아보기...", "参照...", "浏览...", "瀏覽...", "Examinar...", "Parcourir...", "Durchsuchen...", "Procurar...", "Sfoglia...", "Bladeren...", "Przeglądaj...", "Обзор...", "Gözat...", "Duyệt...", "Telusuri...", "เรียกดู...", "استعراض...", "ब्राउज़...", "Огляд...")
    publicHostname = @("Owned fixed domain (optional)", "본인 소유 고정 도메인 (선택)", "所有する固定ドメイン (任意)", "自有固定域名（可选）", "自有固定網域（選填）", "Dominio fijo propio (opcional)", "Domaine fixe personnel (facultatif)", "Eigene feste Domain (optional)", "Domínio fixo próprio (opcional)", "Dominio fisso personale (opzionale)", "Eigen vast domein (optioneel)", "Własna stała domena (opcjonalnie)", "Собственный постоянный домен (необязательно)", "Kendi sabit alan adınız (isteğe bağlı)", "Tên miền cố định của bạn (tùy chọn)", "Domain tetap milik Anda (opsional)", "โดเมนคงที่ของคุณ (ไม่บังคับ)", "نطاق ثابت تملكه (اختياري)", "आपका स्थिर डोमेन (वैकल्पिक)", "Власний сталий домен (необов'язково)")
    publicHostnameHint = @("Blank uses a temporary Quick Tunnel URL. It changes on restart, so ChatGPT must reconnect. For daily use, enter your own Cloudflare Named Tunnel hostname.", "비워두면 임시 Quick Tunnel URL을 사용합니다. 재시작하면 주소가 바뀌므로 ChatGPT를 다시 연결해야 합니다. 매일 쓰려면 본인 Cloudflare Named Tunnel 호스트명을 입력하세요.", "空欄では一時 Quick Tunnel URL を使います。再起動で変わるため ChatGPT の再接続が必要です。日常利用は自分の Cloudflare Named Tunnel ホスト名を入力してください。", "留空会使用临时 Quick Tunnel URL。重启后会变化，因此需要重新连接 ChatGPT。日常使用请填写自己的 Cloudflare Named Tunnel 主机名。", "留空會使用臨時 Quick Tunnel URL。重新啟動後會變更，因此需要重新連接 ChatGPT。日常使用請填入自己的 Cloudflare Named Tunnel 主機名稱。", "En blanco usa una URL temporal de Quick Tunnel. Cambia al reiniciar, así que ChatGPT debe reconectarse. Para uso diario, introduce tu propio hostname de Cloudflare Named Tunnel.", "Vide, utilise une URL Quick Tunnel temporaire. Elle change au redémarrage, donc ChatGPT doit être reconnecté. Pour l'usage quotidien, entrez votre hostname Cloudflare Named Tunnel.", "Leer nutzt eine temporäre Quick-Tunnel-URL. Sie ändert sich beim Neustart, daher muss ChatGPT neu verbunden werden. Für den Alltag den eigenen Cloudflare-Named-Tunnel-Hostnamen eintragen.", "Em branco usa uma URL temporária do Quick Tunnel. Ela muda ao reiniciar, então reconecte o ChatGPT. Para uso diário, informe seu hostname do Cloudflare Named Tunnel.", "Vuoto usa un URL Quick Tunnel temporaneo. Cambia al riavvio, quindi ChatGPT va riconnesso. Per l'uso quotidiano inserisci il tuo hostname Cloudflare Named Tunnel.", "Leeg gebruikt een tijdelijke Quick Tunnel-URL. Die wijzigt na herstart, dus ChatGPT moet opnieuw verbinden. Vul voor dagelijks gebruik je eigen Cloudflare Named Tunnel-hostnaam in.", "Puste pole używa tymczasowego URL Quick Tunnel. Zmienia się po restarcie, więc ChatGPT trzeba połączyć ponownie. Do codziennego użycia wpisz własny hostname Cloudflare Named Tunnel.", "Пустое поле использует временный URL Quick Tunnel. После перезапуска он меняется, поэтому ChatGPT нужно подключить заново. Для постоянной работы укажите свой hostname Cloudflare Named Tunnel.", "Boş bırakılırsa geçici Quick Tunnel URL kullanılır. Yeniden başlatınca değişir, bu yüzden ChatGPT yeniden bağlanmalıdır. Günlük kullanım için kendi Cloudflare Named Tunnel hostname'inizi girin.", "Để trống sẽ dùng URL Quick Tunnel tạm thời. URL đổi khi khởi động lại, nên phải kết nối lại ChatGPT. Dùng hằng ngày thì nhập hostname Cloudflare Named Tunnel của bạn.", "Kosong memakai URL Quick Tunnel sementara. URL berubah saat restart, jadi ChatGPT harus disambungkan ulang. Untuk penggunaan harian, masukkan hostname Cloudflare Named Tunnel milik Anda.", "เว้นว่างเพื่อใช้ URL Quick Tunnel ชั่วคราว ซึ่งจะเปลี่ยนเมื่อรีสตาร์ท จึงต้องเชื่อมต่อ ChatGPT ใหม่ ใช้งานประจำให้ใส่ hostname Cloudflare Named Tunnel ของคุณ", "عند تركه فارغا يستخدم رابط Quick Tunnel مؤقتا. يتغير بعد إعادة التشغيل، لذلك يجب إعادة توصيل ChatGPT. للاستخدام اليومي أدخل اسم مضيف Cloudflare Named Tunnel الخاص بك.", "खाली छोड़ने पर अस्थायी Quick Tunnel URL इस्तेमाल होगा। रीस्टार्ट पर यह बदलता है, इसलिए ChatGPT को फिर जोड़ना होगा। रोज़ाना उपयोग के लिए अपना Cloudflare Named Tunnel hostname डालें।", "Порожнє поле використовує тимчасовий URL Quick Tunnel. Після перезапуску він змінюється, тому ChatGPT треба підключити знову. Для щоденного використання введіть власний hostname Cloudflare Named Tunnel.")
    githubRepositoryURL = @("GitHub repository URL", "GitHub 저장소 URL", "GitHub リポジトリ URL", "GitHub 仓库 URL", "GitHub 儲存庫 URL", "URL del repositorio GitHub", "URL du dépôt GitHub", "GitHub-Repository-URL", "URL do repositório GitHub", "URL repository GitHub", "GitHub-repository-URL", "URL repozytorium GitHub", "URL репозитория GitHub", "GitHub depo URL'si", "URL kho GitHub", "URL repositori GitHub", "URL GitHub repository", "رابط مستودع GitHub", "GitHub रिपॉज़िटरी URL", "URL репозиторію GitHub")
    launchWindowsSetting = @("Launch ChatGPT To Codex when Windows starts", "Windows 시작 시 ChatGPT To Codex 실행", "Windows 起動時に ChatGPT To Codex を起動", "Windows 启动时启动 ChatGPT To Codex", "Windows 啟動時啟動 ChatGPT To Codex", "Iniciar ChatGPT To Codex con Windows", "Lancer ChatGPT To Codex au démarrage de Windows", "ChatGPT To Codex beim Windows-Start starten", "Abrir ChatGPT To Codex ao iniciar o Windows", "Avvia ChatGPT To Codex con Windows", "ChatGPT To Codex starten met Windows", "Uruchamiaj ChatGPT To Codex z Windows", "Запускать ChatGPT To Codex с Windows", "Windows açılışında ChatGPT To Codex başlat", "Mở ChatGPT To Codex cùng Windows", "Jalankan ChatGPT To Codex saat Windows mulai", "เปิด ChatGPT To Codex พร้อม Windows", "تشغيل ChatGPT To Codex عند بدء Windows", "Windows शुरू होने पर ChatGPT To Codex चलाएं", "Запускати ChatGPT To Codex з Windows")
    startOnOpenSetting = @("Start MCP automatically when the app opens", "앱 열 때 MCP 자동 시작", "アプリ起動時に MCP を自動開始", "应用打开时自动启动 MCP", "App 開啟時自動啟動 MCP", "Iniciar MCP automáticamente al abrir la app", "Démarrer MCP automatiquement à l'ouverture", "MCP beim Öffnen automatisch starten", "Iniciar MCP automaticamente ao abrir o app", "Avvia MCP automaticamente all'apertura", "Start MCP automatisch bij openen", "Automatycznie uruchamiaj MCP przy otwarciu", "Автоматически запускать MCP при открытии", "Uygulama açılınca MCP otomatik başlasın", "Tự động khởi động MCP khi mở ứng dụng", "Mulai MCP otomatis saat app dibuka", "เริ่ม MCP อัตโนมัติเมื่อเปิดแอป", "بدء MCP تلقائيا عند فتح التطبيق", "ऐप खुलने पर MCP अपने-आप शुरू करें", "Автоматично запускати MCP під час відкриття")
    autoUpdatesSetting = @("Check for updates automatically", "업데이트 자동 확인", "更新を自動確認", "自动检查更新", "自動檢查更新", "Buscar actualizaciones automáticamente", "Recherche automatique des mises à jour", "Automatisch nach Updates suchen", "Verificar atualizações automaticamente", "Controlla aggiornamenti automaticamente", "Automatisch updates zoeken", "Automatycznie sprawdzaj aktualizacje", "Автоматически проверять обновления", "Güncellemeleri otomatik denetle", "Tự động kiểm tra cập nhật", "Periksa pembaruan otomatis", "ตรวจอัปเดตอัตโนมัติ", "التحقق التلقائي من التحديثات", "अपडेट अपने-आप जांचें", "Автоматично перевіряти оновлення")
    publicTunnelSetting = @("Enable ChatGPT web connector", "ChatGPT 웹 커넥터 사용", "ChatGPT Web コネクタを有効化", "启用 ChatGPT 网页连接器", "啟用 ChatGPT 網頁連接器", "Activar conector web de ChatGPT", "Activer le connecteur web ChatGPT", "ChatGPT-Web-Connector aktivieren", "Ativar conector web do ChatGPT", "Attiva connettore web ChatGPT", "ChatGPT-webconnector inschakelen", "Włącz łącznik web ChatGPT", "Включить веб-коннектор ChatGPT", "ChatGPT web bağlayıcısını aç", "Bật trình kết nối web ChatGPT", "Aktifkan konektor web ChatGPT", "เปิดตัวเชื่อมต่อเว็บ ChatGPT", "تفعيل موصل ChatGPT على الويب", "ChatGPT वेब कनेक्टर चालू करें", "Увімкнути веб-конектор ChatGPT")
    save = @("Save", "저장", "保存", "保存", "儲存", "Guardar", "Enregistrer", "Speichern", "Salvar", "Salva", "Opslaan", "Zapisz", "Сохранить", "Kaydet", "Lưu", "Simpan", "บันทึก", "حفظ", "सहेजें", "Зберегти")
    cancel = @("Cancel", "취소", "キャンセル", "取消", "取消", "Cancelar", "Annuler", "Abbrechen", "Cancelar", "Annulla", "Annuleren", "Anuluj", "Отмена", "İptal", "Hủy", "Batal", "ยกเลิก", "إلغاء", "रद्द करें", "Скасувати")
    openLogsHint = @("Open Show Logs for details.", "자세한 내용은 로그 보기를 여세요.", "詳細はログを表示してください。", "打开日志查看详情。", "開啟日誌查看詳細資料。", "Abre Mostrar registros para ver detalles.", "Ouvrez les journaux pour les détails.", "Öffne Logs anzeigen für Details.", "Abra Mostrar logs para detalhes.", "Apri Mostra log per i dettagli.", "Open Logs tonen voor details.", "Otwórz Pokaż logi, aby zobaczyć szczegóły.", "Откройте журналы для деталей.", "Ayrıntılar için günlükleri açın.", "Mở nhật ký để xem chi tiết.", "Buka log untuk detail.", "เปิดบันทึกเพื่อดูรายละเอียด", "افتح السجلات للتفاصيل.", "विवरण के लिए लॉग खोलें।", "Відкрийте журнали для деталей.")
    startFirst = @("Start MCP first, then copy the connector URL.", "먼저 MCP를 시작한 뒤 커넥터 URL을 복사하세요.", "先に MCP を開始してからコネクタ URL をコピーしてください。", "请先启动 MCP，再复制连接器 URL。", "請先啟動 MCP，再複製連接器 URL。", "Inicia MCP primero y luego copia la URL del conector.", "Démarrez MCP puis copiez l'URL du connecteur.", "Starte zuerst MCP und kopiere dann die Connector-URL.", "Inicie o MCP primeiro e copie a URL do conector.", "Avvia prima MCP, poi copia l'URL del connettore.", "Start eerst MCP en kopieer daarna de connector-URL.", "Najpierw uruchom MCP, potem skopiuj URL konektora.", "Сначала запустите MCP, затем скопируйте URL коннектора.", "Önce MCP başlatın, sonra bağlayıcı URL'sini kopyalayın.", "Khởi động MCP trước, rồi sao chép URL kết nối.", "Mulai MCP dulu, lalu salin URL konektor.", "เริ่ม MCP ก่อน แล้วคัดลอก URL ตัวเชื่อมต่อ", "ابدأ MCP أولا، ثم انسخ رابط الموصل.", "पहले MCP शुरू करें, फिर कनेक्टर URL कॉपी करें।", "Спочатку запустіть MCP, потім скопіюйте URL конектора.")
    connectorCopied = @("Connector URL copied.", "커넥터 URL을 복사했습니다.", "コネクタ URL をコピーしました。", "已复制连接器 URL。", "已複製連接器 URL。", "URL del conector copiada.", "URL du connecteur copiée.", "Connector-URL kopiert.", "URL do conector copiada.", "URL connettore copiato.", "Connector-URL gekopieerd.", "Skopiowano URL konektora.", "URL коннектора скопирован.", "Bağlayıcı URL'si kopyalandı.", "Đã sao chép URL kết nối.", "URL konektor disalin.", "คัดลอก URL ตัวเชื่อมต่อแล้ว", "تم نسخ رابط الموصل.", "कनेक्टर URL कॉपी हो गया।", "URL конектора скопійовано.")
    updateAvailable = @("Update available: {0}. Installed: {1}.", "업데이트 가능: {0}. 설치됨: {1}.", "更新があります: {0}。インストール済み: {1}。", "有可用更新：{0}。已安装：{1}。", "有可用更新：{0}。已安裝：{1}。", "Actualización disponible: {0}. Instalado: {1}.", "Mise à jour disponible : {0}. Installé : {1}.", "Update verfügbar: {0}. Installiert: {1}.", "Atualização disponível: {0}. Instalado: {1}.", "Aggiornamento disponibile: {0}. Installato: {1}.", "Update beschikbaar: {0}. Geïnstalleerd: {1}.", "Dostępna aktualizacja: {0}. Zainstalowano: {1}.", "Доступно обновление: {0}. Установлено: {1}.", "Güncelleme var: {0}. Kurulu: {1}.", "Có bản cập nhật: {0}. Đã cài: {1}.", "Pembaruan tersedia: {0}. Terpasang: {1}.", "มีอัปเดต: {0} ติดตั้งอยู่: {1}", "يتوفر تحديث: {0}. المثبت: {1}.", "अपडेट उपलब्ध: {0}. इंस्टॉल: {1}.", "Доступне оновлення: {0}. Встановлено: {1}.")
    openReleasesQuestion = @("Open releases?", "릴리즈를 열까요?", "リリースを開きますか?", "打开发布页？", "開啟發行頁？", "¿Abrir releases?", "Ouvrir les versions ?", "Releases öffnen?", "Abrir releases?", "Aprire release?", "Releases openen?", "Otworzyć wydania?", "Открыть релизы?", "Sürümler açılsın mı?", "Mở bản phát hành?", "Buka rilis?", "เปิด releases?", "فتح الإصدارات؟", "रिलीज़ खोलें?", "Відкрити релізи?")
    upToDate = @("ChatGPT To Codex is up to date ({0}).", "ChatGPT To Codex가 최신입니다 ({0}).", "ChatGPT To Codex は最新です ({0})。", "ChatGPT To Codex 已是最新版本（{0}）。", "ChatGPT To Codex 已是最新版本（{0}）。", "ChatGPT To Codex está actualizado ({0}).", "ChatGPT To Codex est à jour ({0}).", "ChatGPT To Codex ist aktuell ({0}).", "ChatGPT To Codex está atualizado ({0}).", "ChatGPT To Codex è aggiornato ({0}).", "ChatGPT To Codex is up-to-date ({0}).", "ChatGPT To Codex jest aktualny ({0}).", "ChatGPT To Codex обновлен ({0}).", "ChatGPT To Codex güncel ({0}).", "ChatGPT To Codex đã mới nhất ({0}).", "ChatGPT To Codex sudah terbaru ({0}).", "ChatGPT To Codex เป็นเวอร์ชันล่าสุด ({0})", "ChatGPT To Codex محدث ({0}).", "ChatGPT To Codex अप टू डेट है ({0})।", "ChatGPT To Codex оновлено ({0}).")
    updateCheckFailedQuestion = @("Could not check releases automatically.`n`nOpen releases page?", "릴리즈를 자동 확인하지 못했습니다.`n`n릴리즈 페이지를 열까요?", "リリースを自動確認できませんでした。`n`nリリースページを開きますか?", "无法自动检查发布。`n`n打开发布页面？", "無法自動檢查發行版。`n`n開啟發行頁？", "No se pudieron comprobar releases automáticamente.`n`n¿Abrir la página de releases?", "Impossible de vérifier les versions automatiquement.`n`nOuvrir la page des versions ?", "Releases konnten nicht automatisch geprüft werden.`n`nReleases-Seite öffnen?", "Não foi possível verificar releases automaticamente.`n`nAbrir a página de releases?", "Impossibile controllare le release automaticamente.`n`nAprire la pagina release?", "Kan releases niet automatisch controleren.`n`nReleases-pagina openen?", "Nie można automatycznie sprawdzić wydań.`n`nOtworzyć stronę wydań?", "Не удалось автоматически проверить релизы.`n`nОткрыть страницу релизов?", "Sürümler otomatik denetlenemedi.`n`nSürümler sayfası açılsın mı?", "Không thể tự động kiểm tra bản phát hành.`n`nMở trang phát hành?", "Tidak dapat memeriksa rilis otomatis.`n`nBuka halaman rilis?", "ตรวจสอบ releases อัตโนมัติไม่ได้`n`nเปิดหน้า releases?", "تعذر التحقق من الإصدارات تلقائيا.`n`nفتح صفحة الإصدارات؟", "रिलीज़ अपने-आप नहीं जांच सके।`n`nरिलीज़ पेज खोलें?", "Не вдалося автоматично перевірити релізи.`n`nВідкрити сторінку релізів?")
    aboutInfo = @("ChatGPT To Codex by ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ezBuilder의 ChatGPT To Codex`nCopyright 2026 ezBuilder. All rights reserved.", "ezBuilder による ChatGPT To Codex`nCopyright 2026 ezBuilder. All rights reserved.", "ezBuilder 出品 ChatGPT To Codex`nCopyright 2026 ezBuilder. All rights reserved.", "ezBuilder 製作 ChatGPT To Codex`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex de ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex par ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex von ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex por ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex di ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex door ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex od ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex от ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ezBuilder tarafından ChatGPT To Codex`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex bởi ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex oleh ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex โดย ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex من ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.", "ezBuilder द्वारा ChatGPT To Codex`nCopyright 2026 ezBuilder. All rights reserved.", "ChatGPT To Codex від ezBuilder`nCopyright 2026 ezBuilder. All rights reserved.")
}

function Resolve-LanguageCode([string]$Value) {
    $raw = if ($Value -and $Value -ne "auto") { $Value } else { [Globalization.CultureInfo]::CurrentUICulture.Name }
    $lower = $raw.ToLowerInvariant()
    if ($lower.StartsWith("zh-hant") -or $lower.StartsWith("zh-tw") -or $lower.StartsWith("zh-hk") -or $lower.StartsWith("zh-mo")) { return "zh-Hant" }
    if ($lower.StartsWith("zh")) { return "zh-Hans" }
    if ($lower.StartsWith("pt")) { return "pt-BR" }
    foreach ($code in $LanguageCodes) {
        $exact = $code.ToLowerInvariant()
        $prefix = $exact.Split("-")[0]
        if ($lower -eq $exact -or $lower.StartsWith("$prefix-")) { return $code }
    }
    return "en"
}

function L([string]$Key) {
    $configured = "auto"
    if ($null -ne $script:Settings -and ($script:Settings.PSObject.Properties.Name -contains "Language")) {
        $configured = $script:Settings.Language
    }
    $code = Resolve-LanguageCode $configured
    $row = $Localization[$Key]
    if (-not $row) { return $Key }
    $index = [array]::IndexOf($LanguageCodes, $code)
    if ($index -lt 0 -or $index -ge $row.Count -or -not $row[$index]) { return $row[0] }
    $value = $row[$index]
    if ($Key -eq "checkUpdates") { return ($value -replace "\.\.\.$", "" -replace "…$", "") }
    return $value
}

$script:ServiceProcess = $null
$script:LatestHealth = $false

function Load-Settings {
    if (Test-Path $SettingsPath) {
        try { return Get-Content -Raw $SettingsPath | ConvertFrom-Json } catch {}
    }
    return [pscustomobject]@{
        ProjectFolder = ""
        Port = 7979
        PublicHostname = ""
        EnablePublicTunnel = $false
        LaunchAtLogin = $false
        StartMcpOnLaunch = $false
        AutoCheckUpdates = $false
        GitHubRepoUrl = $RepoUrlDefault
        Language = "auto"
    }
}

function Save-Settings($Settings) {
    $Settings | ConvertTo-Json | Set-Content -Encoding UTF8 $SettingsPath
}

$script:Settings = Load-Settings
foreach ($entry in @{
    ProjectFolder = ""
    Port = 7979
    PublicHostname = ""
    EnablePublicTunnel = $false
    LaunchAtLogin = $false
    StartMcpOnLaunch = $false
    AutoCheckUpdates = $false
    GitHubRepoUrl = $RepoUrlDefault
    Language = "auto"
}.GetEnumerator()) {
    if (-not ($script:Settings.PSObject.Properties.Name -contains $entry.Key)) {
        $script:Settings | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value
    }
}

function Get-Port {
    if ($script:Settings.Port) { return [int]$script:Settings.Port }
    return 7979
}

function Get-Workspace {
    if ($script:Settings.ProjectFolder) { return $script:Settings.ProjectFolder }
    return Join-Path $HOME "workspace"
}

function Get-ActiveProjectRoot {
    if ($script:Settings.ProjectFolder) { return $script:Settings.ProjectFolder }
    return ""
}

function Get-EnablePublicTunnel {
    return (Get-TunnelMode) -ne "loopback"
}

function Get-TunnelMode {
    if ($env:CHATGPT2CODEX_TUNNEL_MODE -in @("loopback", "cloudflare-quick", "cloudflare-named", "external")) {
        return $env:CHATGPT2CODEX_TUNNEL_MODE
    }
    if ($env:CHATGPT2CODEX_PUBLIC_URL) { return "external" }
    if ($env:CLOUDFLARED_TUNNEL_TOKEN -or $env:CLOUDFLARED_TUNNEL_NAME) { return "cloudflare-named" }
    if (-not [bool]$script:Settings.EnablePublicTunnel) { return "loopback" }
    $value = [string]$script:Settings.PublicHostname
    if ($value) {
        $value = $value.Trim()
        if ($value.StartsWith("https://", [System.StringComparison]::OrdinalIgnoreCase) -or $value -match '^[A-Za-z0-9.-]+\.ts\.net$') {
            return "external"
        }
        return "cloudflare-named"
    }
    return "cloudflare-quick"
}

function Get-ExternalPublicBaseUrl {
    $value = if ($env:CHATGPT2CODEX_PUBLIC_URL) { [string]$env:CHATGPT2CODEX_PUBLIC_URL } else { [string]$script:Settings.PublicHostname }
    if (-not $value) { return $null }
    $value = $value.Trim()
    if (-not $value.StartsWith("https://", [System.StringComparison]::OrdinalIgnoreCase)) { $value = "https://$value" }
    $uri = $null
    if (-not [System.Uri]::TryCreate($value, [System.UriKind]::Absolute, [ref]$uri)) { return $null }
    $normalizedHost = (($uri.Host.TrimEnd('.')) -replace '^\[|\]$', '')
    $ip = $null
    $loopback = [System.Net.IPAddress]::TryParse($normalizedHost, [ref]$ip) -and [System.Net.IPAddress]::IsLoopback($ip)
    if ($uri.Scheme -ne "https" -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
        ($uri.AbsolutePath -and $uri.AbsolutePath -ne "/") -or
        $normalizedHost.Equals("localhost", [System.StringComparison]::OrdinalIgnoreCase) -or
        $normalizedHost.EndsWith(".localhost", [System.StringComparison]::OrdinalIgnoreCase) -or $loopback) { return $null }
    return $uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
}

function Test-Health {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$(Get-Port)/healthz"
        return ($response.StatusCode -eq 200 -and $response.Content -match '"ok":true')
    } catch {
        return $false
    }
}

function Discover-PublicBaseUrl {
    $mode = Get-TunnelMode
    if ($mode -eq "loopback") { return $null }
    if ($mode -eq "external") { return Get-ExternalPublicBaseUrl }
    if ($mode -eq "cloudflare-named" -and $script:Settings.PublicHostname) {
        return "https://$($script:Settings.PublicHostname)"
    }
    if (Test-Path $LogPath) {
        $text = Get-Content -Raw -ErrorAction SilentlyContinue $LogPath
        $mcpMatches = [regex]::Matches($text, 'https://[A-Za-z0-9.-]+/mcp')
        if ($mcpMatches.Count -gt 0) {
            return ($mcpMatches[$mcpMatches.Count - 1].Value -replace "/mcp$", "")
        }
        $matches = [regex]::Matches($text, 'https://[A-Za-z0-9.-]+\.trycloudflare\.com')
        if ($matches.Count -gt 0) {
            return $matches[$matches.Count - 1].Value
        }
    }
    return $null
}

function Get-PowerShellExe {
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($pwsh) { return $pwsh.Source }
    return (Get-Command powershell -ErrorAction Stop).Source
}

function Append-Log([string]$Text) {
    Add-Content -Path $LogPath -Value $Text
}

function Refresh-ProcessPath {
    $machine = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    $user = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $node = Join-Path $env:ProgramFiles "nodejs"
    $cloudflared = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe"
    $env:PATH = "$RuntimeRoot\bin;$node;$cloudflared;$env:USERPROFILE\.local\bin;$machine;$user;$env:PATH"
}

function Get-LauncherPath {
    $exe = Join-Path $RuntimeRoot "ChatGPT To Codex.exe"
    if (Test-Path $exe) { return $exe }
    return Join-Path $RuntimeRoot "windows\Start-ChatGPTToCodexTray.cmd"
}

function Show-Error([string]$Message) {
    Append-Log "[$(Get-Date -Format s)] ERROR $Message"
    [System.Windows.Forms.MessageBox]::Show(
        "$Message`n`n$(L "openLogsHint")",
        $AppName,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}

function Start-Service {
    if (Test-Health) { return }
    Refresh-ProcessPath
    $launcher = Join-Path $RuntimeRoot "start-chatgpt.ps1"
    if (-not (Test-Path $launcher)) {
        Show-Error "start-chatgpt.ps1 not found: $launcher"
        return
    }

    Append-Log "`n[$(Get-Date -Format s)] starting ChatGPT To Codex..."
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = Get-PowerShellExe
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
    $psi.WorkingDirectory = $RuntimeRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables["WORKSPACE"] = Get-Workspace
    $psi.EnvironmentVariables["PORT"] = "$(Get-Port)"
    $psi.EnvironmentVariables["PATH"] = "$RuntimeRoot\bin;$env:USERPROFILE\.local\bin;$($psi.EnvironmentVariables["PATH"])"
    $tunnelMode = Get-TunnelMode
    $psi.EnvironmentVariables["CHATGPT2CODEX_TUNNEL_MODE"] = $tunnelMode
    if ($tunnelMode -eq "external") {
        $externalUrl = Get-ExternalPublicBaseUrl
        if ($externalUrl) { $psi.EnvironmentVariables["CHATGPT2CODEX_PUBLIC_URL"] = $externalUrl }
        $psi.EnvironmentVariables.Remove("PUBLIC_HOSTNAME")
    } elseif ($tunnelMode -eq "cloudflare-named" -and $script:Settings.PublicHostname) {
        $psi.EnvironmentVariables["PUBLIC_HOSTNAME"] = $script:Settings.PublicHostname
        $psi.EnvironmentVariables.Remove("CHATGPT2CODEX_PUBLIC_URL")
    } else {
        $psi.EnvironmentVariables.Remove("PUBLIC_HOSTNAME")
        $psi.EnvironmentVariables.Remove("CHATGPT2CODEX_PUBLIC_URL")
    }
    if ($tunnelMode -ne "loopback") {
        $psi.EnvironmentVariables["CHATGPT2CODEX_EXPOSE_WEB"] = "1"
    } else {
        $psi.EnvironmentVariables.Remove("CHATGPT2CODEX_EXPOSE_WEB")
    }
    $activeRoot = Get-ActiveProjectRoot
    if ($activeRoot) {
        $psi.EnvironmentVariables["CHATGPT2CODEX_ACTIVE_PROJECT_ROOT"] = $activeRoot
        $psi.EnvironmentVariables["CHATGPT2CODEX_ACTIVE_PROJECT_PRESET"] = "full-write"
    }

    try {
        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $psi
        $process.Start() | Out-Null
        Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -Action {
            if ($EventArgs.Data) { Add-Content -Path $LogPath -Value $EventArgs.Data }
        } | Out-Null
        Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -Action {
            if ($EventArgs.Data) { Add-Content -Path $LogPath -Value $EventArgs.Data }
        } | Out-Null
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()
        Start-Sleep -Milliseconds 700
        if ($process.HasExited) {
            $tail = if (Test-Path $LogPath) { (Get-Content $LogPath -Tail 12 -ErrorAction SilentlyContinue) -join "`n" } else { "" }
            Show-Error "Start MCP exited immediately. $tail"
            return
        }
        $script:ServiceProcess = $process
    } catch {
        Show-Error "Start MCP failed: $($_.Exception.Message)"
    }
}

function Stop-Service {
    if ($script:ServiceProcess -and -not $script:ServiceProcess.HasExited) {
        try { $script:ServiceProcess.Kill($true) } catch { try { $script:ServiceProcess.Kill() } catch {} }
    }
    $script:ServiceProcess = $null

    $port = Get-Port
    $patterns = @(
        "start-chatgpt.ps1",
        "dist\\cli.js serve --http --port $port",
        "cloudflared.*127.0.0.1:$port",
        "cloudflared.*localhost:$port"
    )
    foreach ($proc in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
        $cmd = $proc.CommandLine
        if (-not $cmd) { continue }
        foreach ($pattern in $patterns) {
            if ($cmd -match $pattern) {
                try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
                break
            }
        }
    }
}

function Restart-Service {
    Stop-Service
    Start-Sleep -Seconds 1
    Start-Service
}

function Set-ProjectFolder {
    $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
    $dialog.Description = "$(L "selectProjectFolderMenu")"
    $dialog.ShowNewFolderButton = $false
    if ($script:Settings.ProjectFolder) { $dialog.SelectedPath = $script:Settings.ProjectFolder }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $script:Settings.ProjectFolder = $dialog.SelectedPath
        Save-Settings $script:Settings
        if ($script:LatestHealth) { Restart-Service }
    }
}

function Set-LaunchAtLogin([bool]$Enabled) {
    $script:Settings.LaunchAtLogin = $Enabled
    Save-Settings $script:Settings
    if ($Enabled) {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($StartupShortcutPath)
        $launcher = Get-LauncherPath
        $shortcut.TargetPath = $launcher
        $shortcut.WorkingDirectory = $RuntimeRoot
        $shortcut.Description = "ChatGPT To Codex tray controller"
        $shortcut.Save()
    } elseif (Test-Path $StartupShortcutPath) {
        Remove-Item -Force $StartupShortcutPath
    }
}

function Toggle-StartOnLaunch {
    $script:Settings.StartMcpOnLaunch = -not [bool]$script:Settings.StartMcpOnLaunch
    Save-Settings $script:Settings
}

function Toggle-AutoCheckUpdates {
    $script:Settings.AutoCheckUpdates = -not [bool]$script:Settings.AutoCheckUpdates
    Save-Settings $script:Settings
}

function Show-Settings {
    $form = [System.Windows.Forms.Form]::new()
    $form.Text = L "settingsTitle"
    $form.Width = 520
    $form.Height = 560
    $form.StartPosition = "CenterScreen"
    $form.FormBorderStyle = "FixedDialog"
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false

    $languageLabel = [System.Windows.Forms.Label]::new()
    $languageLabel.Text = L "language"
    $languageLabel.SetBounds(18, 18, 150, 24)
    $languageBox = [System.Windows.Forms.ComboBox]::new()
    $languageBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
    foreach ($option in $LanguageOptions) { [void]$languageBox.Items.Add($option.Name) }
    $selectedLanguage = if ($script:Settings.Language) { $script:Settings.Language } else { "auto" }
    $selectedIndex = 0
    for ($i = 0; $i -lt $LanguageOptions.Count; $i++) {
        if ($LanguageOptions[$i].Code -eq $selectedLanguage) { $selectedIndex = $i; break }
    }
    $languageBox.SelectedIndex = $selectedIndex
    $languageBox.SetBounds(18, 42, 220, 26)

    $projectLabel = [System.Windows.Forms.Label]::new()
    $projectLabel.Text = L "projectFolder"
    $projectLabel.SetBounds(18, 80, 150, 24)
    $projectBox = [System.Windows.Forms.TextBox]::new()
    $projectBox.Text = $script:Settings.ProjectFolder
    $projectBox.ReadOnly = $true
    $projectBox.SetBounds(18, 104, 380, 26)
    $browse = [System.Windows.Forms.Button]::new()
    $browse.Text = L "browse"
    $browse.SetBounds(408, 103, 82, 28)
    $browse.Add_Click({
        $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
        if ($projectBox.Text) { $dialog.SelectedPath = $projectBox.Text }
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            $projectBox.Text = $dialog.SelectedPath
        }
    })

    $hostLabel = [System.Windows.Forms.Label]::new()
    $hostLabel.Text = if ($script:Settings.Language -eq "ko") { "공개 호스트 / 외부 HTTPS URL" } else { "Public host / external HTTPS URL" }
    $hostLabel.SetBounds(18, 142, 210, 24)
    $hostBox = [System.Windows.Forms.TextBox]::new()
    $hostBox.Text = $script:Settings.PublicHostname
    $hostBox.SetBounds(18, 166, 300, 26)
    $hostHint = [System.Windows.Forms.Label]::new()
    $hostHint.Text = if ($script:Settings.Language -eq "ko") {
        "비워두면 Cloudflare Quick Tunnel. 호스트명은 기존 Cloudflare named tunnel token/name이 함께 설정된 경우에만 고정 주소로 사용됩니다. https:// URL은 외부 관리 터널이며 앱이 시작/종료하지 않습니다."
    } else {
        "Blank = Cloudflare Quick Tunnel. A hostname is fixed only with an existing Cloudflare named-tunnel token/name. https:// URL = externally managed; this app does not start/stop it."
    }
    $hostHint.SetBounds(18, 194, 472, 52)
    $portLabel = [System.Windows.Forms.Label]::new()
    $portLabel.Text = L "portPrefix"
    $portLabel.SetBounds(336, 142, 60, 24)
    $portBox = [System.Windows.Forms.NumericUpDown]::new()
    $portBox.Minimum = 1024
    $portBox.Maximum = 65535
    $portBox.Value = Get-Port
    $portBox.SetBounds(336, 166, 154, 26)

    $launch = [System.Windows.Forms.CheckBox]::new()
    $launch.Text = L "launchWindowsSetting"
    $launch.Checked = [bool]$script:Settings.LaunchAtLogin
    $launch.SetBounds(18, 250, 430, 26)
    $start = [System.Windows.Forms.CheckBox]::new()
    $start.Text = L "startOnOpenSetting"
    $start.Checked = [bool]$script:Settings.StartMcpOnLaunch
    $start.SetBounds(18, 276, 430, 26)
    $updates = [System.Windows.Forms.CheckBox]::new()
    $updates.Text = L "autoUpdatesSetting"
    $updates.Checked = [bool]$script:Settings.AutoCheckUpdates
    $updates.SetBounds(18, 302, 430, 26)
    $publicTunnel = [System.Windows.Forms.CheckBox]::new()
    $publicTunnel.Text = L "publicTunnelSetting"
    $publicTunnel.Checked = Get-EnablePublicTunnel
    $publicTunnel.SetBounds(18, 328, 472, 26)

    $copyButton = [System.Windows.Forms.Button]::new()
    $copyButton.Text = L "copyConnector"
    $copyButton.SetBounds(18, 364, 150, 28)
    $copyButton.Add_Click({ Copy-ConnectorUrl })
    $localHealthButton = [System.Windows.Forms.Button]::new()
    $localHealthButton.Text = L "openLocalHealth"
    $localHealthButton.SetBounds(178, 364, 150, 28)
    $localHealthButton.Add_Click({ Open-Url "http://127.0.0.1:$(Get-Port)/healthz" })
    $publicHealthButton = [System.Windows.Forms.Button]::new()
    $publicHealthButton.Text = L "openPublicHealth"
    $publicHealthButton.SetBounds(338, 364, 152, 28)
    $publicHealthButton.Add_Click({
        $base = Discover-PublicBaseUrl
        if ($base) { Open-Url "$base/healthz" }
    })
    $repoButton = [System.Windows.Forms.Button]::new()
    $repoButton.Text = L "openGithub"
    $repoButton.SetBounds(18, 398, 150, 28)
    $repoButton.Add_Click({ Open-Url (Get-RepoUrl) })
    $updatesButton = [System.Windows.Forms.Button]::new()
    $updatesButton.Text = L "checkUpdates"
    $updatesButton.SetBounds(178, 398, 150, 28)
    $updatesButton.Add_Click({ Check-Updates $true })
    $logsButton = [System.Windows.Forms.Button]::new()
    $logsButton.Text = L "showLogs"
    $logsButton.SetBounds(338, 398, 152, 28)
    $logsButton.Add_Click({ if (-not (Test-Path $LogPath)) { New-Item -ItemType File -Force -Path $LogPath | Out-Null }; Start-Process notepad.exe $LogPath })
    $logFolderButton = [System.Windows.Forms.Button]::new()
    $logFolderButton.Text = L "openLogFolder"
    $logFolderButton.SetBounds(18, 432, 150, 28)
    $logFolderButton.Add_Click({ Start-Process explorer.exe $LogDir })
    $copyright = [System.Windows.Forms.Label]::new()
    $copyright.Text = "Copyright 2026 ezBuilder. All rights reserved."
    $copyright.SetBounds(178, 437, 300, 22)

    $ok = [System.Windows.Forms.Button]::new()
    $ok.Text = L "save"
    $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $ok.SetBounds(318, 472, 82, 30)
    $cancel = [System.Windows.Forms.Button]::new()
    $cancel.Text = L "cancel"
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $cancel.SetBounds(408, 472, 82, 30)
    $form.AcceptButton = $ok
    $form.CancelButton = $cancel
    $form.Controls.AddRange(@($languageLabel, $languageBox, $projectLabel, $projectBox, $browse, $hostLabel, $hostBox, $hostHint, $portLabel, $portBox, $launch, $start, $updates, $publicTunnel, $copyButton, $localHealthButton, $publicHealthButton, $repoButton, $updatesButton, $logsButton, $logFolderButton, $copyright, $ok, $cancel))

    if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $wasRunning = $script:LatestHealth
        $script:Settings.ProjectFolder = $projectBox.Text
        $script:Settings.PublicHostname = $hostBox.Text.Trim()
        $script:Settings.Port = [int]$portBox.Value
        $script:Settings.Language = $LanguageOptions[$languageBox.SelectedIndex].Code
        $script:Settings.StartMcpOnLaunch = $start.Checked
        $script:Settings.AutoCheckUpdates = $updates.Checked
        $script:Settings.EnablePublicTunnel = $publicTunnel.Checked
        Save-Settings $script:Settings
        Set-LaunchAtLogin $launch.Checked
        if ($wasRunning) { Restart-Service }
        Refresh-Menu
    }
}

function Open-Url([string]$Url) {
    Start-Process $Url
}

function Get-RepoUrl {
    return $RepoUrlDefault
}

function Check-Updates([bool]$Manual) {
    $repo = (Get-RepoUrl).TrimEnd("/")
    $version = try { (Get-Content -Raw (Join-Path $RuntimeRoot "package.json") | ConvertFrom-Json).version } catch { "0.0.0" }
    $api = ($repo -replace "\.git$", "") -replace "^https://github.com/", "https://api.github.com/repos/"
    $api = "$api/releases/latest"
    try {
        $release = Invoke-RestMethod -UseBasicParsing -TimeoutSec 6 -Uri $api -Headers @{ "User-Agent" = "chatgpt2codex" }
        $latestRaw = $release.tag_name
        if (-not $latestRaw) { $latestRaw = $release.name }
        $latest = ($latestRaw -replace "^[vV]", "")
        if ($latest -and $latest -ne $version) {
            $message = (L "updateAvailable") -f $latest, $version
            if ($Manual) {
                if ([System.Windows.Forms.MessageBox]::Show(
                    "$message`n`n$(L "openReleasesQuestion")",
                    $AppName,
                    [System.Windows.Forms.MessageBoxButtons]::YesNo,
                    [System.Windows.Forms.MessageBoxIcon]::Information
                ) -eq [System.Windows.Forms.DialogResult]::Yes) {
                    Open-Url "$repo/releases"
                }
            } else {
                $notify.ShowBalloonTip(5000, $AppName, $message, [System.Windows.Forms.ToolTipIcon]::Info)
            }
        } elseif ($Manual) {
            [System.Windows.Forms.MessageBox]::Show(
                ((L "upToDate") -f $version),
                $AppName,
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information
            ) | Out-Null
        }
    } catch {
        if ($Manual) {
            if ([System.Windows.Forms.MessageBox]::Show(
                (L "updateCheckFailedQuestion"),
                $AppName,
                [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Warning
            ) -eq [System.Windows.Forms.DialogResult]::Yes) {
                Open-Url "$repo/releases"
            }
        }
    }
}

function Copy-ConnectorUrl {
    $base = Discover-PublicBaseUrl
    if (-not $base) {
        $notify.ShowBalloonTip(3000, $AppName, (L "startFirst"), [System.Windows.Forms.ToolTipIcon]::Info)
        return
    }
    [System.Windows.Forms.Clipboard]::SetText("$base/mcp")
    $notify.ShowBalloonTip(2000, $AppName, (L "connectorCopied"), [System.Windows.Forms.ToolTipIcon]::Info)
}

function Make-Item([string]$Text, [scriptblock]$Action) {
    $item = [System.Windows.Forms.ToolStripMenuItem]::new($Text)
    $item.Add_Click($Action)
    return $item
}

$notify = [System.Windows.Forms.NotifyIcon]::new()
$notify.Text = $AppName
$iconIco = Join-Path $RuntimeRoot "assets\chatgpt2codex-icon.ico"
$iconPath = Join-Path $RuntimeRoot "assets\chatgpt2codex-icon.png"
if (Test-Path $iconIco) {
    $notify.Icon = [System.Drawing.Icon]::new($iconIco)
} elseif (Test-Path $iconPath) {
    $bitmap = [System.Drawing.Bitmap]::FromFile($iconPath)
    $notify.Icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
} else {
    $notify.Icon = [System.Drawing.SystemIcons]::Shield
}
$notify.Visible = $true

$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$statusItem = [System.Windows.Forms.ToolStripMenuItem]::new("ChatGPT To Codex: $(L "statusChecking")")
$statusItem.Enabled = $false
$projectItem = [System.Windows.Forms.ToolStripMenuItem]::new("")
$projectItem.Enabled = $false
$portItem = [System.Windows.Forms.ToolStripMenuItem]::new("")
$portItem.Enabled = $false
$toggleItem = Make-Item (L "startMCP") { if ($script:LatestHealth) { Stop-Service } else { Start-Service } }
$restartItem = Make-Item (L "restartMCP") { Restart-Service }
$selectProjectItem = Make-Item (L "selectProjectFolderMenu") { Set-ProjectFolder }
$settingsItem = Make-Item (L "settingsMenu") { Show-Settings }
$launchAtLoginItem = Make-Item (L "launchAtWindowsStartup") { Set-LaunchAtLogin (-not [bool]$script:Settings.LaunchAtLogin); Refresh-Menu }
$startOnLaunchItem = Make-Item (L "startOnOpenMenu") { Toggle-StartOnLaunch; Refresh-Menu }
$autoUpdateItem = Make-Item (L "autoUpdatesMenu") { Toggle-AutoCheckUpdates; Refresh-Menu }
$copyItem = Make-Item (L "copyConnector") { Copy-ConnectorUrl }
$openLocalItem = Make-Item (L "openLocalHealth") { Open-Url "http://127.0.0.1:$(Get-Port)/healthz" }
$openPublicItem = Make-Item (L "openPublicHealth") {
    $base = Discover-PublicBaseUrl
    if ($base) { Open-Url "$base/healthz" }
}
$openRepoItem = Make-Item (L "openGithub") { Open-Url (Get-RepoUrl) }
$checkUpdatesItem = Make-Item (L "checkUpdates") { Check-Updates $true }
$showLogsItem = Make-Item (L "showLogs") { if (-not (Test-Path $LogPath)) { New-Item -ItemType File -Force -Path $LogPath | Out-Null }; Start-Process notepad.exe $LogPath }
$openLogFolderItem = Make-Item (L "openLogFolder") { Start-Process explorer.exe $LogDir }
$aboutItem = Make-Item (L "about") {
    [System.Windows.Forms.MessageBox]::Show(
        (L "aboutInfo"),
        $AppName,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
}
$quitItem = Make-Item (L "quit") { Stop-Service; $notify.Visible = $false; [System.Windows.Forms.Application]::Exit() }

$menu.Items.AddRange(@(
    $statusItem,
    [System.Windows.Forms.ToolStripSeparator]::new(),
    $toggleItem,
    $restartItem,
    $settingsItem,
    [System.Windows.Forms.ToolStripSeparator]::new(),
    $quitItem
))
$notify.ContextMenuStrip = $menu
$notify.Add_DoubleClick({ if ($script:LatestHealth) { Copy-ConnectorUrl } else { Start-Service } })

function Refresh-Menu {
    $script:LatestHealth = Test-Health
    $state = if ($script:LatestHealth) { L "statusOn" } else { L "statusOff" }
    $statusItem.Text = "ChatGPT To Codex: $state"
    $projectName = if ($script:Settings.ProjectFolder) { Split-Path -Leaf $script:Settings.ProjectFolder } else { L "defaultWorkspace" }
    $projectItem.Text = "$(L "projectPrefix"): $projectName"
    $portItem.Text = "$(L "portPrefix"): $(Get-Port)"
    $toggleItem.Text = if ($script:LatestHealth) { L "stopMCP" } else { L "startMCP" }
    $restartItem.Text = L "restartMCP"
    $selectProjectItem.Text = L "selectProjectFolderMenu"
    $settingsItem.Text = L "settingsMenu"
    $launchAtLoginItem.Text = L "launchAtWindowsStartup"
    $startOnLaunchItem.Text = L "startOnOpenMenu"
    $autoUpdateItem.Text = L "autoUpdatesMenu"
    $copyItem.Text = L "copyConnector"
    $openLocalItem.Text = L "openLocalHealth"
    $openPublicItem.Text = L "openPublicHealth"
    $openRepoItem.Text = L "openGithub"
    $checkUpdatesItem.Text = L "checkUpdates"
    $showLogsItem.Text = L "showLogs"
    $openLogFolderItem.Text = L "openLogFolder"
    $aboutItem.Text = L "about"
    $quitItem.Text = L "quit"
    $launchAtLoginItem.Checked = [bool]$script:Settings.LaunchAtLogin
    $startOnLaunchItem.Checked = [bool]$script:Settings.StartMcpOnLaunch
    $autoUpdateItem.Checked = [bool]$script:Settings.AutoCheckUpdates
    $base = Discover-PublicBaseUrl
    $copyItem.Enabled = [bool]$base
    $openPublicItem.Enabled = [bool]$base
    $notify.Text = "ChatGPT To Codex MCP: $state"
}

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 3000
$timer.Add_Tick({ Refresh-Menu })
$timer.Start()
Refresh-Menu
if ($script:Settings.AutoCheckUpdates) { Check-Updates $false }
if ($script:Settings.StartMcpOnLaunch) { Start-Service }
[System.Windows.Forms.Application]::Run()
