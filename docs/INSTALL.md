# ChatGPT To Codex Installation Guide

Source version: `0.2.0`

Installers are available only when the matching asset is attached to an
official GitHub Release after platform-specific acceptance. The current source
version or a successful build on another operating system does not prove that a
signed installer has been published. Release binaries are not stored in the Git
tree.

Only download installers from the official GitHub release page. Keep the Owner
Token private; treat it like a password.

> **Development fork:** This repository is a development fork of
> [ezBuilder/chatgpt2codex](https://github.com/ezBuilder/chatgpt2codex), with
> separate modifications applied here.

## Korean

### 이 앱은 무엇인가요?

ChatGPT To Codex는 내 Mac 또는 Windows PC에서 실행되는 로컬 코딩 연결 앱입니다. ChatGPT가 내 전체 컴퓨터를 가져가는 것이 아니라, 내가 선택한 프로젝트 폴더 안에서만 파일 읽기, 코드 수정, 테스트 실행 같은 작업을 하게 해줍니다. 네이티브 E2E 화면 캡처와 데스크톱 제어는 현재 macOS에서만 지원됩니다.

### 왜 DMG를 사용하나요?

앱 번들 안에 Node.js, cloudflared, MCP 런타임과 보조 실행 파일이 모두 들어 있으므로 별도 설치 프로그램이 필요하지 않습니다. DMG를 열고 Applications로 드래그하는 일반적인 Mac 설치 방식을 사용합니다.

### macOS 설치

1. 공식 GitHub Release에 서명·공증된 DMG가 실제로 첨부된 경우에만 해당 asset을 다운로드합니다.
2. Finder에서 `.dmg` 파일을 열고 **ChatGPT To Codex**를 **Applications** 바로가기로 드래그합니다.
3. macOS가 "확인할 수 없는 개발자" 또는 "악성 소프트웨어를 확인할 수 없음"이라고 막으면:
   - 파일을 Control-클릭 또는 오른쪽 클릭합니다.
   - **열기**를 누릅니다.
   - 그래도 막히면 **시스템 설정** -> **개인정보 보호 및 보안**에서 **그래도 열기**를 누릅니다.
4. 설치가 끝나면 **응용 프로그램**에서 **ChatGPT To Codex**를 실행합니다.
5. 화면 위 메뉴 막대에 아이콘이 보이면 실행된 것입니다.

### Windows 설치

1. 공식 GitHub Release에 Windows runner 검증을 통과한 setup asset이 실제로 첨부된 경우에만 다운로드합니다.
2. 파일을 더블클릭합니다.
3. Windows SmartScreen이 경고하면 **추가 정보** -> **실행**을 누릅니다. 단, 반드시 이 GitHub 릴리스에서 받은 파일일 때만 진행하세요.
4. 설치가 끝나면 **ChatGPT To Codex**를 실행합니다.
5. 오른쪽 아래 시스템 트레이에 아이콘이 보이면 실행된 것입니다.
6. 설치 중 Node.js LTS 또는 cloudflared가 없으면 앱이 설치를 안내할 수 있습니다.

### 첫 설정

1. macOS는 메뉴 막대 아이콘, Windows는 시스템 트레이 아이콘을 누릅니다.
2. **Settings...**를 엽니다.
3. **Project folder**에서 ChatGPT가 도와줄 프로젝트 폴더를 고릅니다.
4. ChatGPT 웹에서 연결하려면 **ChatGPT web connector**를 켭니다.
5. 고정 도메인이 없다면 도메인 칸은 비워둡니다. 그러면 임시 `trycloudflare.com` 주소가 만들어질 수 있습니다.
6. **Start MCP**를 누릅니다.
7. 상태가 켜질 때까지 기다립니다.
8. **Copy Connector URL**을 누릅니다. 주소는 `/mcp`로 끝나야 합니다.
9. ChatGPT의 Apps, Apps & Connectors, 또는 Connectors 설정에서 새 앱/커넥터를 만듭니다.
10. 복사한 `/mcp` 주소를 붙여넣습니다.
11. 승인 화면이 나오면 ChatGPT To Codex 앱에서 Owner Token을 복사해 입력합니다.

### E2E 스크린샷 사용

ChatGPT에 이렇게 말할 수 있습니다.

```text
ChatGPT To Codex로 앱을 실행하고 E2E 테스트를 돌린 뒤 스크린샷을 캡처해서 보여줘.
```

macOS 권한이 필요할 수 있습니다.

- **Screen Recording**: 화면 캡처용
- **Accessibility**: 특정 앱 창 위치를 잡고 캡처할 때 필요

막히면 **System Settings** -> **Privacy & Security**에서 ChatGPT To Codex 권한을 켜고 다시 실행하세요.

Windows 네이티브 데스크톱 캡처와 클릭·타이핑 제어는 아직 지원되지 않습니다. 트레이의 `Agent Arm: Windows에서 아직 지원 안 됨` 표시는 정상이며, 프로젝트 파일·명령·Git·이미지 저장·세션 상태 기능은 계속 사용할 수 있습니다.

### 연결 오류 로그 확인

도구는 보이지만 실제 호출이 400 등으로 실패하면 macOS 메뉴 막대 또는 Windows
트레이에서 **연결 진단 로그...**를 엽니다. 같은 시각의 `HTTP_...` 코드와
`diag_...` ID를 확인하세요. 해당 시각에 이벤트가 없으면 요청이 로컬 앱까지
도착하지 않은 것이므로 ChatGPT 연결을 다시 확인합니다. 자세한 내용은
[CONNECTION-DIAGNOSTICS.ko.md](CONNECTION-DIAGNOSTICS.ko.md)를 참고하세요.

### 주의

- Owner Token은 비밀번호처럼 다루세요.
- 임시 `trycloudflare.com` 주소는 앱이나 터널을 재시작하면 바뀔 수 있습니다.
- 앱의 **업데이트 확인**으로 런타임 업데이트를 적용하면 cloudflared는 계속 실행되어 임시 주소와 커넥터 등록이 유지됩니다. 메뉴 막대 UI 변경은 다음 앱 실행 때 반영됩니다.
- 로컬 소스 수정과 supervisor 교체는 공개 설치 절차와 별개인 개발 작업입니다. 설치본에는 공식 Release artifact만 사용하세요.
- Windows SmartScreen 경고는 아직 널리 알려지지 않은 새 설치파일에서 보일 수 있습니다. 공식 릴리스 파일인지 확인한 뒤 진행하세요.

## English

### What is it?

ChatGPT To Codex is a local macOS and Windows app that lets ChatGPT work inside a project folder you choose. It can read files, apply patches, and run checks on both platforms. Native E2E screen capture and desktop control are currently macOS-only.

### Why DMG?

The app bundle includes Node.js, cloudflared, the MCP runtime, and native helpers, so a separate installer is unnecessary. Open the DMG and use the standard drag-to-Applications flow.

### Install on macOS

1. Download the DMG only when a signed and notarized asset is attached to an official GitHub Release.
2. Open the DMG and drag **ChatGPT To Codex** onto the **Applications** shortcut.
3. If macOS blocks it because it is unsigned, Control-click the file, choose **Open**, then confirm. If needed, open **System Settings** -> **Privacy & Security** -> **Open Anyway**.
4. Open **ChatGPT To Codex** from **Applications**.
5. Click the menu bar icon to confirm it is running.

### Install on Windows

1. Download the Windows setup asset only when Windows runner acceptance is recorded on an official GitHub Release.
2. Double-click the installer.
3. If Windows SmartScreen appears, choose **More info** -> **Run anyway** only if the file came from this GitHub release.
4. Open **ChatGPT To Codex**.
5. Confirm the tray icon appears near the clock.
6. If Node.js LTS or cloudflared is missing, follow the app's setup prompt.

### First setup

1. Open **Settings...** from the macOS menu bar icon or Windows tray icon.
2. Choose your **Project folder**.
3. Enable **ChatGPT web connector** if ChatGPT in the browser needs to reach this computer.
4. Click **Start MCP**.
5. Click **Copy Connector URL**. It should end with `/mcp`.
6. Add that URL in ChatGPT under Apps, Apps & Connectors, or Connectors.
7. Approve the connection with the Owner Token from the app.

### E2E screenshots

Try:

```text
Use ChatGPT To Codex to run E2E, open the app, capture screenshots, and show them inline.
```

macOS may ask for Screen Recording and Accessibility permissions. Enable them in **System Settings** -> **Privacy & Security**.

Native Windows desktop capture and click/type control are not implemented yet. `Agent Arm: unavailable on Windows` is expected; workspace, command, Git, image intake, and session-status features remain available.

### Connection diagnostics

If tools are visible but a real call fails, open **Connection Diagnostics...**
from the macOS menu bar or Windows tray. Match the failure time to its
`HTTP_...` code and `diag_...` ID. No event at that time means the request did
not reach this local runtime. See
[CONNECTION-DIAGNOSTICS.ko.md](CONNECTION-DIAGNOSTICS.ko.md).

### Notes

- Keep the Owner Token private.
- Temporary `trycloudflare.com` URLs can change after restart.
- Applying a runtime update from **Check for Updates** keeps cloudflared running, so the temporary URL and connector registration remain in place. Native menu bar UI changes appear after the next app launch.
- Applying a local TypeScript checkout to a running supervisor is a development-only workflow and is not part of the public installation procedure. Use an official Release artifact for installation.
- Windows SmartScreen can warn on new unsigned installers. Continue only when the file came from the official GitHub release.

## Japanese

### 概要

ChatGPT To Codex は、Mac または Windows PC 上で動くローカル開発接続アプリです。両方の環境でファイル確認、パッチ適用、テスト実行を利用できます。ネイティブ E2E 画面キャプチャとデスクトップ操作は現在 macOS のみ対応しています。

### なぜ DMG を使用しますか?

Node.js、cloudflared、MCP ランタイム、補助実行ファイルはアプリに同梱されています。DMG を開き、通常どおり Applications にドラッグしてインストールします。

### macOS インストール

1. 署名・公証済み DMG が公式 GitHub Release に実際に添付されている場合のみダウンロードします。
2. DMG を開き、**ChatGPT To Codex** を **Applications** にドラッグします。
3. macOS にブロックされた場合は、ファイルを Control-クリックして **Open** を選びます。必要なら **System Settings** -> **Privacy & Security** -> **Open Anyway** を選びます。
4. **Applications** から **ChatGPT To Codex** を起動します。
5. メニューバーアイコンが表示されれば起動完了です。

### Windows インストール

1. Windows runner の検証済み setup asset が公式 GitHub Release に実際に添付されている場合のみダウンロードします。
2. インストーラをダブルクリックします。
3. Windows SmartScreen が表示された場合は、公式 GitHub リリースから取得したファイルであることを確認してから **More info** -> **Run anyway** を選びます。
4. **ChatGPT To Codex** を起動します。
5. 時計の近くにトレイアイコンが表示されれば起動完了です。

### 初期設定

1. macOS はメニューバーアイコン、Windows はトレイアイコンから **Settings...** を開きます。
2. **Project folder** を選びます。
3. ブラウザ版 ChatGPT と接続する場合は **ChatGPT web connector** を有効にします。
4. **Start MCP** を押します。
5. **Copy Connector URL** で `/mcp` で終わる URL をコピーします。
6. ChatGPT の Apps / Connectors 設定に登録します。
7. 承認画面ではアプリの Owner Token を入力します。

### E2E スクリーンショット

```text
ChatGPT To Codex で E2E を実行し、アプリを開いてスクリーンショットを表示して。
```

Screen Recording と Accessibility 権限が必要になる場合があります。

### 注意

- Owner Token は公開しないでください。
- 一時的な `trycloudflare.com` URL は再起動後に変わることがあります。
- Windows SmartScreen が表示される場合があります。公式リリースから取得したファイルだけ実行してください。

## Simplified Chinese

### 简介

ChatGPT To Codex 是一个在 Mac 或 Windows PC 本机运行的开发连接应用。两个平台都支持读取文件、应用补丁和运行检查。原生 E2E 屏幕截图与桌面控制目前仅支持 macOS。

### 为什么使用 DMG?

应用包已经包含 Node.js、cloudflared、MCP 运行时和辅助程序，因此不需要单独的安装器。打开 DMG 后拖到 Applications 即可。

### macOS 安装

1. 仅当官方 GitHub Release 实际附有已签名并公证的 DMG 时才下载。
2. 打开 DMG，把 **ChatGPT To Codex** 拖到 **Applications**。
3. 如果 macOS 因未签名而阻止安装，请 Control-点击文件，选择 **Open**。必要时到 **System Settings** -> **Privacy & Security** -> **Open Anyway**。
4. 从 **Applications** 打开 **ChatGPT To Codex**。
5. 看到菜单栏图标即表示已启动。

### Windows 安装

1. 仅当官方 GitHub Release 实际附有通过 Windows runner 验证的 setup asset 时才下载。
2. 双击安装程序。
3. 如果 Windows SmartScreen 出现警告，请确认文件来自官方 GitHub Release，然后选择 **More info** -> **Run anyway**。
4. 打开 **ChatGPT To Codex**。
5. 看到系统托盘图标即表示已启动。

### 首次设置

1. macOS 点击菜单栏图标，Windows 点击系统托盘图标，然后打开 **Settings...**。
2. 选择 **Project folder**。
3. 如果要让网页版 ChatGPT 连接这台电脑，请启用 **ChatGPT web connector**。
4. 点击 **Start MCP**。
5. 点击 **Copy Connector URL**，确认地址以 `/mcp` 结尾。
6. 在 ChatGPT 的 Apps 或 Connectors 设置里添加该地址。
7. 授权时输入应用里的 Owner Token。

### E2E 截图

可以这样要求 ChatGPT:

```text
Use ChatGPT To Codex to run E2E, open the app, capture screenshots, and show them inline.
```

macOS 可能需要 Screen Recording 和 Accessibility 权限。

### 注意

- 请不要公开 Owner Token。
- 临时 `trycloudflare.com` 地址重启后可能变化。
- Windows SmartScreen 可能会提示新安装包风险。只运行来自官方 GitHub Release 的文件。
