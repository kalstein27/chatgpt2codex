import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostCatalogRebindMarkerToolName } from "../runtime/host-catalog-rebind.js";
import { getRuntimeManifest } from "../runtime/runtime-manifest.js";

const OUTPUT_LIMIT_BYTES = 64 * 1024;
const HARD_KILL_GRACE_MS = 1_000;

export const CHATGPT_HOST_CATALOG_FIXED_ACTIONS = {
  "scan-tools": ["plugin", "scan-tools", "C2CT", "--json"],
} as const;

export type ChatGptHostCatalogFixedAction = keyof typeof CHATGPT_HOST_CATALOG_FIXED_ACTIONS;

export type ChatGptHostCatalogProgress = {
  schemaVersion: 1;
  phase: "catalog-refresh" | "scan-tools";
  state: "running" | "completed" | "failed";
  verified?: boolean;
};

export type ChatGptHostCatalogProgressListener = (progress: ChatGptHostCatalogProgress) => void;

const CHATGPT_SEND_CATALOG_PROGRESS_PREFIX = "C2CT_CATALOG_PROGRESS ";

export const CHATGPT_HOST_CATALOG_ACTION_TIMEOUT_MS: Record<ChatGptHostCatalogFixedAction, number> = {
  "scan-tools": 180_000,
};

export type ChatGptHostCatalogRunResult = {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  parsed: Record<string, unknown> | null;
};

export type ChatGptHostCatalogRefreshResult = {
  ok: boolean;
  status: "refresh-requested" | "manual-action-required" | "unavailable" | "failed";
  catalogRefreshRequested: boolean;
  hostScanCompleted: boolean;
  errorCode?: string;
  message?: string;
  stageDurationsMs?: Partial<Record<"resolveExecutable" | "catalogRefresh" | "scanTools", number>>;
  stageResults?: Partial<Record<"catalogRefresh" | "scanTools", {
    exitCode: number | null;
    timedOut: boolean;
    timeoutMs: number;
  }>>;
  failureStage?: "resolveExecutable" | "catalogRefresh" | "scanTools";
  failureExitCode?: number | null;
  failureTimedOut?: boolean;
  scan?: {
    scanned?: boolean;
    installed?: boolean;
    toolCount?: number;
    enabledToolCount?: number;
    hostToolCount?: number;
    hostMcpToolsListVerified?: boolean;
    hostCatalogNamespaceMatched?: boolean;
    currentChatRebindProbeTool?: string;
    currentChatRebindProbeRequired?: boolean;
    hostCatalogGenerationMatched?: boolean;
  };
  recommendedAction:
    | "requery-current-chat"
    | "use-settings-force-refresh"
    | "install-chatgpt-send"
    | "inspect-chatgpt-send-failure";
  runtimeRestarted: false;
  connectorChanged: false;
  projectFilesChanged: false;
};

const NO_HOST_MUTATION = {
  runtimeRestarted: false,
  connectorChanged: false,
  projectFilesChanged: false,
} as const;

export interface ChatGptHostCatalogRefreshDependencies {
  resolveExecutable?: () => Promise<string | null>;
  runFixed?: (
    executablePath: string,
    action: ChatGptHostCatalogFixedAction,
  ) => Promise<ChatGptHostCatalogRunResult>;
}

function boundedAppend(current: Buffer, chunk: Buffer): Buffer {
  if (current.length >= OUTPUT_LIMIT_BYTES) return current;
  const remaining = OUTPUT_LIMIT_BYTES - current.length;
  return Buffer.concat([current, chunk.subarray(0, remaining)]);
}

function parseJsonObject(candidate: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(candidate) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseLastJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const whole = parseJsonObject(trimmed);
  if (whole) return whole;

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: Record<string, unknown> | null = null;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (depth === 0) {
      if (character === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const parsed = parseJsonObject(trimmed.slice(start, index + 1));
        if (parsed) last = parsed;
        start = -1;
      }
    }
  }
  return last;
}

export function parseChatGptSendOutput(stdout: string, stderr: string): Record<string, unknown> | null {
  // `chatgpt-send --json` writes the authoritative result to stdout. stderr may
  // contain unrelated diagnostics, so never concatenate the streams before
  // parsing or a trailing brace in stderr can shadow the real top-level result.
  return parseLastJsonObject(stdout) ?? parseLastJsonObject(stderr);
}

export function parseChatGptSendProgressLine(line: string): ChatGptHostCatalogProgress | null {
  if (typeof line !== "string" || !line.startsWith(CHATGPT_SEND_CATALOG_PROGRESS_PREFIX)) return null;
  const parsed = parseJsonObject(line.slice(CHATGPT_SEND_CATALOG_PROGRESS_PREFIX.length));
  if (!parsed || parsed.schemaVersion !== 1) return null;
  const phase = parsed.phase;
  const state = parsed.state;
  if (phase !== "catalog-refresh" && phase !== "scan-tools") return null;
  if (state !== "running" && state !== "completed" && state !== "failed") return null;
  if (parsed.verified !== undefined && typeof parsed.verified !== "boolean") return null;
  return {
    schemaVersion: 1,
    phase,
    state,
    ...(typeof parsed.verified === "boolean" ? { verified: parsed.verified } : {}),
  };
}

function safeText(value: unknown, max = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n\t]+/gu, " ").trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

const HOST_CATALOG_MARKER_PATTERN = /^chatgpt_catalog_refresh_marker_[a-f0-9]{12}$/u;

function safeMarkerTool(value: unknown): string | undefined {
  return typeof value === "string" && HOST_CATALOG_MARKER_PATTERN.test(value) ? value : undefined;
}

function expectedRuntimeMarkerTool(): string | null {
  try {
    return hostCatalogRebindMarkerToolName(getRuntimeManifest().hostCatalogRevision);
  } catch {
    return null;
  }
}

function scannedMarkerTool(parsed: Record<string, unknown> | null, integrated: boolean): string | undefined {
  if (!parsed) return undefined;
  const nested = integrated ? safeRecord(parsed.scanTools) : null;
  return safeMarkerTool(parsed.currentChatRebindProbeTool) ?? safeMarkerTool(nested?.currentChatRebindProbeTool);
}

function scannedMarkerRequired(parsed: Record<string, unknown> | null, integrated: boolean): boolean | undefined {
  if (!parsed) return undefined;
  const nested = integrated ? safeRecord(parsed.scanTools) : null;
  return safeBoolean(parsed.currentChatRebindProbeRequired) ?? safeBoolean(nested?.currentChatRebindProbeRequired);
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function refreshInvocationState(parsed: Record<string, unknown> | null): "not-attempted" | "unknown" | "confirmed" | null {
  const phaseE = safeRecord(parsed?.phaseE);
  const state = safeText(phaseE?.refreshInvocationState, 32);
  return state === "not-attempted" || state === "unknown" || state === "confirmed" ? state : null;
}

function refreshConfirmed(parsed: Record<string, unknown> | null): boolean {
  if (!parsed) return false;
  const state = refreshInvocationState(parsed);
  return state === "confirmed"
    || (parsed.catalogRefreshRequested === true && parsed.uiRefreshActionAccepted === true);
}

function integratedScanCompleted(parsed: Record<string, unknown> | null): boolean {
  return Boolean(parsed?.scanToolsCompleted === true && parsed?.pipelineCompleted === true);
}

function catalogRefreshErrorCode(parsed: Record<string, unknown> | null): string | undefined {
  const phaseE = safeRecord(parsed?.phaseE);
  return safeText(parsed?.errorCode, 80) ?? safeText(phaseE?.errorCode, 80);
}

function sanitizeScan(
  parsed: Record<string, unknown> | null,
  expectedMarkerTool: string | null,
  integrated = false,
): ChatGptHostCatalogRefreshResult["scan"] | undefined {
  if (!parsed) return undefined;
  const nested = integrated ? safeRecord(parsed.scanTools) : null;
  const observedMarkerTool = scannedMarkerTool(parsed, integrated);
  return {
    scanned: integrated && parsed.scanToolsCompleted === true
      ? true
      : safeBoolean(parsed.scanned) ?? safeBoolean(nested?.scanned),
    installed: integrated
      ? safeBoolean(nested?.installed) ?? safeBoolean(parsed.installed)
      : safeBoolean(parsed.installed),
    toolCount: safeCount(parsed.toolCount) ?? safeCount(nested?.toolCount),
    enabledToolCount: safeCount(parsed.enabledToolCount) ?? safeCount(nested?.enabledToolCount),
    hostToolCount: safeCount(parsed.hostToolCount) ?? safeCount(nested?.hostToolCount),
    hostMcpToolsListVerified: safeBoolean(parsed.hostMcpToolsListVerified) ?? safeBoolean(nested?.hostMcpToolsListVerified),
    hostCatalogNamespaceMatched: safeBoolean(parsed.hostCatalogNamespaceMatched) ?? safeBoolean(nested?.hostCatalogNamespaceMatched),
    currentChatRebindProbeTool: observedMarkerTool,
    currentChatRebindProbeRequired: scannedMarkerRequired(parsed, integrated),
    hostCatalogGenerationMatched: expectedMarkerTool && observedMarkerTool
      ? expectedMarkerTool === observedMarkerTool
      : undefined,
  };
}

function looksLikeAccessibilityFailure(errorCode: string | undefined, message: string | undefined): boolean {
  if (errorCode !== "CLI_ERROR" || !message) return false;
  const lower = message.toLowerCase();
  return lower.includes("accessibility") || message.includes("손쉬운 사용") || message.includes("새로고침 버튼");
}

async function executable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveChatGptSendPath(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const candidates = [
    path.resolve(process.cwd(), "../chatgpt-mac-send/chatgpt-send"),
    path.join(os.homedir(), ".local", "bin", "chatgpt-send"),
    "/opt/homebrew/bin/chatgpt-send",
    "/usr/local/bin/chatgpt-send",
  ];
  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }
  return null;
}

export async function runFixedChatGptSend(
  executablePath: string,
  action: ChatGptHostCatalogFixedAction,
  onProgress?: ChatGptHostCatalogProgressListener,
): Promise<ChatGptHostCatalogRunResult> {
  if (action !== "scan-tools") {
    return {
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      parsed: { ok: false, errorCode: "CHATGPT_SEND_BOUNDARY_RETIRED" },
    };
  }
  const timeoutMs = CHATGPT_HOST_CATALOG_ACTION_TIMEOUT_MS[action];
  return new Promise((resolve) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let hardKillTimer: NodeJS.Timeout | undefined;
    let progressRemainder = "";
    const env: NodeJS.ProcessEnv = {
      HOME: os.homedir(),
      PATH: `${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    };

    // execution-capability: chatgpt-scan-tools
    const child = spawn(executablePath, [...CHATGPT_HOST_CATALOG_FIXED_ACTIONS[action]], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk);
      const combined = progressRemainder + chunk.toString("utf8");
      const lines = combined.split(/\r?\n/u);
      progressRemainder = lines.pop() ?? "";
      for (const line of lines) {
        const progress = parseChatGptSendProgressLine(line);
        if (progress) onProgress?.(progress);
      }
    });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      const stdoutText = stdout.toString("utf8");
      const stderrText = stderr.toString("utf8");
      if (progressRemainder) {
        const progress = parseChatGptSendProgressLine(progressRemainder);
        if (progress) onProgress?.(progress);
        progressRemainder = "";
      }
      resolve({
        exitCode,
        timedOut,
        stdout: stdoutText,
        stderr: stderrText,
        parsed: parseChatGptSendOutput(stdoutText, stderrText),
      });
    };

    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, HARD_KILL_GRACE_MS);
    }, timeoutMs);
  });
}

export async function refreshChatGptHostCatalog(
  dependencies: ChatGptHostCatalogRefreshDependencies = {},
  onProgress?: ChatGptHostCatalogProgressListener,
): Promise<ChatGptHostCatalogRefreshResult> {
  void dependencies;
  void onProgress;
  return {
    ok: false,
    status: "manual-action-required",
    catalogRefreshRequested: false,
    hostScanCompleted: false,
    errorCode: "CHATGPT_SEND_BOUNDARY_RETIRED",
    message: "Programmatic ChatGPT catalog refresh through chatgpt-send is retired. Use the manual Settings refresh flow, then run scan-tools once.",
    recommendedAction: "use-settings-force-refresh",
    ...NO_HOST_MUTATION,
  };
}
