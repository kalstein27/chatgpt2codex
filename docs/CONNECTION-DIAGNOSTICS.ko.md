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

## 연결 직후 지침 확인은 lease-neutral

새 설치나 새 ChatGPT 세션은 프로젝트 폴더가 없어도 먼저
`connection_status` -> `agent_guide`만으로 현재 runtime의 C2CT 공통 운영 규칙을
확인할 수 있어야 합니다. `agent_guide`가 live runtime의 canonical bootstrap이며,
GitHub 문서나 특정 프로젝트의 `AGENTS.md`가 이 단계의 필수 조건이 되어서는 안 됩니다.

프로젝트가 있으면 `workspace_list_projects` 또는 `workspace_get_project`로 정확한
`projectId`를 확인한 뒤 `project_rules(projectId=...)`와
`project_status(projectId=...)`를 직접 읽습니다. 이 instruction-discovery 단계는
다른 채팅의 serial lease/work lane을 바꾸지 않아야 하며, 지침을 읽기 위해
`project_select`, `project_release`, serial lease renew, sibling lane renew/release를
호출하지 않습니다. 실제 수정·테스트 등 capability가 필요한 시점에만 대상 root에
최소 권한 work lane을 엽니다.

특정 read tool이 예외적으로 lease를 요구한다면 multi-project lane이 활성화된
runtime에서는 대상 root에 임시 `read-only` lane을 열고 exact handle을
`project_lane_status`로 확인한 뒤 필요한 read만 수행하고 그 lane만 release합니다.
기존 다른 세션의 lease를 빼앗거나 교체하는 방식으로 해결하지 않습니다.

## 세션/프로젝트 격리는 runtime invariant

multi-project lane이 활성화된 remote ChatGPT에서는 아래 항목을 단순 운영 권고가
아니라 runtime이 강제로 지키는 불변조건으로 취급합니다.

- capability 상태는 authenticated owner 전체가 아니라 ChatGPT conversation별 scope에
  저장합니다. `openai/session` 원문은 상태 파일에 저장하지 않고 digest만 사용합니다.
- 한 remote conversation이 첫 privileged project를 획득하면 그 conversation은 해당
  project에 bind됩니다. 이후 다른 project의 privileged lane/serial lease를 요청하면
  자동 전환하지 않고 fail-closed합니다. cross-project rule/status discovery는 계속
  lease-neutral로 허용합니다.
- write/test/build/image 계열 remote 작업은 exact `workLaneId`가 필수입니다. 일반
  코딩에서 serial lease를 fallback으로 사용하지 않습니다.
- lane status/renew/release와 lane-aware mutation은 현재 conversation owner를 검증합니다.
  다른 채팅이 exact `workLaneId`/`leaseId`를 알아도 사용할 수 없습니다.
- privileged ownership은 canonical project root별로 전역 격리합니다. 서로 겹치지 않는
  root는 동시에 작업할 수 있지만, 같은 root뿐 아니라 ancestor/descendant 관계로 root가
  겹치는 경우에도 다른 privileged owner가 있으면 `ACTIVE_PROJECT_LEASE_HELD`로 거부합니다.
- remote `project_select`는 일반 코딩용이 아닙니다. serial-only admin은
  `purpose=legacy-admin`, desktop control은 `purpose=control`을 명시해야 합니다.
- release/switch의 active-operation 확인도 현재 conversation scope만 봅니다. 다른
  conversation의 작업 때문에 자기 lane release가 막히지 않습니다.

lane 만료 직후 renewal grace 안에서는 기존 owner가 해당 canonical root의 ownership을
계속 가지고 있을 때만 renew할 수 있습니다. 만료 사이 다른 conversation이 root를
정상 획득했다면 예전 owner의 grace renew는 거부됩니다.

## 멀티프로젝트 work lane 확인법

`agent_guide.capabilities.multiProjectLanes`가 `enabled`이면 일반 코딩 세션은
`project_select`가 아니라 `project_lane_open`으로 시작하는 것이 기본입니다. 에이전트가
"lane을 열었다"고 말한 것만으로는 증거가 아닙니다. originating chat에서 실제
`project_lane_open` 성공 결과의 `workLaneId`와 `leaseId`를 보존하고, 바로
`project_lane_status`로 같은 handle이 active인지 확인해야 합니다.

주의: `connection_status.lease`는 **serial project lease**를 나타냅니다. work lane이
살아 있어도 이 값은 `null`일 수 있으므로 `lease=null`만으로 "lane이 없다"고 판단하면
안 됩니다. 반대로 작업 시작 이후 실제 `file_create`, `file_edit_lines`, `command_run`,
`checkpoint_restore` 같은 mutation/verify가 계속 발생하는데 같은 작업 구간에
`project_lane_open`/`project_lane_status` 증거가 없고 serial lease preset만 보인다면,
해당 세션이 lane-first 경로가 아니라 legacy serial 경로로 작업 중인지 확인합니다.

`connection_audit`는 raw `workLaneId`를 일반 진단 로그에 영구 저장하지 않습니다.
이는 의도된 보안/결합도 경계입니다. audit에서는 `project_lane_open/status/renew/release`
호출의 성공/실패, projectId, tool lifecycle, background operation, approval 결과를 보고,
정확한 handle 검증은 originating chat이 보존한 `workLaneId`로 `project_lane_status`를
호출해 수행합니다.

`workLaneId`는 의도적으로 session 파일이나 일반 audit 로그에 원문 저장되지 않으므로,
originating chat이 handle을 잃은 상태에서 같은 session 소유의 privileged lane/root-lock이
남을 수 있습니다. 이 경우 `project_lane_recover`는 foreign recovery로 취급하지 않고,
active operation이 없는 것을 확인한 뒤 **현재 session이 소유한 상태만** approval 없이
de-escalation cleanup합니다. 반대로 owner가 다른 active lane은 자동 해제하지 않으며,
기존처럼 명시적 local approval이 있는 break-glass recovery만 허용합니다.

멀티프로젝트 soak test에서는 다음을 함께 확인합니다.

- 서로 겹치지 않는 canonical root의 privileged lane 두 개가 동시에 active 상태를 유지한다.
- 한 lane의 `project_lane_renew`가 sibling lane의 lease identity/expiry를 바꾸지 않는다.
- 한 lane의 `project_lane_release`가 sibling lane을 종료하지 않는다.
- background operation은 해당 project/lane에 귀속되고 project별 active 제한을 지킨다.
- one-shot approval은 요청한 lease/capability에만 귀속되며 다른 프로젝트가 소비하지 않는다.
- 서로 겹치지 않는 root 사이에서 `ACTIVE_PROJECT_LEASE_HELD`가 발생하면 회귀 가능성을 조사한다.
- 같은 root 또는 ancestor/descendant로 겹치는 root의 privileged work lane/serial lease가
  동시에 거부되는 것은 정상 보호다.

`macos_app_apply_local` 같은 legacy/admin serial-only 작업이 필요하면 같은 root의 work
lane에서 진행 중인 atomic/background 작업을 먼저 terminal 상태로 만든 뒤 그 lane을
정확히 release하고, 짧게 `project_select purpose=legacy-admin` serial lease를 얻어 admin 작업만 수행한 뒤
`project_release`합니다. 정상 코딩으로 돌아갈 때는 다시 work lane을 열고 status를
확인합니다. dirty worktree를 정리하거나 sibling project lease를 강제로 빼앗아 해결하지
않습니다.


## 작업 현황 창과 ChatGPT 채팅 그룹

macOS 앱의 **현재 작업 현황** 창은 ChatGPT가 선택적으로 전달하는 익명
`openai/session` 메타데이터를 원문 그대로 보관하지 않고, 로컬에서
`CHAT-XXXXXXXXXX` 형태의 짧은 표시 라벨로 변환합니다. 같은 ChatGPT 채팅에서 발생한
여러 MCP 요청은 이 라벨 아래 시간순으로 묶입니다.

- ChatGPT가 allowlist된 대화 제목 메타데이터를 보내면 redaction 후 최대 60자의
  표시 제목으로만 보관하며, 제목은 runtime process의 bounded in-memory history 밖으로
  영속화하지 않습니다.
- `goal_intake`가 성공하면 redaction을 거친 목표 앞부분이 작업 라벨로 연결됩니다.
- 큰 목표를 만들 필요가 없는 작업은 `session_context_update`로 최대 80자의 짧은
  작업 라벨만 설정할 수 있습니다.
- ChatGPT가 `openai/session` 메타데이터를 보내지 않으면 다른 채팅과 임의로 합치지 않고 기존
  transport session 카드로 표시합니다.
- 전체 프롬프트, 도구 입력·출력, 원본 conversation ID는 작업 현황 데이터에 저장하지 않습니다.
- 채팅 라벨은 표시·그룹화 전용입니다. 사용자 principal, OAuth identity, project
  scope, lease, 승인 또는 control 권한으로 사용하지 않습니다.

기록은 runtime process 메모리에만 존재하며 최근 6시간, 최대 16개 채팅, 채팅당
32개 작업으로 제한됩니다. 메뉴 앱이 0.8초 간격으로 확인하는 실행 중 화면에는
최근 8개 채팅과 채팅당 10개 작업만 전달합니다. 유휴 상태에서는 3초 간격이며 창이
닫히거나 가려지면 폴링을 중지합니다.

이 창은 C2CT runtime에 도달한 tool lifecycle만 보여줍니다. ChatGPT의 생각, 답변 작성,
host 내부 재시도와 아직 runtime에 도달하지 않은 connector 오류는 표시할 수 없습니다.
창이 비어 있다는 사실만으로 ChatGPT가 멈췄다고 단정하지 말고, `connection_status`의
request reachability 및 같은 시간대의 connection diagnostics와 함께 판단합니다.

`requestReachability`와 diagnostics의 `lastServerRequestAt` / `lastToolDispatchAt`는
서버 수신과 tool dispatch를 구분합니다. `hostFailureObservable=false`는 의도된
계약입니다. 로컬 서버에 도착하지 않은 ChatGPT host/connector 실패를 로컬 실패
이벤트로 추측해 만들지 않습니다. 같은 호출을 반복하기보다 `connection_status`를
한 번 직접 호출하고, 실패 시각 뒤 `lastServerRequestAt`가 갱신되지 않았다면
host/connector 계층으로 분류합니다. 수신은 됐지만 dispatch 이후 실패했다면 반환된
`diagnosticId`를 기준으로 조사합니다. heartbeat나 public health 성공만으로 해당 tool
호출이 서버에 도달했다고 간주하지 않습니다.

macOS 앱/launcher의 자동 시작 판단도 같은 원칙을 따릅니다. host/account/connector
응답 오류만으로 local runtime을 재시작하지 않습니다. 앱은 새 launcher를 시작하기
전에 loopback `/healthz`의 연속 실패를 확인하고, launcher가 같은 포트의 기존
프로세스를 발견하면 자동 `pkill`로 회수하지 않습니다. 기존 endpoint가 건강하면
그대로 사용하고, 건강 여부를 확인할 수 없으면 명시적인 Stop/Restart 전까지
fail-closed로 종료합니다. 외부 watchdog이 앱을 다시 띄우더라도 이 경계를 우회하면
안 됩니다.

살아 있는 managed runtime child가 멈춘 경우는 supervisor가 별도로 복구합니다.
`start-chatgpt.sh`는 자신이 직접 spawn한 `SRV_PID`만 대상으로 하며, 일반 hung는
bounded loopback health probe의 연속 실패 후에만 복구를 시작합니다. Unix `Z`
상태는 이미 종료된 child이므로 즉시 reap/restart 대상으로 분류합니다. 복구 시에는
같은 runtime root에서 child만 `TERM` 후 bounded wait, 필요할 때만 `KILL` fallback으로
교체하며 supervisor와 connector/cloudflared/external tunnel은 건드리지 않습니다.
30초 cooldown과 5분 내 최대 3회 recovery budget을 적용하고, 새 child가 health
검증에도 실패하면 자동 복구를 잠근 채 supervisor/tunnel을 유지하여 명시적
Stop/Restart 또는 runtime reload로만 다음 조치를 하도록 fail-closed합니다.

### 2026-08-12 live bootstrap acceptance

schema 6에서 schema 7로의 1회 bootstrap 승격은 acceptance PASS로 마감했습니다. live
runtime/build fingerprint는 bootstrap 직전 계산한 target과 일치했고, `finalHealthy=true`,
7979 listener 1개, 17979 listener 0개, runtime child와 supervisor parent 관계를 확인했습니다.
설치 앱의 `start-chatgpt.sh`는 프로젝트 최신본과 `cmp` 기준 동일했습니다.

또한 live dispatcher에서 `runtime_apply_status`는 unknown probe에 `OPERATION_NOT_FOUND`까지
handler 진입했고, `runtime_apply_local`은 `preserveConnector=false` probe를 schema 단계에서
`INVALID_INPUT`으로 거부했습니다. 두 새 apply tool의 live public 노출을 무변경 방식으로
검증했습니다. watchdog 구현의 실제 hang/zombie fault-injection은 destructive live acceptance
TODO로 별도 유지하고, 다음 구현 우선순위는 canonical RuntimeManifest identity 완성입니다.


### 장시간 `command_run`과 Stop forensic

장시간 명령은 secret-free lifecycle을 별도로 기록합니다. `connection_status`의
`activeOperations`와 `diagnostics.recentCommandEvents`, 또는 `connection_audit`의
`slowRequests`/`toolLatency`를 먼저 확인합니다.

`activeOperations`는 각 실행의 `operationId`, `startedAt`, `elapsedMs`, 현재 `phase`,
최근 progress 시각을 제공합니다. client 연결이 먼저 닫힌 실행에는
`clientCancellation.operationContinues=true`와
`recommendedAction=wait-and-recheck-connection-status`를 표시합니다. 이 표시는
서버가 취소를 무시한다는 뜻이 아니라 **transport 취소만으로 실제 작업 종료를
증명할 수 없다는 뜻**입니다.

- `phase=approval`: 위험 명령의 로컬 승인 경계를 확인 중입니다. 아직 subprocess가
  시작됐다고 해석하지 않습니다.
- `phase=spawn`, `actionStarted=true`: 승인/정책 경계를 통과해 spawn 직전입니다.
  one-shot 승인이 실제 실행에 소비됐다고 단정하려면 뒤따르는
  `subprocessStarted=true`를 확인합니다.
- `phase=running`, `subprocessStarted=true`, `subprocessStillRunning=true`: 실제 child
  process가 시작되어 실행 중입니다.
- `phase=cleanup`: timeout 등으로 process-tree 정리가 시작됐습니다.
- `phase=completed`: `commandStatus`, `cleanupStatus`, `durationMs`와 함께 완료 상태를
  판정합니다.
- 응답 완료 전에 client 연결이 닫히면 별도 `mcp.client_cancelled`,
  `cancelledByClient=true`를 기록합니다. 이는 **client가 기다리기를 중단했다는
  transport 증거**이며 이미 시작된 subprocess를 자동 kill했다는 뜻은 아닙니다.

`connection_status.diagnostics.clientCancellationRecovery`는 가장 최근 client 취소를
동일한 `operationId`의 후속 lifecycle과만 연결합니다.

- `still-running`: 실행 또는 cleanup이 계속되므로 기다린 뒤 status를 다시 봅니다.
- `completed`: 실행은 끝났지만 원래 응답을 client가 받지 못했을 수 있으므로 결과와
  산출물을 확인한 뒤에만 재실행합니다.
- `failed`: 실패·timeout·spawn/cleanup 결과를 확인한 뒤 재시도 여부를 판단합니다.
- `unknown`: operation ID가 없거나 동시 실행 때문에 안전하게 연결할 수 없습니다.
  `connection_audit`로 조사하기 전에는 재실행하지 않습니다.

모든 상태에서 `automaticRetrySafe=false`입니다. client 취소는 명령의 멱등성이나
approval/receipt 소비 여부를 증명하지 않기 때문입니다. 같은 session에서 같은 tool이
동시에 실행돼 상관관계가 모호하면 runtime은 최신 실행을 추측하지 않고 `unknown`으로
남깁니다.

MCP client가 progress token을 제공하는 경로에서는 `notifications/progress`를 보내며
5초 heartbeat를 유지합니다. 현재 ChatGPT modern stateless one-shot 경로는 handler에
progress token을 전달하지 않으므로 live UI heartbeat를 보장할 수 없습니다. 이 경우
다음 턴의 `connection_status`/`connection_audit` forensic이 canonical fallback입니다.

`connection_status` schema 8은 live runtime identity와 외부 tunnel 관찰을 분리합니다.

- `runtimeExternalIdentity`와 `connectorPublicOrigin`은 query/token을 제거한 origin,
  supervisor PID, tunnel mode만 포함합니다.
- `externalWatchdog`는 macOS 로컬 watchdog이 남긴 상태 중 watchdog version, 연속 실패
  수, 허용된 실패 분류, 최근 safe diagnostic ID와 TLS/certificate/DNS/connect/timeout/
  HTTP 계층만 노출합니다. `lastProbeAt`, `probeAgeMs`, `probeFresh`는 60초 LaunchAgent가
  실제로 계속 실행되는지 판단하는 secret-free freshness 정보입니다. raw URL, edge IP,
  token과 로그 본문은 노출하지 않습니다.
- watchdog v3는 상태 전환 로그와 별도로
  `~/Library/Application Support/ChatGPT To Codex/TailscaleWatchdog/probe-history.log`에
  매 probe의 secret-free 결과를 한 줄씩 기록합니다. 각 행은 시각, safe diagnostic ID,
  internet/local runtime/Tailscale/Funnel/public edge 성공 여부, 제한된 public probe class,
  edge 성공 개수만 포함합니다. raw URL, remote IP, curl metric, 인증 정보는 기록하지
  않습니다. 파일은 mode `0600`, 최대 2MB에서 최근 5000행으로 bounded rotation되며,
  `connection_status.externalWatchdog.probeWindow`는 최근 sample만 제한적으로 노출합니다.
- `connection_audit`는 요청한 exact `since`/`until` 구간에 맞는
  `externalWatchdogWindow`를 함께 반환합니다. `sampleCount`, healthy/unhealthy count와 최근
  최대 20개 sample을 로컬 MCP receipt와 대조하면, 실패 시각에 edge/TLS가 정상이었는데
  해당 tool dispatch가 없다면 host/connector 계층으로 더 강하게 분류할 수 있습니다.
- `hostExceptionBodyObservable=false`는 ChatGPT host 내부 `ExceptionGroup` 원문을 로컬
  서버가 볼 수 없다는 뜻입니다. 실패 시각의 `lastServerRequestAt`/`lastToolDispatchAt`와
  watchdog `recentFailure`와 `probeWindow`를 비교해 host-only, public edge/TLS, local
  runtime 계층을 분리합니다. 이 보강도 host traceback 자체를 수집하는 기능은 아니며,
  요청 미도달과 같은 "negative evidence"를 같은 시간창의 외부 probe로 보강합니다.

`connection_status`는 서로 독립적인 private state read를 병렬화하고, 실행 중에는 변할
수 없는 `RuntimeManifest`를 runtime process 수명 동안 캐시합니다. runtime root가 바뀌면
다시 계산하므로 개발·테스트 격리도 유지됩니다. watchdog status는 60초 probe 주기보다
훨씬 짧은 2초 캐시를 사용하고 probe history는 최근 256KB만 읽어 연속 상태 조회 비용을
제한합니다.
성능 검증은 동일 프로세스에서 warm-up 뒤 p50/p95/p99를 비교하되, live network 왕복과
ChatGPT host latency는 로컬 handler 시간과 분리해 기록합니다.

Gate/preflight처럼 핵심 상태만 필요하면 `connection_status`에 `mode="compact"`를
지정합니다. compact 응답은 runtime identity 요약, active project/lease,
`activeOperations`, `runtimeUpdateBarrier`, transport error와 request reachability를
유지하면서 watchdog sample history, snapshot inventory, 긴 recent diagnostics와 apply
receipt를 기본 생략합니다. 필요한 섹션만 `includeDiagnostics`, `includeWatchdog`,
`includeSnapshots`, `includeReceipts`로 다시 포함할 수 있습니다. 입력을 생략하거나
`mode="full"`을 사용하면 기존 full 응답 계약을 그대로 유지합니다.

### 파일 mutation 응답 손실 조사

`file_create`, `file_edit_lines`, `file_apply_patch`는 선택적인 `requestId`를 받습니다.
timeout, TaskGroup, UNKNOWN 또는 응답 손실 뒤 같은 mutation을 다시 실행하지 말고, 호출
전에 정한 동일 `requestId`로 read-only `mutation_status`를 먼저 조회합니다.

- `NOT_STARTED`: runtime receipt는 만들어졌지만 mutation 시작 증거는 아직 없습니다.
- `APPLYING`: runtime handler가 mutation을 시작했으며 완료 여부를 아직 확정하지 못했습니다.
- `APPLIED_ATOMICALLY`: mutation 함수가 성공적으로 반환했습니다. `partialApplyPossible=false`입니다.
- `FAILED`: hash/context/range 등 commit 전 검증 실패입니다. multi-item 요청은 안전한
  `failedItemIndex`를 제공할 수 있습니다.
- `ROLLED_BACK`: commit 실패 뒤 rollback 완료를 증명할 수 있는 경우를 위한 terminal 상태입니다.
- `UNKNOWN`: commit 또는 best-effort rollback 결과를 runtime이 확정할 수 없습니다.

receipt를 만든 runtime PID와 현재 runtime PID가 다르면 미완료 상태를 그대로 방치하지
않습니다. 이전 runtime의 `NOT_STARTED`는 mutation 함수가 호출되지 않은 `FAILED`로,
`APPLYING`은 부분 적용 가능성을 배제할 수 없는 `UNKNOWN`으로 보수적으로 종결합니다.
어느 경우에도 새 runtime이 원 mutation을 자동 재실행하지 않습니다.

receipt에는 tool/project, item count, 상태, 시각, checkpoint ID, 제한된 failure code만
남기며 patch/content/path, token, 환경변수 값은 기록하지 않습니다. 동일 `requestId`와
동일 입력을 다시 mutation tool에 전달해도 runtime은 원 작업을 재실행하지 않고 기존
receipt를 반환합니다. 다른 입력으로 같은 `requestId`를 재사용하면 거부합니다. 모든
상태에서 `automaticRetrySafe=false`입니다.

`mutation_status`에서 `OPERATION_NOT_FOUND`가 반환되면 로컬 receipt가 관찰되지 않았다는
뜻일 뿐, host 요청이 runtime에 절대 도달하지 않았다는 단독 증거는 아닙니다.
`connection_status.requestReachability` 또는 같은 시간창의 `connection_audit`로 server
receipt/tool dispatch를 함께 확인해야 하며 `hostFailureObservable=false` 원칙은 유지됩니다.

새 tool이 live `tools/list`와 generic `c2ct_invoke`에는 존재하지만 ChatGPT named tool로
즉시 나타나지 않으면 handler 부재로 단정하지 않습니다. exact `tools/list`, schema
revision/TTL, generic direct dispatch를 순서대로 확인합니다. host가 이전 direct-tool
집합을 캐시한 경우에는 기존 named `connection_status`의 `lastMacosAppApply`,
`lastRuntimeApply`, `runtimeSnapshots`가 재연결 없는 상태 조회 fallback입니다.

모든 public MCP tool은 공통 structured-result output schema를 제공합니다. 이 schema는
실제로 공통인 tool-call proof, `code`, `error`, `diagnosticId`, lease health만 선언하고
각 tool의 성공 결과는 passthrough로 유지합니다. 따라서 빈 schema로 경고만 숨기거나
존재하지 않는 결과 필드를 약속하지 않습니다. 플러그인 UI의 **출력 스키마 권장** 표시는
host schema TTL/cache가 갱신된 뒤 다시 확인합니다.

### progress token이 없는 장시간 명령

Remote ChatGPT/MCP에서 `command_run`은 이제 항상 background handoff로 접수됩니다.
remote transport에서도 기본은 `synchronous`입니다. 짧고 일반적인 검증은 foreground로
유지해 ChatGPT의 현재 turn이 실제 로컬 작업 종료 전까지 살아 있는 쪽을 우선합니다.
`executionMode`를 생략했고 `intent.expectedDurationSec > 20`인 장기 작업만 자동으로
background로 승격합니다. `executionMode: "synchronous"`를 명시하면 foreground를
존중하고, `executionMode: "background"`를 명시하면 즉시 background handoff를 사용합니다.

명시적으로 background mode를 요청해도 동일한 경로를 사용합니다.

```json
{
  "projectId": "project-id",
  "commandId": "npm:test",
  "executionMode": "background"
}
```

background handoff가 발생하면 호출은 opaque `operationId`, `pollAfterMs=3000`,
`turnContinuationRequired=true`, `assistantMayFinalize=false`를 반환합니다. 이 상태에서는
같은 assistant turn에서 즉시 `operation_status(projectId, operationId)`를 반복하고 terminal
상태가 확인되기 전에는 최종 답변을 내지 않습니다. terminal 상태의 `outputRef`는 기존
`output_read`로 읽습니다. remote 응답에는 `requestedExecutionMode`,
`effectiveExecutionMode`, `autoBackgrounded`, `hostSafeHandoff`가 포함되어 실제 handoff
여부를 진단할 수 있습니다.

- `operation_status`는 matching project의 read-only 이상 lease를 요구합니다.
- `operation_cancel`은 full-write lease와 별도 one-shot local approval을 요구합니다.
- cancel 승인이 pending인 동안에는 기존 command timeout의 남은 예산을 최대 2분만
  일시 정지합니다. 같은 pending request 재조회로 정지 시간이 무한 연장되지 않으며,
  승인 후 동일 operation을 다시 호출해야 실제 process-tree cleanup이 시작됩니다.
- client Stop/disconnect는 cancel이 아니며 자동 재실행도 허용하지 않습니다.
- lease 만료는 이미 시작된 process를 자동 kill하지 않습니다.
- runtime restart 뒤 미완료 record는 `interrupted-by-runtime-restart`로 끝나며 자동
  attach/retry하지 않습니다.
- background output은 원 호출과 분리되므로 작은 출력도 redacted artifact로 보존합니다.
- global active 2개, project별 active 1개, command 최대 300초로 제한합니다.

`connection_status.activeOperations`와 로컬 메뉴의 **활성 세션 상태**에도 background
operation ID, command ID, phase, elapsed, 마지막 heartbeat가 나타납니다. 이 상태는
ChatGPT 고유 UI의 “생각을 멈춤” 표시를 제거한다는 뜻이 아니라, host progress 표시가
없어도 실행 지속·완료·취소 여부를 안전하게 다시 확인할 수 있다는 뜻입니다.

### 명령 실행과 runtime/app 교체의 경계

runtime 또는 macOS 앱 교체는 새 작업을 받지 않는 짧은 drain 구간을 먼저 엽니다.
이때 `command_run`, `local_shell_run`과 one-shot E2E 실행은 subprocess를 시작하지 않고
`RUNTIME_UPDATE_IN_PROGRESS`로 거절됩니다. 안전하게 공개되는 details에는 update
`operationId`, project ID, `phase=draining`, 5분 이내의 `retryAfterMs`와
`recommendedAction=retry-after-runtime-update`만 포함됩니다. target 경로, token,
환경변수나 명령문은 포함하지 않습니다.

- barrier는 `0600` private state이고 한 update operation만 소유할 수 있습니다.
- 같은 operation의 재진입은 idempotent이며, 다른 update와의 경쟁은 거절됩니다.
- stale barrier는 최대 5분 뒤 만료됩니다. 정상 apply worker는 성공·실패와 관계없이
  자신이 소유한 barrier를 해제합니다.
- runtime/app apply는 현재 session뿐 아니라 모든 owner scope의 foreground/background
  operation과 관련 없는 pending approval을 다시 확인합니다. 하나라도 남아 있으면
  runtime child를 교체하지 않습니다.

이미 시작된 background subprocess는 runtime process의 메모리에만 귀속됐다고 추측하면
안 됩니다. runtime 재시작 뒤 persisted active record는 다음 terminal forensic 상태로
전환됩니다.

- `state=interrupted-by-runtime-restart`
- `subprocessStateUnknown=true`
- `subprocessStillRunning=false`는 **실제 OS process 종료 증명**이 아니라 새 runtime이
  이전 child를 추적하지 않는다는 뜻입니다.
- `cleanupCompleted=false`
- `errorCode=RUNTIME_RESTARTED_PROCESS_STATE_UNKNOWN`
- `automaticRetrySafe=false`

따라서 같은 명령을 자동 재실행하지 않습니다. operation status와 output artifact,
실제 process/artifact 상태를 확인한 뒤 사용자가 재시도를 결정해야 합니다. 같은
operation에 대한 cancel 호출도 이미 terminal forensic record를 바꾸거나 알 수 없는
PID에 signal을 보내지 않습니다.

managed runtime child가 예기치 않게 종료되면 새 launcher는 같은 verified runtime root를
사용해 bounded recovery를 시도합니다. supervisor와 external connector/Funnel은 유지하고,
5분 내 최대 3회·30초 cooldown을 넘으면 자동 복구를 잠급니다. 마지막 server log는
`~/.local/share/chatgpt2codex/logs/last-runtime-failure.log`에 최대 256 KiB로 보존됩니다.
runtime apply 자체는 expected fingerprint와 immutable snapshot, receipt, post-apply health를
확인하며 새 runtime이 건강하지 않으면 이전 active-runtime pointer를 복원합니다.
승인과 worker 시작 사이에 메뉴바 앱이 교체돼 supervisor가 바뀐 경우에는 active-runtime
pointer를 쓰기 직전에 live health와 기존 supervisor PID를 다시 비교하고,
`PRECONDITION_FAILED` / `refresh-managed-runtime-topology-before-retry`로 mutation 없이
종료합니다.

`runtime_snapshot_status`는 private immutable snapshot을 다음 보호 이유와 함께
inventory합니다.

- active-runtime pointer
- 현재 runtime process root
- 최근 apply/rollback receipt가 참조하는 previous/target pointer
- 최신 3개 기본 보존
- 생성 후 7일 기본 최소 보존

삭제는 자동 실행하지 않습니다. `runtime_snapshot_prune_local`은 full-write lease와 별도
local destructive approval을 요구하며, 고정 private release root 안의 64자리 snapshot
디렉터리만 대상으로 삼습니다. symlink는 무시하고, 삭제 직전에 inventory를 다시 계산해
그 사이 active/rollback 보호 대상이 된 snapshot은 건너뜁니다. runtime/app 교체 barrier가
활성인 동안에는 실행되지 않으며 live pointer, process, connector/tunnel을 변경하지 않습니다.

macOS 앱 교체도 live runtime handler 안에서 bundle을 직접 바꾸지 않습니다. 승인 뒤
고정 detached worker가 drain barrier를 인수하고 `0600` receipt를 기록하므로, 앱의 정상
종료로 기존 supervisor/runtime과 MCP 응답이 닫혀도 동일 `requestId`의
`macos_app_apply_status`로 terminal 결과를 재조회할 수 있습니다. worker는 AppKit 정상
종료를 먼저 요청하고, app PID의 실제 자식으로 확인된 supervisor만 handoff 대상으로
정리합니다. 외부 supervisor는 signal하지 않으며, 새 앱 실행 뒤 loopback runtime health가
복구되지 않으면 설치 bundle rollback 결과를 receipt에 구분해 남깁니다.

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

### 작업 현황 + 승인함 웹

작업 현황 웹은 기존 mobile approval callback bridge의 loopback listener를 함께 사용합니다.
로컬에서는 `http://127.0.0.1:7980/activity/`, 같은 tailnet 기기에서는 mobile approval에
이미 설정된 Tailscale Serve 주소의 `/activity/`에서 볼 수 있습니다. 기본 설정이면
`https://<호스트>.ts.net:8443/activity/` 형태입니다. Funnel이나 LAN/public listener를
추가로 만들지 않습니다.

`/activity/api/activity`는 작업 현황과 현재 승인 대기 항목을 함께 주는 JSON이고
`/activity/api/health`는 상태 확인용입니다. 일반 작업 승인은 기존 mobile approval
allowlist에 포함된 exact operation(`command_run`, `verified_local_file_apply`)만
`POST /activity/api/approvals/<requestId>/{approve|reject}`로 처리할 수 있습니다.
이 POST는 mobile approval이 활성화되어 있어야 하고 Tailscale identity header와
설정된 `.ts.net:8443` origin이 모두 일치해야 합니다.

runtime/app 교체, lane 복구, 실행 취소, rg, 원격 제어처럼 Mac 직접 승인이 필요한 항목은
승인함에는 표시하지만 웹 버튼을 제공하지 않습니다. 따라서 웹 승인함 추가로 기존
menu-bar/local approval 보안 경계를 낮추지 않습니다.

대시보드는 ChatGPT가 제공한 실제 채팅 제목을 우선 표시하고 같은 conversation identity의
tool 호출을 한 카드로 묶습니다. 첫 C2CT 요청 시각, 마지막 활동 경과시간, 활성/응답 대기/
정체 가능/장시간 정체/승인 대기/완료 상태, 프로젝트, 최근 tool 이름과 secret-safe 작업
설명을 1초마다 갱신합니다. 승인함은 승인 유형, 프로젝트, secret-safe 요약, 요청/만료 시각,
`iPhone 승인 가능` 또는 `Mac에서 승인 필요` 상태를 함께 표시합니다. raw prompt나 Computer
Use 입력 payload는 제공하지 않습니다.

아이폰 등 tailnet 기기에서는 기존 Tailscale Serve가 callback bridge와 대시보드를 함께
proxy합니다. C2CT는 Funnel, tailnet ACL, 사용자/기기 정책을 변경하지 않으며 접근 범위는
Tailscale 설정에 맡깁니다.

macOS 메뉴바 앱의 **현재 작업 현황** 창도 별도의 Swift 카드 UI를 다시 구현하지 않고 같은
`http://127.0.0.1:7980/activity/?embedded=mac` 대시보드를 `WKWebView`로 표시합니다.
`embedded=mac` 쿼리는 여백 같은 표시 방식만 바꾸는 cosmetic hint이며 권한 판정에는 사용하지
않습니다. Mac 앱 전용 동작은 `WKWebView`에만 등록되는 `c2ctMacApp` native message bridge가
실제로 존재하고, 현재 페이지가 정확한 loopback `/activity/` URL일 때만 사용할 수 있습니다.
브리지는 승인 자체를 웹에서 우회 처리하지 않고 기존 Mac 네이티브 승인 메뉴를 여는 역할만
합니다. 일반 Safari에서 같은 쿼리 파라미터를 붙여도 bridge가 없으므로 Mac 권한이 생기지
않습니다. 최초 로컬 대시보드 로드가 실패하면 앱은 작업현황을 복제하지 않는 최소 연결 오류/
다시 시도 화면만 표시합니다.

## 남아 있는 경계

ChatGPT가 반환하는 `We couldn't connect your account` 문구 자체는 ChatGPT connector
계층에서 생성될 수 있어 C2CT가 바꿀 수 없습니다. 대신 “로컬 로그에 요청이
있었는가”를 기준으로 서버 내부 문제와 서버 도달 전 문제를 구분할 수 있습니다.
