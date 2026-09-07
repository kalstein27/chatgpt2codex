import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const OUTPUT_LIMIT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 20_000;
const HARD_KILL_GRACE_MS = 1_000;

export const CHATGPT_HOST_CATALOG_FIXED_ACTIONS = {
  "catalog-refresh": ["plugin", "catalog-refresh", "C2CT", "--json"],
  "scan-tools": ["plugin", "scan-tools", "C2CT", "--json"],
} as const;

export type ChatGptHostCatalogFixedAction = keyof typeof CHATGPT_HOST_CATALOG_FIXED_ACTIONS;

export type ChatGptHostCatalogFixedCommandResult = {
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
  hostCatalogRebindVerified: null;
  errorCode?: string;
  message?: string;
  scan?: {
    scanned?: boolean;
    installed?: boolean;
    toolCount?: number;
    enabledToolCount?: number;
    hostToolCount?: number;
    hostMcpToolsListVerified?: boolean;
    hostCatalogNamespaceMatched?: boolean;
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

export interface ChatGptHostCatalogRefreshDependencies {
  resolveExecutable?: () => Promise<string | null>;
  runFixed?: (
    executablePath: string,
    action: ChatGptHostCatalogFixedAction,
  ) => Promise<ChatGptHostCatalogFixedCommandResult>;
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

  const lines = trimmed.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonObject(lines[index]!);
    if (parsed) return parsed;
  }

  let attempts = 0;
  for (let index = trimmed.lastIndexOf("{"); index >= 0 && attempts < 256; index = trimmed.lastIndexOf("{", index - 1)) {
    attempts += 1;
    const parsed = parseJsonObject(trimmed.slice(index));
    if (parsed) return parsed;
  }
  return null;
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

function sanitizeScan(parsed: Record<string, unknown> | null): ChatGptHostCatalogRefreshResult["scan"] | undefined {
  if (!parsed) return undefined;
  return {
    scanned: safeBoolean(parsed.scanned),
    installed: safeBoolean(parsed.installed),
    toolCount: safeCount(parsed.toolCount),
    enabledToolCount: safeCount(parsed.enabledToolCount),
    hostToolCount: safeCount(parsed.hostToolCount),
    hostMcpToolsListVerified: safeBoolean(parsed.hostMcpToolsListVerified),
    hostCatalogNamespaceMatched: safeBoolean(parsed.hostCatalogNamespaceMatched),
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
): Promise<ChatGptHostCatalogFixedCommandResult> {
  return new Promise((resolve) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let hardKillTimer: NodeJS.Timeout | undefined;
    const env: NodeJS.ProcessEnv = {
      HOME: os.homedir(),
      PATH: `${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    };

    // execution-capability: chatgpt-host-catalog-refresh
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
    });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      const stdoutText = stdout.toString("utf8");
      const stderrText = stderr.toString("utf8");
      resolve({
        exitCode,
        timedOut,
        stdout: stdoutText,
        stderr: stderrText,
        parsed: parseLastJsonObject(`${stdoutText}\n${stderrText}`),
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
    }, COMMAND_TIMEOUT_MS);
  });
}

async function refreshChatGptHostCatalogOnce(
  dependencies: ChatGptHostCatalogRefreshDependencies = {},
): Promise<ChatGptHostCatalogRefreshResult> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      status: "unavailable",
      catalogRefreshRequested: false,
      hostScanCompleted: false,
      hostCatalogRebindVerified: null,
      errorCode: "PLATFORM_UNSUPPORTED",
      message: "ChatGPT host catalog refresh is available on macOS only.",
      recommendedAction: "inspect-chatgpt-send-failure",
      runtimeRestarted: false,
      connectorChanged: false,
      projectFilesChanged: false,
    };
  }

  const resolveExecutable = dependencies.resolveExecutable ?? resolveChatGptSendPath;
  const runFixed = dependencies.runFixed ?? runFixedChatGptSend;
  const chatgptSendPath = await resolveExecutable();
  if (!chatgptSendPath) {
    return {
      ok: false,
      status: "unavailable",
      catalogRefreshRequested: false,
      hostScanCompleted: false,
      hostCatalogRebindVerified: null,
      errorCode: "CHATGPT_SEND_NOT_FOUND",
      message: "chatgpt-send was not found in the fixed install locations.",
      recommendedAction: "install-chatgpt-send",
      runtimeRestarted: false,
      connectorChanged: false,
      projectFilesChanged: false,
    };
  }

  const refresh = await runFixed(chatgptSendPath, "catalog-refresh");
  const refreshErrorCode = safeText(refresh.parsed?.errorCode, 80);
  const refreshMessage = safeText(refresh.parsed?.message) ?? (refresh.timedOut ? "Catalog refresh timed out." : undefined);
  const refreshSucceeded = !refresh.timedOut && refresh.exitCode === 0 && refresh.parsed?.ok !== false;

  if (!refreshSucceeded) {
    const manual = looksLikeAccessibilityFailure(refreshErrorCode, refreshMessage);
    return {
      ok: false,
      status: manual ? "manual-action-required" : "failed",
      catalogRefreshRequested: false,
      hostScanCompleted: false,
      hostCatalogRebindVerified: null,
      errorCode: refreshErrorCode ?? (refresh.timedOut ? "CATALOG_REFRESH_TIMEOUT" : "CATALOG_REFRESH_FAILED"),
      message: refreshMessage,
      recommendedAction: "use-settings-force-refresh",
      runtimeRestarted: false,
      connectorChanged: false,
      projectFilesChanged: false,
    };
  }

  const scan = await runFixed(chatgptSendPath, "scan-tools");
  const scanCompleted = !scan.timedOut && scan.exitCode === 0 && scan.parsed?.scanned === true;
  const scanErrorCode = safeText(scan.parsed?.errorCode, 80);
  const scanMessage = safeText(scan.parsed?.message) ?? (scan.timedOut ? "Tool scan timed out." : undefined);
  if (!scanCompleted) {
    return {
      ok: false,
      status: "manual-action-required",
      catalogRefreshRequested: true,
      hostScanCompleted: false,
      hostCatalogRebindVerified: null,
      errorCode: scanErrorCode ?? (scan.timedOut ? "SCAN_TOOLS_TIMEOUT" : "SCAN_TOOLS_FAILED"),
      message: scanMessage,
      scan: sanitizeScan(scan.parsed),
      recommendedAction: "use-settings-force-refresh",
      runtimeRestarted: false,
      connectorChanged: false,
      projectFilesChanged: false,
    };
  }

  return {
    ok: true,
    status: "refresh-requested",
    catalogRefreshRequested: true,
    hostScanCompleted: true,
    hostCatalogRebindVerified: null,
    scan: sanitizeScan(scan.parsed),
    recommendedAction: "requery-current-chat",
    runtimeRestarted: false,
    connectorChanged: false,
    projectFilesChanged: false,
  };
}
let hostCatalogRefreshInFlight: Promise<ChatGptHostCatalogRefreshResult> | null = null;

export async function refreshChatGptHostCatalog(
  dependencies: Parameters<typeof refreshChatGptHostCatalogOnce>[0] = {},
): Promise<ChatGptHostCatalogRefreshResult> {
  if (hostCatalogRefreshInFlight) return hostCatalogRefreshInFlight;

  const flight = refreshChatGptHostCatalogOnce(dependencies);
  hostCatalogRefreshInFlight = flight;
  try {
    return await flight;
  } finally {
    if (hostCatalogRefreshInFlight === flight) hostCatalogRefreshInFlight = null;
  }
}
