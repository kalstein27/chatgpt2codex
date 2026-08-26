# ChatGPT To Codex Windows 빠른 사용법

이 문서는 Windows 사용자와 Windows에서 작업하는 코딩 에이전트를 위한 현재형 안내서입니다.

Windows에는 트레이 앱, portable bundle, installer, installer E2E 소스가 있습니다. 다만 공식 설치 파일은 같은 commit이 실제 Windows runner에서 빌드·테스트된 뒤에만 배포할 수 있습니다. macOS에서 TypeScript 테스트가 통과한 것만으로 Windows 릴리스 완료를 주장하지 않습니다.

현재 Windows에서는 프로젝트 파일·명령·Git·이미지 저장·OAuth·세션 상태 기능을 사용할 수 있습니다. Windows 네이티브 화면 캡처, 클릭, 타이핑, UI Automation/SendInput 제어는 아직 구현되지 않았으며 `Agent Arm` 비활성화는 정상입니다.

## 1. 공식 릴리스 설치

공식 GitHub Release에 Windows setup asset과 Windows 검증 기록이 실제로 있을 때만 이 절차를 사용합니다.

1. `chatgpt2codex-<버전>-windows-setup.exe`를 공식 릴리스에서 다운로드합니다.
2. 미서명 빌드에 SmartScreen이 표시되면 출처와 게시된 checksum을 확인한 뒤에만 실행합니다.
3. **ChatGPT To Codex**를 실행하고 시스템 트레이 아이콘을 확인합니다.
4. **Settings...**에서 ChatGPT가 작업할 **Project folder**를 선택합니다.
5. **Start MCP**를 누릅니다. 기본 로컬 포트는 `7979`입니다.
6. ChatGPT 웹에서 사용할 때만 **ChatGPT web connector**를 켭니다.
7. `/mcp`로 끝나는 Connector URL을 복사해 ChatGPT에 등록합니다.
8. 승인 화면에서 앱의 Owner Token을 입력합니다. Owner Token은 비밀번호처럼 보관합니다.

임시 `trycloudflare.com` 주소는 재시작하면 바뀔 수 있습니다. 주소가 바뀌면 기존 ChatGPT 연결을 새 URL로 교체합니다.

## 2. 소스에서 검증·빌드

```powershell
npm ci --ignore-scripts
npm run typecheck
npm run build
```

Installer·portable bundle·installer E2E 자동화는 최소 공개 소스 트리에서
제외되어 있습니다. 실제 Windows runner에서 별도로 검증하기 전에는 어떤
산출물도 release candidate로 취급하지 않습니다. Release artifact 이름은
다음과 같습니다.

- `chatgpt2codex-<버전>-windows-setup.exe` — unsigned installer
- `chatgpt2codex-<버전>-windows-portable.zip` — unsigned portable bundle
- `SHA256SUMS.txt` — 두 artifact의 SHA-256 manifest

서명은 아직 TBD입니다. 실제 Windows 서명·검증 게이트가 추가되기 전에는 signed release로 표현하지 않습니다. 생성된 `.exe`, zip과 설치 백업은 Git에 커밋하지 않고 GitHub Release artifact로 게시합니다.

Release workflow는 최소 공개 소스 트리에 포함하지 않습니다. 로컬 release pipeline을 별도로 운용하더라도 서명 전 산출물은 **draft + prerelease 검증 릴리스**로만 취급하고, 실제 Windows runner 검증과 수동 검토가 끝나기 전에는 설치 파일을 배포용으로 안내하지 않습니다.

## 3. 트레이 메뉴 읽는 법

- **ChatGPT To Codex: 켜짐/꺼짐**: 로컬 MCP 서버 상태
- **프로젝트**: 현재 선택된 프로젝트
- **포트**: 기본값 `7979`
- **활성 세션 상태**: 연결된 세션과 실행 중 도구
- **대기 중인 작업 승인**: 로컬 승인을 기다리는 protected operation
- **MCP 시작/중지/재시작**: 로컬 runtime 제어
- **연결 진단 로그...**: transport·OAuth·도구 호출 진단
- **Settings...**: 프로젝트, connector, 포트, 자동 시작, 언어 설정

`Agent Arm: Windows에서 아직 지원 안 됨`은 오류가 아닙니다. 구현되지 않은 데스크톱 제어 권한을 켜지 못하도록 막는 안전장치입니다.

## 4. 막힐 때

- 트레이 상태가 꺼짐이면 **MCP 시작**을 누릅니다.
- 포트 `7979`가 사용 중이면 **MCP 재시작** 후 로그를 확인합니다.
- Connector URL이 비어 있으면 web connector를 켜고 MCP를 재시작합니다.
- 임시 URL이 바뀌면 ChatGPT의 기존 연결을 새 URL로 교체합니다.
- Owner Token을 재생성하면 기존 ChatGPT 연결도 다시 인증해야 합니다.
- 도구가 보이지만 호출이 실패하면 **연결 진단 로그...**에서 같은 시각의 오류 코드와 diagnostic ID를 확인합니다.
- 이벤트가 전혀 없으면 요청이 이 PC의 runtime까지 도착하지 않은 것입니다.
- 앱과 터미널을 관리자/일반 권한으로 섞어 실행하지 않습니다.
- 에이전트가 macOS 전용 명령을 제안하면 현재 플랫폼과 이 Windows 안내서를 다시 확인합니다.
