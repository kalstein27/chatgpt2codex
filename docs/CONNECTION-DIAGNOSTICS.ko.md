# C2CT 연결 진단 로그

ChatGPT에 도구 스키마가 보이지만 실제 호출이 실패할 때, 오류가 로컬 런타임까지
도착했는지 빠르게 구분하기 위한 운영 로그입니다.

## 가장 빠른 확인법

- macOS: 메뉴 막대 아이콘 → **연결 진단 로그...**
- Windows: 시스템 트레이 아이콘 → **연결 진단 로그...**
- C2CT 도구 호출이 가능한 상태: `connection_status` 호출

로그 파일:

- macOS/Linux: `~/.local/share/chatgpt2codex/connection-events.jsonl`
- Windows: `%USERPROFILE%\.local\share\chatgpt2codex\connection-events.jsonl`

각 줄은 하나의 JSON 이벤트입니다. 최근 실패에는 `diag_...` 형식의
`diagnosticId`가 붙습니다. 이 ID와 발생 시각을 전달하면 같은 실패를 찾기 쉽습니다.

## 기록하는 정보

- 서버 시작/종료
- OAuth 메타데이터·승인·토큰 요청의 상태 코드와 소요 시간
- MCP 요청 및 세션 열림/닫힘
- GPT Action 요청
- 도구명과 성공/실패 코드
- 플랫폼, 최근 성공/실패 시각

Owner Token, OAuth 토큰, Authorization 헤더, 요청 본문, 도구 입력·출력, 사용자가
입력한 텍스트는 기록하지 않습니다. 파일은 약 1 MiB에서 자동으로 줄이고, 가능한
플랫폼에서는 사용자만 읽도록 권한을 `0600`으로 설정합니다.

## 400 연결 오류를 구분하는 법

1. 오류가 난 직후 진단 로그를 엽니다.
2. 같은 시각의 `oauth.request`, `mcp.request`, `actions.request` 실패를 찾습니다.
3. 이벤트가 있다면 `status`, `errorCode`, `diagnosticId`를 확인합니다.
4. 같은 시각에 아무 이벤트도 없다면 요청이 로컬 C2CT까지 도달하지 않은 것입니다.
   이 경우 ChatGPT 계정 연결, 선택된 커넥터, 만료된 연결 또는 ChatGPT 측 connector
   계층을 먼저 확인합니다.
5. `oauth.challenge`의 HTTP 401은 Authorization 헤더 없이 보호된 `/mcp`를 처음
   조회할 때 필요한 정상 OAuth 챌린지입니다. `outcome: info`로 기록되며 진단 ID를
   만들지 않습니다.
6. Authorization 헤더가 있는데도 로컬 이벤트가 `HTTP_401`이면 인증/토큰,
   `HTTP_400`이면 해당 OAuth/MCP 요청 형식이나 세션, `HTTP_5xx`이면 로컬 런타임
   오류를 우선 조사합니다.

`connection_status`는 현재 플랫폼, 선택 프로젝트, lease 만료 여부, 최근 연결
이벤트를 한 번에 반환합니다. 다만 ChatGPT가 도구를 호출하기 전 단계에서 발생한
400은 이 도구도 호출할 수 없으므로 데스크톱 메뉴의 로그를 사용해야 합니다.

### 런타임 reload 때 정상적으로 보이는 이벤트

앱의 런타임 업데이트 기능이 동작하면 다음 순서가 짧게 나타날 수 있습니다.

1. 여러 `mcp.session_closed`
2. `server.stopped`
3. `server.started`
4. 새 `mcp.session_opened`
5. 이어지는 `/mcp` 요청 `200` 또는 `202`

이때 supervisor, cloudflared PID, 공개 URL이 유지되고 이후 도구 호출이 성공하면
의도된 Node 자식 교체입니다. 앱 전체 종료나 connector 재등록이 필요한 장애로
판정하지 않습니다.

2026-07-30 계측으로 session ID 없이 먼저 도착하던 요청이 `server/discover`임을
확인했습니다. 현재 `/mcp`는 두 경로를 병행합니다.

- modern compatibility 경로: `server/discover`, `tools/list`, `tools/call`을
  2026-07-28 stateless envelope로 처리
- legacy 경로: 기존 `initialize`와 `Mcp-Session-Id` 기반 세션 처리 유지

전환 중인 클라이언트가 본문의 `params._meta`를 생략하더라도
`MCP-Protocol-Version` HTTP 헤더가 있고 요청 메서드가 위 modern subset에 속하면
stateless 경로로 처리합니다. `initialize`는 같은 헤더가 있어도 legacy 경로를
유지하므로 두 프로토콜의 초기화 의미가 섞이지 않습니다.

modern 요청은 `mcp.modern_request`로 기록되며 JSON-RPC method, HTTP 상태,
session header 존재 여부, notification 여부만 포함합니다. `params`, request body,
tool arguments, 사용자 텍스트, Authorization/OAuth 토큰은 기록하지 않습니다.
정상 연결에서는 `server/discover` → `tools/list` → `tools/call`이 각각 HTTP 200으로
이어지고 `MCP_SESSION_REQUIRED`가 나타나지 않습니다.

### legacy session lifecycle 해석

서버는 같은 `Mcp-Session-Id`가 유지되는 동안 기존 transport를 재사용합니다. 다만
현재 `openai-mcp` 클라이언트는 다음 호출에 기존 session ID를 재사용하지 않고 새
initialize를 보낼 수 있습니다. 기존 session도 즉시 닫지 않아 hard cap까지
누적되며, 이후 서버의 `capacity` eviction과 새 open이 이어집니다. 서버가 이 client
session ID 정책을 강제로 persistent session으로 바꿀 수는 없습니다.

같은 client의 clean close 또는 capacity eviction과 새 open이 30초 안에 이어지면
두 이벤트를 `mcp.request_session_completed` 하나로 합치고
`closeReason=client_rotation` 또는 `capacity_rotation`을 기록합니다. 이는 정상
replacement lifecycle입니다. clean client close 뒤 30초 안에 새 session이 없으면
`mcp.session_disconnected`, 이후 2분 안에 돌아오면 `mcp.session_reconnected`로
구분합니다. transport 예외는 `mcp.transport_error` failure이며 diagnostic ID가
붙습니다.

서버가 session을 닫은 경우 `mcp.session_closed.closeReason`을 확인합니다.

- `capacity`: max-session hard cap
- `idle_ttl`: idle TTL 초과
- `shutdown`: 정상 runtime 종료 또는 snapshot 교체

`connection_status.diagnostics.lifecycle`는 보존 중인 JSONL 로그 범위에서 정상
rotation, client disconnect, reconnect, transport error, server close 사유별 횟수와
평균 session lifetime, reconnect delay, setup 시간, request/reuse 수를 집계합니다.
상세 계약과 검증 기록은
[C2CT-05-MCP-SESSION-LIFECYCLE.ko.md](C2CT-05-MCP-SESSION-LIFECYCLE.ko.md)를
참조합니다.

이 구현은 현재 ChatGPT 연결에 필요한 modern compatibility subset입니다. 전체
2026-07-28 기능을 모두 구현했다고 간주하지 않으며, 그 외 method는 명시적으로
`Method not found`를 반환합니다.

로컬 상태 API를 직접 사용하는 앱은 파일에 저장된 local-control capability를
Bearer로 보내 `GET /local-control/v1/diagnostics?limit=40`을 호출할 수 있습니다.
이 API는 loopback Host와 capability가 모두 맞아야 하며 외부에 공개되지 않습니다.

## 남아 있는 경계

ChatGPT가 반환하는 `We couldn't connect your account` 문구 자체는 ChatGPT connector
계층에서 생성될 수 있어 C2CT가 바꿀 수 없습니다. 대신 “로컬 로그에 요청이
있었는가”를 기준으로 서버 내부 문제와 서버 도달 전 문제를 구분할 수 있습니다.
