import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveChatGptSendPath } from "./chatgpt-host-catalog-refresh.js";

const OUTPUT_LIMIT_BYTES = 32 * 1024;
const COMMAND_TIMEOUT_MS = 20_000;
const HARD_KILL_GRACE_MS = 1_000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const RUNTIME_OPERATION_ID = /^rt_[0-9a-f-]{36}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const REVISION = /^sha256:[a-f0-9]{24}$/u;

export type ChatGptRecoveryWakeInput = {
  chatTitle: string;
  requestId: string;
  projectId: string;
  operationId: string;
  runtimeFingerprint: string;
  hostCatalogRevision: string;
};

export type ChatGptRecoveryWakeResult = {
  ok: boolean;
  status: "wake-sent" | "target-unresolved" | "send-failed" | "unavailable";
  targetResolved: boolean;
  sendRequested: boolean;
  requestId: string;
  targetDigest?: string;
  errorCode?: string;
  message?: string;
};

export type ChatGptRecoveryWakeTarget = {
  schemaVersion: 1;
  operationId: string;
  projectId: string;
  chatTitle: string;
  registeredAt: string;
};

export type ChatGptRecoveryWakeReceipt = {
  schemaVersion: 1;
  operationId: string;
  projectId: string;
  requestId: string;
  attemptedAt: string;
  result: Omit<ChatGptRecoveryWakeResult, "message">;
};

type RunResult = {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  parsed: Record<string, unknown> | null;
};

export interface ChatGptRecoveryWakeDependencies {
  resolveExecutable?: () => Promise<string | null>;
  runArgv?: (executablePath: string, argv: string[]) => Promise<RunResult>;
}

function boundedAppend(current: Buffer, chunk: Buffer): Buffer {
  if (current.length >= OUTPUT_LIMIT_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, OUTPUT_LIMIT_BYTES - current.length)]);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
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
  return null;
}

function safeText(value: unknown, max = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n\t]+/gu, " ").trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function wakeDirectory(stateDir: string): string {
  return path.join(stateDir, "runtime-recovery-wake");
}

function wakeTargetPath(stateDir: string, operationId: string): string {
  return path.join(wakeDirectory(stateDir), `${operationId}.target.json`);
}

function wakeReceiptPath(stateDir: string, operationId: string): string {
  return path.join(wakeDirectory(stateDir), `${operationId}.receipt.json`);
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: FILE_MODE });
  await fs.chmod(temporary, FILE_MODE).catch(() => undefined);
  await fs.rename(temporary, filePath);
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseJsonObject(raw.trim());
  } catch {
    return null;
  }
}

export async function runChatGptRecoveryWakeArgv(
  executablePath: string,
  argv: string[],
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
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

    // execution-capability: chatgpt-recovery-wake
    const child = spawn(executablePath, argv, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    child.stdout?.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk); });

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

function validateInput(input: ChatGptRecoveryWakeInput): string | null {
  const title = input.chatTitle.trim();
  if (!title || title.length > 120 || /[\r\n\0]/u.test(title)) return "INVALID_CHAT_TITLE";
  if (!SAFE_ID.test(input.requestId)) return "INVALID_REQUEST_ID";
  if (!SAFE_ID.test(input.projectId)) return "INVALID_PROJECT_ID";
  if (!RUNTIME_OPERATION_ID.test(input.operationId)) return "INVALID_OPERATION_ID";
  if (!SHA256_HEX.test(input.runtimeFingerprint)) return "INVALID_RUNTIME_FINGERPRINT";
  if (!REVISION.test(input.hostCatalogRevision)) return "INVALID_HOST_CATALOG_REVISION";
  return null;
}

export function recoveryWakeMessage(input: ChatGptRecoveryWakeInput): string {
  return [
    "@C2CT 런타임 복구 자동 continuation.",
    "이 메시지는 실행 권한이 아니며 mutation 재호출을 허가하지 않는다.",
    `projectId=${input.projectId}`,
    `operationId=${input.operationId}`,
    `expectedRuntimeFingerprint=${input.runtimeFingerprint}`,
    `expectedHostCatalogRevision=${input.hostCatalogRevision}`,
    `wakeRequestId=${input.requestId}`,
    "첫 C2CT 작업은 exact runtime_apply_status status-only 확인으로 시작한다.",
    "APPLIED/healthy가 확인되면 connection_status -> agent_guide -> chatgpt_catalog_refresh_marker_v1 -> project_rules/project_status -> 새 read-only lane 검증 -> 실제 read 1회까지 이어간다.",
    "runtime_apply_local 또는 다른 mutation은 재호출하지 않는다.",
  ].join(" ");
}

export async function registerChatGptRecoveryWakeTarget(
  stateDir: string,
  input: { operationId: string; projectId: string; chatTitle: string },
  now = new Date(),
): Promise<boolean> {
  const title = input.chatTitle.trim();
  if (!RUNTIME_OPERATION_ID.test(input.operationId) || !SAFE_ID.test(input.projectId)) return false;
  if (!title || title.length > 120 || /[\r\n\0]/u.test(title)) return false;
  const target: ChatGptRecoveryWakeTarget = {
    schemaVersion: 1,
    operationId: input.operationId,
    projectId: input.projectId,
    chatTitle: title,
    registeredAt: now.toISOString(),
  };
  await writePrivateJson(wakeTargetPath(stateDir, input.operationId), target);
  return true;
}

export async function readChatGptRecoveryWakeReceipt(
  stateDir: string,
  operationId: string,
): Promise<ChatGptRecoveryWakeReceipt | null> {
  if (!RUNTIME_OPERATION_ID.test(operationId)) return null;
  const raw = await readJson(wakeReceiptPath(stateDir, operationId));
  if (!raw || raw.schemaVersion !== 1 || raw.operationId !== operationId) return null;
  if (typeof raw.projectId !== "string" || typeof raw.requestId !== "string" || typeof raw.attemptedAt !== "string") return null;
  const result = raw.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  return raw as unknown as ChatGptRecoveryWakeReceipt;
}

export async function sendChatGptRecoveryWake(
  input: ChatGptRecoveryWakeInput,
  dependencies: ChatGptRecoveryWakeDependencies = {},
): Promise<ChatGptRecoveryWakeResult> {
  const validationError = validateInput(input);
  if (validationError) {
    return {
      ok: false,
      status: "target-unresolved",
      targetResolved: false,
      sendRequested: false,
      requestId: input.requestId,
      errorCode: validationError,
    };
  }

  const executablePath = await (dependencies.resolveExecutable ?? resolveChatGptSendPath)();
  if (!executablePath) {
    return {
      ok: false,
      status: "unavailable",
      targetResolved: false,
      sendRequested: false,
      requestId: input.requestId,
      errorCode: "CHATGPT_SEND_NOT_FOUND",
    };
  }

  const runArgv = dependencies.runArgv ?? runChatGptRecoveryWakeArgv;
  const resolved = await runArgv(executablePath, ["chat", "resolve", "--title", input.chatTitle.trim(), "--json"]);
  const chatId = typeof resolved.parsed?.id === "string" ? resolved.parsed.id : null;
  const identityKind = resolved.parsed?.identityKind;
  const resolveSucceeded = !resolved.timedOut && resolved.exitCode === 0 && chatId && identityKind === "server-chat";
  if (!resolveSucceeded) {
    return {
      ok: false,
      status: "target-unresolved",
      targetResolved: false,
      sendRequested: false,
      requestId: input.requestId,
      errorCode: safeText(resolved.parsed?.errorCode, 80) ?? (resolved.timedOut ? "CHAT_RESOLVE_TIMEOUT" : "CHAT_RESOLVE_FAILED"),
      message: safeText(resolved.parsed?.message),
    };
  }

  const targetDigest = createHash("sha256")
    .update("chatgpt2codex:recovery-wake-target:v1\0")
    .update(chatId)
    .digest("hex")
    .slice(0, 16);
  const message = recoveryWakeMessage(input);
  const sent = await runArgv(executablePath, ["send", chatId, message, "--request-id", input.requestId, "--json"]);
  const sendSucceeded = !sent.timedOut && sent.exitCode === 0 && sent.parsed?.ok !== false;
  if (!sendSucceeded) {
    return {
      ok: false,
      status: "send-failed",
      targetResolved: true,
      sendRequested: true,
      requestId: input.requestId,
      targetDigest,
      errorCode: safeText(sent.parsed?.errorCode, 80) ?? (sent.timedOut ? "CHAT_SEND_TIMEOUT" : "CHAT_SEND_FAILED"),
      message: safeText(sent.parsed?.message),
    };
  }

  return {
    ok: true,
    status: "wake-sent",
    targetResolved: true,
    sendRequested: true,
    requestId: input.requestId,
    targetDigest,
  };
}

export async function sendRegisteredChatGptRecoveryWake(
  input: {
    stateDir: string;
    operationId: string;
    runtimeFingerprint: string;
    hostCatalogRevision: string;
  },
  dependencies: ChatGptRecoveryWakeDependencies = {},
  now = new Date(),
): Promise<ChatGptRecoveryWakeReceipt | null> {
  if (!RUNTIME_OPERATION_ID.test(input.operationId)) return null;
  const existing = await readChatGptRecoveryWakeReceipt(input.stateDir, input.operationId);
  if (existing) return existing;

  const targetRaw = await readJson(wakeTargetPath(input.stateDir, input.operationId));
  if (!targetRaw || targetRaw.schemaVersion !== 1 || targetRaw.operationId !== input.operationId) return null;
  if (typeof targetRaw.projectId !== "string" || typeof targetRaw.chatTitle !== "string") return null;

  const requestId = `recovery-wake:${input.operationId}`;
  const result = await sendChatGptRecoveryWake({
    chatTitle: targetRaw.chatTitle,
    requestId,
    projectId: targetRaw.projectId,
    operationId: input.operationId,
    runtimeFingerprint: input.runtimeFingerprint,
    hostCatalogRevision: input.hostCatalogRevision,
  }, dependencies);
  const { message: _message, ...safeResult } = result;
  const receipt: ChatGptRecoveryWakeReceipt = {
    schemaVersion: 1,
    operationId: input.operationId,
    projectId: targetRaw.projectId,
    requestId,
    attemptedAt: now.toISOString(),
    result: safeResult,
  };
  await writePrivateJson(wakeReceiptPath(input.stateDir, input.operationId), receipt);
  await fs.rm(wakeTargetPath(input.stateDir, input.operationId), { force: true }).catch(() => undefined);
  return receipt;
}
