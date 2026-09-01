import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { listArmRequests, type ArmRequestRecord } from "../control/arm-requests.js";
import {
  isMobileApprovableOperationTool,
  listOperationApprovalRequests,
  resolveOperationApprovalRequest,
  type OperationApprovalRequest,
} from "./operation-approval.js";
import { listPendingRgApprovalRequests, type RgApprovalRequest } from "./rg-capability.js";
import type { RuntimeActivityTracker } from "../runtime/activity.js";
import {
  activityDashboardDocument,
  activityDashboardSnapshot,
  type ActivityDashboardApproval,
} from "../server/activity-dashboard.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const CONFIG_SCHEMA_VERSION = 1;
const CONFIG_FILE = "mobile-approval.json";
const NTFY_BASE_URL = "https://ntfy.sh";
const CALLBACK_HOST = "127.0.0.1";
export const MOBILE_APPROVAL_CALLBACK_PORT = 7980;
export const MOBILE_APPROVAL_TAILSCALE_HTTPS_PORT = 8443;
const POLL_INTERVAL_MS = 1_000;
const RETRY_INTERVAL_MS = 15_000;
const PUBLISH_TIMEOUT_MS = 5_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TOPIC_PATTERN = /^c2ct-[A-Za-z0-9_-]{43}$/u;

// execution-capability: tailscale-mobile-approval-serve
const execFileAsync = promisify(execFile);

export type MobileApprovalDecision = "approve" | "reject";

export interface MobileApprovalConfig {
  schemaVersion: 1;
  enabled: boolean;
  provider: "ntfy";
  ntfyBaseUrl: string;
  topic: string;
  callbackOrigin: string;
  configuredAt: number;
}

export interface MobileApprovalSetupResult {
  config: MobileApprovalConfig;
  tailscaleServeConfigured: boolean;
  tailscaleBinary: string;
}

export interface MobileApprovalStatus {
  configured: boolean;
  enabled: boolean;
  provider: "ntfy" | null;
  callbackOrigin: string | null;
  callbackPort: number;
  tailscaleHttpsPort: number;
  topicHint: string | null;
  bridgeListening: boolean;
  bridgeError: string | null;
  pendingChallengeCount: number;
  lastPublishAt: number | null;
  lastPublishError: string | null;
}

interface MobileApprovalChallenge {
  token: string;
  requestId: string;
  projectId: string;
  risk: string;
  expiresAt: number;
  sent: boolean;
  lastAttemptAt: number;
}

interface LocalOnlyApprovalNotice {
  key: string;
  requestId: string;
  projectId: string;
  category: string;
  summary: string;
  expiresAt: number;
}

interface RuntimeBridgeState {
  listening: boolean;
  error: string | null;
  pendingChallengeCount: number;
  lastPublishAt: number | null;
  lastPublishError: string | null;
}

interface BridgeOptions {
  stateDir: string;
  callbackPort?: number;
  fetchImpl?: typeof fetch;
  activityTracker?: RuntimeActivityTracker;
  ledgerAppend?: (event: { type: string; [key: string]: unknown }) => Promise<void>;
}

interface TailscaleExecResult {
  stdout?: string;
  stderr?: string;
}

export interface TailscaleRunnerOptions {
  exec?: (file: string, args: string[]) => Promise<TailscaleExecResult>;
  candidates?: string[];
}

const TAILSCALE_CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
] as const;

const bridgeStates = new Map<string, RuntimeBridgeState>();

function configPath(stateDir: string): string {
  return path.join(stateDir, CONFIG_FILE);
}

async function ensureStateDir(stateDir: string): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(stateDir, DIR_MODE).catch(() => undefined);
}

function validConfig(value: unknown): value is MobileApprovalConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<MobileApprovalConfig>;
  if (
    config.schemaVersion !== CONFIG_SCHEMA_VERSION ||
    typeof config.enabled !== "boolean" ||
    config.provider !== "ntfy" ||
    config.ntfyBaseUrl !== NTFY_BASE_URL ||
    typeof config.topic !== "string" ||
    !TOPIC_PATTERN.test(config.topic) ||
    typeof config.callbackOrigin !== "string" ||
    typeof config.configuredAt !== "number"
  ) return false;
  try {
    const callback = new URL(config.callbackOrigin);
    return callback.protocol === "https:" &&
      callback.hostname.toLowerCase().endsWith(".ts.net") &&
      callback.port === String(MOBILE_APPROVAL_TAILSCALE_HTTPS_PORT) &&
      callback.pathname === "/";
  } catch {
    return false;
  }
}

export async function readMobileApprovalConfig(stateDir: string): Promise<MobileApprovalConfig | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath(stateDir), "utf8"));
    return validConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeMobileApprovalConfig(stateDir: string, config: MobileApprovalConfig): Promise<void> {
  await ensureStateDir(stateDir);
  const destination = configPath(stateDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
  await fs.chmod(temporary, FILE_MODE).catch(() => undefined);
  try {
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export function deriveMobileApprovalCallbackOrigin(publicUrl: string | undefined): string {
  if (!publicUrl) throw new Error("A Tailscale .ts.net public origin is required before mobile approval can be enabled.");
  const parsed = new URL(publicUrl);
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname.endsWith(".ts.net")) {
    throw new Error("Mobile approval requires the current connector hostname to be a Tailscale .ts.net name.");
  }
  return `https://${hostname}:${MOBILE_APPROVAL_TAILSCALE_HTTPS_PORT}`;
}

function newTopic(): string {
  return `c2ct-${randomBytes(32).toString("base64url")}`;
}

function newChallengeToken(): string {
  return randomBytes(32).toString("base64url");
}

function topicHint(topic: string): string {
  return `${topic.slice(0, 10)}…${topic.slice(-6)}`;
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  return error.name || "Error";
}

async function resolveTailscaleBinary(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      const info = await fs.stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Continue through the fixed candidate list only.
    }
  }
  throw new Error("Tailscale CLI was not found at an approved fixed path.");
}

async function defaultTailscaleExec(file: string, args: string[]): Promise<TailscaleExecResult> {
  const result = await execFileAsync(file, args, {
    timeout: 10_000,
    maxBuffer: 128 * 1024,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function configureMobileApprovalTailscaleServe(
  action: "enable" | "disable",
  options: TailscaleRunnerOptions = {},
): Promise<{ binary: string }> {
  const binary = await resolveTailscaleBinary(options.candidates ?? TAILSCALE_CANDIDATES);
  const exec = options.exec ?? defaultTailscaleExec;
  const args = action === "enable"
    ? [
        "serve",
        "--bg",
        "--yes",
        `--https=${MOBILE_APPROVAL_TAILSCALE_HTTPS_PORT}`,
        `http://${CALLBACK_HOST}:${MOBILE_APPROVAL_CALLBACK_PORT}`,
      ]
    : ["serve", "--yes", `--https=${MOBILE_APPROVAL_TAILSCALE_HTTPS_PORT}`, "off"];
  await exec(binary, args);
  return { binary };
}

export async function enableMobileApproval(input: {
  stateDir: string;
  publicUrl: string | undefined;
  tailscale?: TailscaleRunnerOptions;
  now?: number;
}): Promise<MobileApprovalSetupResult> {
  const now = input.now ?? Date.now();
  const callbackOrigin = deriveMobileApprovalCallbackOrigin(input.publicUrl);
  const existing = await readMobileApprovalConfig(input.stateDir);
  const config: MobileApprovalConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    enabled: true,
    provider: "ntfy",
    ntfyBaseUrl: NTFY_BASE_URL,
    topic: existing?.topic ?? newTopic(),
    callbackOrigin,
    configuredAt: now,
  };
  const serve = await configureMobileApprovalTailscaleServe("enable", input.tailscale);
  try {
    await writeMobileApprovalConfig(input.stateDir, config);
  } catch (error) {
    await configureMobileApprovalTailscaleServe("disable", input.tailscale).catch(() => undefined);
    throw error;
  }
  return { config, tailscaleServeConfigured: true, tailscaleBinary: serve.binary };
}

export async function disableMobileApproval(input: {
  stateDir: string;
  tailscale?: TailscaleRunnerOptions;
  now?: number;
}): Promise<MobileApprovalSetupResult | null> {
  const existing = await readMobileApprovalConfig(input.stateDir);
  if (!existing) return null;
  const config: MobileApprovalConfig = {
    ...existing,
    enabled: false,
    configuredAt: input.now ?? Date.now(),
  };
  await writeMobileApprovalConfig(input.stateDir, config);
  const serve = await configureMobileApprovalTailscaleServe("disable", input.tailscale);
  return { config, tailscaleServeConfigured: true, tailscaleBinary: serve.binary };
}

function tailscaleIdentity(req: IncomingMessage): string | null {
  const login = req.headers["tailscale-user-login"];
  if (typeof login === "string" && login.trim()) return login.trim();
  const name = req.headers["tailscale-user-name"];
  if (typeof name === "string" && name.trim()) return name.trim();
  return null;
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(`${JSON.stringify(body)}\n`);
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function setDashboardHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("pragma", "no-cache");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

function dashboardOriginMatches(req: IncomingMessage, config: MobileApprovalConfig): boolean {
  const origin = req.headers.origin;
  return typeof origin === "string" && origin === config.callbackOrigin;
}


function callbackUrl(config: MobileApprovalConfig, challenge: string, decision: MobileApprovalDecision): string {
  return `${config.callbackOrigin}/v1/operation-approvals/${challenge}/${decision}`;
}

function responseTopic(config: MobileApprovalConfig): string {
  return `${config.topic}-response`;
}

function responseAction(config: MobileApprovalConfig, challenge: string, decision: MobileApprovalDecision): Record<string, unknown> {
  return {
    action: "http",
    label: decision === "approve" ? "허용" : "거부",
    url: `${config.ntfyBaseUrl}/${responseTopic(config)}`,
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: `${decision}|${challenge}`,
    clear: true,
  };
}

function ntfyPayload(config: MobileApprovalConfig, request: OperationApprovalRequest, challenge: string): Record<string, unknown> {
  const risk = request.risk === "network"
    ? "네트워크 접근"
    : request.risk === "local-file-mutation"
      ? "고정 로컬 파일 변경"
      : "파괴적 변경 가능";
  return {
    topic: config.topic,
    title: "C2CT 승인 요청",
    message: `프로젝트: ${request.projectId}\n위험: ${risk}\n작업: ${request.preview}`,
    priority: 4,
    tags: ["lock"],
    actions: [
      responseAction(config, challenge, "approve"),
      responseAction(config, challenge, "reject"),
    ],
  };
}

function localOnlyOperationCategory(tool: string): string {
  if (tool === "runtime_apply_local") return "런타임 교체";
  if (tool === "macos_app_apply_local") return "macOS 앱 교체";
  if (tool === "project_lane_recover") return "작업 lane 복구";
  if (tool === "operation_cancel") return "실행 중인 작업 취소";
  if (tool === "mobile_approval_setup") return "모바일 승인 설정";
  if (tool === "runtime_snapshot_prune_local") return "런타임 스냅샷 정리";
  return "보호 작업";
}

function operationApprovalCategory(tool: string): string {
  if (tool === "command_run") return "명령 실행";
  if (tool === "verified_local_file_apply") return "검증된 로컬 파일 변경";
  return localOnlyOperationCategory(tool);
}

function operationLocalOnlyNotice(request: OperationApprovalRequest): LocalOnlyApprovalNotice {
  return {
    key: `operation:${request.requestId}`,
    requestId: request.requestId,
    projectId: request.projectId,
    category: localOnlyOperationCategory(request.tool),
    summary: request.preview,
    expiresAt: request.expiresAt,
  };
}

function rgLocalOnlyNotice(request: RgApprovalRequest): LocalOnlyApprovalNotice {
  return {
    key: `rg:${request.requestId}`,
    requestId: request.requestId,
    projectId: request.projectId,
    category: "외부 검색 도구 (rg)",
    summary: `검색: ${request.queryPreview}`,
    expiresAt: request.expiresAt,
  };
}

function armLocalOnlyNotice(request: ArmRequestRecord): LocalOnlyApprovalNotice {
  return {
    key: `arm:${request.requestId}`,
    requestId: request.requestId,
    projectId: request.projectId,
    category: "원격 제어",
    summary: `${request.clientLabel}: ${request.reason}`,
    expiresAt: request.expiresAt,
  };
}

async function dashboardApprovalItems(
  stateDir: string,
  mobileWebAvailable: boolean,
  now: number,
): Promise<ActivityDashboardApproval[]> {
  const [operationRequests, rgRequests, armRequests] = await Promise.all([
    listOperationApprovalRequests(stateDir, now),
    listPendingRgApprovalRequests(stateDir, now),
    listArmRequests(stateDir, now),
  ]);
  const operationItems: ActivityDashboardApproval[] = operationRequests
    .filter((request) =>
      request.status === "pending" &&
      request.expiresAt > now &&
      (request.approvalSurface ?? "local") !== "chatgpt-widget",
    )
    .map((request) => {
      const mobile = isMobileApprovableOperationTool(request.tool);
      return {
        id: request.requestId,
        kind: "operation",
        projectId: request.projectId,
        category: operationApprovalCategory(request.tool),
        summary: request.preview,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
        channel: mobile ? "mobile" : "mac",
        canDecide: mobile && mobileWebAvailable,
        tool: request.tool,
        risk: request.risk,
        ...(request.originOperationId ? { relatedOperationId: request.originOperationId } : {}),
      };
    });
  const rgItems: ActivityDashboardApproval[] = rgRequests.map((request) => ({
    id: request.requestId,
    kind: "rg",
    projectId: request.projectId,
    category: "외부 검색 도구 (rg)",
    summary: `검색: ${request.queryPreview}`,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    channel: "mac",
    canDecide: false,
    tool: "rg_search",
  }));
  const controlItems: ActivityDashboardApproval[] = armRequests.requests
    .filter((request) => request.status === "pending" && request.expiresAt > now)
    .map((request) => ({
      id: request.requestId,
      kind: "control",
      projectId: request.projectId,
      category: "원격 제어",
      summary: `${request.clientLabel}: ${request.reason}`,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      channel: "mac",
      canDecide: false,
      tool: "computer_control",
    }));
  return [...operationItems, ...rgItems, ...controlItems]
    .sort((left, right) => left.createdAt - right.createdAt);
}

function ntfyLocalOnlyPayload(config: MobileApprovalConfig, notice: LocalOnlyApprovalNotice): Record<string, unknown> {
  const inboxUrl = `${config.callbackOrigin}/activity/`;
  return {
    topic: config.topic,
    title: "C2CT 승인 요청 · Mac 확인 필요",
    message: `유형: ${notice.category}\n프로젝트: ${notice.projectId}\n작업: ${notice.summary}\n처리: Mac의 C2CT 승인창에서 허용 또는 거부`,
    priority: 4,
    tags: ["lock"],
    click: inboxUrl,
    actions: [
      {
        action: "view",
        label: "승인 상태 보기",
        url: inboxUrl,
      },
    ],
  };
}

async function publishNtfyLocalOnly(
  fetchImpl: typeof fetch,
  config: MobileApprovalConfig,
  notice: LocalOnlyApprovalNotice,
): Promise<void> {
  const response = await fetchImpl(config.ntfyBaseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ntfyLocalOnlyPayload(config, notice)),
    signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ntfy local-only publish returned HTTP ${response.status}`);
}

async function publishNtfy(
  fetchImpl: typeof fetch,
  config: MobileApprovalConfig,
  request: OperationApprovalRequest,
  challenge: string,
): Promise<void> {
  const response = await fetchImpl(config.ntfyBaseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ntfyPayload(config, request, challenge)),
    signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ntfy publish returned HTTP ${response.status}`);
}

function ntfyDecisionPayload(
  config: MobileApprovalConfig,
  request: OperationApprovalRequest,
  decision: MobileApprovalDecision,
): Record<string, unknown> {
  const approved = decision === "approve";
  return {
    topic: config.topic,
    title: approved ? "✅ C2CT 승인 완료" : "❌ C2CT 승인 거절",
    message: `프로젝트: ${request.projectId}\n결과: ${approved ? "허용됨" : "거절됨"}\n작업: ${request.preview}`,
    priority: 3,
  };
}

async function publishNtfyDecision(
  fetchImpl: typeof fetch,
  config: MobileApprovalConfig,
  request: OperationApprovalRequest,
  decision: MobileApprovalDecision,
): Promise<void> {
  const response = await fetchImpl(config.ntfyBaseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ntfyDecisionPayload(config, request, decision)),
    signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ntfy result publish returned HTTP ${response.status}`);
}

export class MobileApprovalBridge {
  private readonly stateDir: string;
  private readonly callbackPort: number;
  private readonly fetchImpl: typeof fetch;
  private readonly activityTracker?: RuntimeActivityTracker;
  private readonly ledgerAppend?: BridgeOptions["ledgerAppend"];
  private server: ReturnType<typeof createServer> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly byToken = new Map<string, MobileApprovalChallenge>();
  private readonly tokenByRequest = new Map<string, string>();
  private readonly sentLocalNoticeKeys = new Set<string>();
  private readonly localNoticeLastAttemptAt = new Map<string, number>();
  private polling = false;

  constructor(options: BridgeOptions) {
    this.stateDir = path.resolve(options.stateDir);
    this.callbackPort = options.callbackPort ?? MOBILE_APPROVAL_CALLBACK_PORT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.activityTracker = options.activityTracker;
    this.ledgerAppend = options.ledgerAppend;
    bridgeStates.set(this.stateDir, {
      listening: false,
      error: null,
      pendingChallengeCount: 0,
      lastPublishAt: null,
      lastPublishError: null,
    });
  }

  private state(): RuntimeBridgeState {
    const existing = bridgeStates.get(this.stateDir);
    if (existing) return existing;
    const created: RuntimeBridgeState = {
      listening: false,
      error: null,
      pendingChallengeCount: 0,
      lastPublishAt: null,
      lastPublishError: null,
    };
    bridgeStates.set(this.stateDir, created);
    return created;
  }

  private syncChallengeCount(): void {
    this.state().pendingChallengeCount = this.byToken.size;
  }

  private cleanupLocalNoticeTracking(activeKeys: Set<string>): void {
    for (const key of [...this.sentLocalNoticeKeys]) {
      if (!activeKeys.has(key)) this.sentLocalNoticeKeys.delete(key);
    }
    for (const key of [...this.localNoticeLastAttemptAt.keys()]) {
      if (!activeKeys.has(key)) this.localNoticeLastAttemptAt.delete(key);
    }
  }

  private async publishLocalOnlyNotice(config: MobileApprovalConfig, notice: LocalOnlyApprovalNotice, now: number): Promise<void> {
    if (this.sentLocalNoticeKeys.has(notice.key)) return;
    const lastAttemptAt = this.localNoticeLastAttemptAt.get(notice.key) ?? 0;
    if (now - lastAttemptAt < RETRY_INTERVAL_MS) return;
    this.localNoticeLastAttemptAt.set(notice.key, now);
    try {
      await publishNtfyLocalOnly(this.fetchImpl, config, notice);
      this.sentLocalNoticeKeys.add(notice.key);
      this.state().lastPublishAt = now;
      this.state().lastPublishError = null;
      await this.ledgerAppend?.({
        type: "approval.mobile.local_only_notified",
        requestId: notice.requestId,
        projectId: notice.projectId,
        category: notice.category,
      }).catch(() => undefined);
    } catch (error) {
      this.state().lastPublishError = safeError(error);
    }
  }

  private async applyDecision(config: MobileApprovalConfig, token: string, decision: MobileApprovalDecision, now: number): Promise<boolean> {
    const challenge = this.byToken.get(token);
    if (!challenge || challenge.expiresAt <= now) {
      this.byToken.delete(token);
      if (challenge) this.tokenByRequest.delete(challenge.requestId);
      this.syncChallengeCount();
      return false;
    }

    const requests = await listOperationApprovalRequests(this.stateDir, now);
    const request = requests.find((entry) => entry.requestId === challenge.requestId);
    if (!request ||
        request.status !== "pending" ||
        (request.approvalSurface ?? "local") === "chatgpt-widget" ||
        !isMobileApprovableOperationTool(request.tool) ||
        request.expiresAt <= now) {
      this.byToken.delete(token);
      this.tokenByRequest.delete(challenge.requestId);
      this.syncChallengeCount();
      return false;
    }

    await resolveOperationApprovalRequest({
      stateDir: this.stateDir,
      requestId: request.requestId,
      decision,
      approvedVia: "mobile-ntfy",
      now,
    });
    this.byToken.delete(token);
    this.tokenByRequest.delete(challenge.requestId);
    this.syncChallengeCount();
    await this.ledgerAppend?.({
      type: decision === "approve" ? "operation.approval.mobile.approved" : "operation.approval.mobile.rejected",
      requestId: request.requestId,
      projectId: request.projectId,
      tool: request.tool,
      risk: request.risk,
      transport: "ntfy-response-topic",
    }).catch(() => undefined);
    try {
      await publishNtfyDecision(this.fetchImpl, config, request, decision);
      await this.ledgerAppend?.({
        type: "operation.approval.mobile.result_notified",
        requestId: request.requestId,
        projectId: request.projectId,
        tool: request.tool,
        risk: request.risk,
        decision,
      }).catch(() => undefined);
    } catch {
      await this.ledgerAppend?.({
        type: "operation.approval.mobile.result_notification_failed",
        requestId: request.requestId,
        projectId: request.projectId,
        tool: request.tool,
        risk: request.risk,
        decision,
      }).catch(() => undefined);
    }
    return true;
  }

  private async pollNtfyResponses(config: MobileApprovalConfig, now: number): Promise<void> {
    if (![...this.byToken.values()].some((challenge) => challenge.sent && challenge.expiresAt > now)) return;
    const url = `${config.ntfyBaseUrl}/${responseTopic(config)}/json?poll=1&since=30s`;
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/x-ndjson" },
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      });
      if (!response.ok) return;
      const body = await response.text();
      for (const line of body.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!event || typeof event !== "object") continue;
        const typed = event as { event?: unknown; message?: unknown };
        if (typed.event !== "message" || typeof typed.message !== "string") continue;
        const parsed = /^(approve|reject)\|([A-Za-z0-9_-]{43})$/u.exec(typed.message);
        if (!parsed?.[1] || !parsed[2] || !TOKEN_PATTERN.test(parsed[2])) continue;
        await this.applyDecision(config, parsed[2], parsed[1] as MobileApprovalDecision, now);
      }
    } catch {
      // Best-effort relay polling. The pending local approval remains intact.
    }
  }

  private async ensureCallbackServer(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handleCallback(req, res).catch(() => sendJson(res, 500, { ok: false }));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.callbackPort, CALLBACK_HOST);
    }).then(() => {
      this.state().listening = true;
      this.state().error = null;
      server.unref();
    }).catch((error) => {
      this.state().listening = false;
      this.state().error = safeError(error);
      if (this.server === server) this.server = undefined;
    });
  }

  async start(): Promise<void> {
    await this.ensureCallbackServer();

    this.timer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
    this.timer.unref();
    await this.poll();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    }
    this.byToken.clear();
    this.tokenByRequest.clear();
    this.sentLocalNoticeKeys.clear();
    this.localNoticeLastAttemptAt.clear();
    this.state().listening = false;
    this.syncChallengeCount();
  }

  async poll(now = Date.now()): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      if (!this.state().listening) {
        await this.ensureCallbackServer();
        if (!this.state().listening) return;
      }
      const config = await readMobileApprovalConfig(this.stateDir);
      const requests = await listOperationApprovalRequests(this.stateDir, now);
      let pending = new Map(
        requests
          .filter((request) =>
            request.status === "pending" &&
            (request.approvalSurface ?? "local") !== "chatgpt-widget" &&
            isMobileApprovableOperationTool(request.tool) &&
            request.expiresAt > now,
          )
          .map((request) => [request.requestId, request]),
      );

      for (const [requestId, token] of [...this.tokenByRequest]) {
        const challenge = this.byToken.get(token);
        if (!challenge || !pending.has(requestId) || challenge.expiresAt <= now) {
          this.tokenByRequest.delete(requestId);
          this.byToken.delete(token);
        }
      }
      this.syncChallengeCount();
      if (!config?.enabled) return;

      await this.pollNtfyResponses(config, now);
      const refreshedRequests = await listOperationApprovalRequests(this.stateDir, now);
      const pendingOperations = refreshedRequests
        .filter((request) => request.status === "pending" && request.expiresAt > now);
      pending = new Map(
        pendingOperations
          .filter((request) =>
            (request.approvalSurface ?? "local") !== "chatgpt-widget" &&
            isMobileApprovableOperationTool(request.tool),
          )
          .map((request) => [request.requestId, request]),
      );

      const localOnlyOperationNotices = pendingOperations
        .filter((request) =>
          (request.approvalSurface ?? "local") !== "chatgpt-widget" &&
          !isMobileApprovableOperationTool(request.tool),
        )
        .map(operationLocalOnlyNotice);
      const rgNotices = (await listPendingRgApprovalRequests(this.stateDir, now)).map(rgLocalOnlyNotice);
      const armNotices = (await listArmRequests(this.stateDir, now)).requests
        .filter((request) => request.status === "pending" && request.expiresAt > now)
        .map(armLocalOnlyNotice);
      const localOnlyNotices = [...localOnlyOperationNotices, ...rgNotices, ...armNotices];
      this.cleanupLocalNoticeTracking(new Set(localOnlyNotices.map((notice) => notice.key)));
      for (const notice of localOnlyNotices) {
        await this.publishLocalOnlyNotice(config, notice, now);
      }

      for (const request of pending.values()) {
        let challenge: MobileApprovalChallenge | undefined;
        const existingToken = this.tokenByRequest.get(request.requestId);
        if (existingToken) challenge = this.byToken.get(existingToken);
        if (!challenge) {
          const token = newChallengeToken();
          challenge = {
            token,
            requestId: request.requestId,
            projectId: request.projectId,
            risk: request.risk,
            expiresAt: request.expiresAt,
            sent: false,
            lastAttemptAt: 0,
          };
          this.byToken.set(token, challenge);
          this.tokenByRequest.set(request.requestId, token);
          this.syncChallengeCount();
        }
        if (challenge.sent || now - challenge.lastAttemptAt < RETRY_INTERVAL_MS) continue;
        challenge.lastAttemptAt = now;
        try {
          await publishNtfy(this.fetchImpl, config, request, challenge.token);
          challenge.sent = true;
          this.state().lastPublishAt = now;
          this.state().lastPublishError = null;
          await this.ledgerAppend?.({
            type: "operation.approval.mobile.notified",
            requestId: request.requestId,
            projectId: request.projectId,
            tool: request.tool,
            risk: request.risk,
          }).catch(() => undefined);
        } catch (error) {
          this.state().lastPublishError = safeError(error);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && requestPath.startsWith("/activity")) {
      if (!this.activityTracker || (!isLoopbackRequest(req) && !tailscaleIdentity(req))) {
        sendJson(res, this.activityTracker ? 403 : 404, { ok: false });
        return;
      }
      setDashboardHeaders(res);
      if (requestPath === "/activity/api/activity") {
        const now = Date.now();
        const dashboard = await activityDashboardDocument(this.stateDir);
        const config = await readMobileApprovalConfig(this.stateDir);
        const approvalItems = await dashboardApprovalItems(
          this.stateDir,
          Boolean(config?.enabled && tailscaleIdentity(req)),
          now,
        );
        sendJson(res, 200, activityDashboardSnapshot(this.activityTracker, approvalItems, now, dashboard.revision));
        return;
      }
      if (requestPath === "/activity/api/health") {
        sendJson(res, 200, { ok: true, generatedAt: Date.now() });
        return;
      }
      if (requestPath === "/activity" || requestPath === "/activity/") {
        const dashboard = await activityDashboardDocument(this.stateDir);
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(dashboard.html);
        return;
      }
      sendJson(res, 404, { ok: false });
      return;
    }

    if (req.method === "POST" && requestPath.startsWith("/activity/api/approvals/")) {
      if (!this.activityTracker) {
        sendJson(res, 404, { ok: false });
        return;
      }
      setDashboardHeaders(res);
      const config = await readMobileApprovalConfig(this.stateDir);
      if (!config?.enabled) {
        sendJson(res, 404, { ok: false });
        return;
      }
      if (!tailscaleIdentity(req) || !dashboardOriginMatches(req, config)) {
        sendJson(res, 403, { ok: false });
        return;
      }
      const parsed = /^\/activity\/api\/approvals\/(op_[0-9a-fA-F-]{36})\/(approve|reject)$/u.exec(requestPath);
      if (!parsed?.[1] || (parsed[2] !== "approve" && parsed[2] !== "reject")) {
        sendJson(res, 404, { ok: false });
        return;
      }
      const requestId = parsed[1];
      const decision = parsed[2] as MobileApprovalDecision;
      const now = Date.now();
      const request = (await listOperationApprovalRequests(this.stateDir, now))
        .find((entry) => entry.requestId === requestId);
      if (!request || request.status !== "pending" || request.expiresAt <= now) {
        sendJson(res, 410, { ok: false });
        return;
      }
      if ((request.approvalSurface ?? "local") === "chatgpt-widget" ||
          !isMobileApprovableOperationTool(request.tool)) {
        sendJson(res, 403, { ok: false });
        return;
      }
      try {
        await resolveOperationApprovalRequest({
          stateDir: this.stateDir,
          requestId,
          decision,
          approvedVia: "mobile-web",
          now,
        });
      } catch {
        sendJson(res, 409, { ok: false });
        return;
      }
      const challengeToken = this.tokenByRequest.get(requestId);
      if (challengeToken) this.byToken.delete(challengeToken);
      this.tokenByRequest.delete(requestId);
      this.syncChallengeCount();
      await this.ledgerAppend?.({
        type: decision === "approve" ? "operation.approval.mobile_web.approved" : "operation.approval.mobile_web.rejected",
        requestId,
        projectId: request.projectId,
        tool: request.tool,
        risk: request.risk,
      }).catch(() => undefined);
      try {
        await publishNtfyDecision(this.fetchImpl, config, request, decision);
      } catch {
        // The approval decision is authoritative even when the result notice fails.
      }
      sendJson(res, 200, { ok: true, decision });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false });
      return;
    }
    const config = await readMobileApprovalConfig(this.stateDir);
    if (!config?.enabled) {
      sendJson(res, 404, { ok: false });
      return;
    }
    if (!tailscaleIdentity(req)) {
      sendJson(res, 403, { ok: false });
      return;
    }
    const parsed = /^\/v1\/operation-approvals\/([A-Za-z0-9_-]{43})\/(approve|reject)$/u.exec(req.url ?? "");
    if (!parsed?.[1] || !TOKEN_PATTERN.test(parsed[1]) || (parsed[2] !== "approve" && parsed[2] !== "reject")) {
      sendJson(res, 404, { ok: false });
      return;
    }
    const token = parsed[1];
    const decision = parsed[2] as MobileApprovalDecision;
    const now = Date.now();
    const applied = await this.applyDecision(config, token, decision, now);
    sendJson(res, applied ? 200 : 410, { ok: applied, decision });
  }
}

export async function mobileApprovalStatus(stateDir: string): Promise<MobileApprovalStatus> {
  const resolved = path.resolve(stateDir);
  const config = await readMobileApprovalConfig(resolved);
  const runtime = bridgeStates.get(resolved);
  return {
    configured: config !== null,
    enabled: config?.enabled ?? false,
    provider: config?.provider ?? null,
    callbackOrigin: config?.callbackOrigin ?? null,
    callbackPort: MOBILE_APPROVAL_CALLBACK_PORT,
    tailscaleHttpsPort: MOBILE_APPROVAL_TAILSCALE_HTTPS_PORT,
    topicHint: config ? topicHint(config.topic) : null,
    bridgeListening: runtime?.listening ?? false,
    bridgeError: runtime?.error ?? null,
    pendingChallengeCount: runtime?.pendingChallengeCount ?? 0,
    lastPublishAt: runtime?.lastPublishAt ?? null,
    lastPublishError: runtime?.lastPublishError ?? null,
  };
}
