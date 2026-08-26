import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_LABEL = 120;
const MAX_SUMMARY = 2_000;
const MAX_PROMPT = 24_000;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_FILES = 100;
const MAX_TESTS = 100;
const MAX_REF = 240;
const SAFE_ID = /^[A-Za-z0-9._:/-]+$/u;
const SAFE_LABEL = /^[^\u0000-\u001f\u007f]+$/u;
const RESULT_STATUSES = ["completed", "blocked", "failed"] as const;
const STATES = ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED", "UNKNOWN"] as const;

export type LunaWorkerState = (typeof STATES)[number];
export type LunaResultStatus = (typeof RESULT_STATUSES)[number];

export interface LunaTestSummary { name: string; status: "passed" | "failed" | "skipped" | "unknown"; }
export interface LunaResult {
  status: LunaResultStatus;
  summary: string;
  changedFiles: string[];
  tests: LunaTestSummary[];
  blocker: string | null;
  nextRecommendation: string | null;
}
export interface LunaOperationReceipt {
  operationId: string;
  state: LunaWorkerState;
  safeLabel: string;
  promptSha256: string;
  requestDigest: string;
  projectRootDigest: string;
  runtimePid: number;
  subprocessStarted: boolean;
  pid?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  resultRef?: string;
  automaticRetrySafe: false;
  resultStatus?: LunaResultStatus;
  subprocessStillRunning?: boolean;
}
export interface LunaCompactStatus extends Omit<LunaOperationReceipt, "promptSha256"> {
  promptSha256: string;
}
interface ActiveControl { process?: SpawnedLunaProcess; timer?: ReturnType<typeof setTimeout>; cancelRequested: boolean; }

export interface SpawnedLunaProcess {
  readonly pid?: number;
  readonly stdin: { write(data: string): void; end(): void };
  readonly exited: Promise<{ exitCode: number | null; signal: string | null }>;
  kill(signal?: NodeJS.Signals): void;
}
export type SpawnAdapter = (executablePath: string, argv: readonly string[], options: { cwd: string; env: Record<string, string> }) => SpawnedLunaProcess;
export interface LunaWorkerClock { now(): number; setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimeout(handle: ReturnType<typeof setTimeout>): void; }

const TestSchema = z.object({ name: z.string().min(1).max(240), status: z.enum(["passed", "failed", "skipped", "unknown"]) });
const ResultSchema = z.object({
  status: z.enum(RESULT_STATUSES), summary: z.string().min(1).max(MAX_SUMMARY),
  changedFiles: z.array(z.string().min(1).max(240)).max(MAX_FILES),
  tests: z.array(TestSchema).max(MAX_TESTS),
  blocker: z.string().max(MAX_SUMMARY).nullable(), nextRecommendation: z.string().max(MAX_SUMMARY).nullable(),
});
const ReceiptSchema = z.object({
  operationId: z.string().regex(/^luna_[A-Za-z0-9-]{16,80}$/u), state: z.enum(STATES), safeLabel: z.string().min(1).max(MAX_LABEL).regex(SAFE_LABEL), promptSha256: z.string().regex(/^[a-f0-9]{64}$/u), requestDigest: z.string().regex(/^[a-f0-9]{64}$/u), projectRootDigest: z.string().regex(/^[a-f0-9]{64}$/u), runtimePid: z.number().int().positive(),
  subprocessStarted: z.boolean(), pid: z.number().int().positive().optional(), createdAt: z.number().int().positive(), startedAt: z.number().int().positive().optional(), finishedAt: z.number().int().positive().optional(), exitCode: z.number().int().nullable().optional(), signal: z.string().max(32).nullable().optional(), resultRef: z.string().max(MAX_REF).regex(SAFE_ID).optional(), automaticRetrySafe: z.literal(false), resultStatus: z.enum(RESULT_STATUSES).optional(), subprocessStillRunning: z.boolean().optional(),
});

function invalid(message: string): DomainError { return new DomainError(ErrorCode.INVALID_ARGUMENT, message); }
function safeLabel(value: string): string { if (!value || value.length > MAX_LABEL || !SAFE_LABEL.test(value) || /(bearer\s+|(?:api|access|refresh)[_-]?token\s*[:=]|(?:secret|password|private[_-]?key)\s*[:=]|https?:\/\/)/iu.test(value)) throw invalid("Invalid Luna operation label"); return value; }
function operationPath(root: string, id: string, file: string): string { if (!/^luna_[A-Za-z0-9-]{16,80}$/u.test(id)) throw invalid("Invalid Luna operation id"); return path.join(root, "agent-operations", id, file); }
function operationDir(root: string, id: string): string { return path.dirname(operationPath(root, id, "receipt.json")); }
function canonicalRoot(value: string): Promise<string> {
  if (!path.isAbsolute(value) || value.includes("\0")) throw invalid("Project root must be absolute");
  return realpath(value).then(async (resolved) => { if (!(await stat(resolved)).isDirectory()) throw invalid("Project root must be a directory"); return resolved; }).catch(() => { throw invalid("Project root is unavailable"); });
}
function validateChangedFiles(result: LunaResult): LunaResult {
  for (const file of result.changedFiles) {
    if (path.isAbsolute(file) || file.includes("\0") || file.includes("\\") || file.split("/").includes("..") || file.startsWith("./")) throw invalid("Result contains an unsafe changed file");
  }
  return result;
}
async function readBoundedJson(file: string): Promise<unknown> {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_RESULT_BYTES) throw invalid("Luna result is unavailable or too large");
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}
function redactResult(parsed: LunaResult): LunaResult {
  return validateChangedFiles({
    ...parsed,
    summary: redact(parsed.summary),
    blocker: parsed.blocker === null ? null : redact(parsed.blocker),
    nextRecommendation: parsed.nextRecommendation === null ? null : redact(parsed.nextRecommendation),
    tests: parsed.tests.map((test) => ({ ...test, name: redact(test.name) })),
  });
}
function boundedWorkerPrompt(task: string): string {
  return [
    "You are the bounded Luna worker for one pre-authorized local milestone.",
    "Read and obey the repository AGENTS.md before acting.",
    "Stay inside the exact --cd project root and preserve unrelated dirty changes.",
    "Do not stage, commit, push, tag, release, install or restart apps, apply/reload a live runtime, change connectors/tunnels, or expose credentials.",
    "Do not broaden the task. Stop with status=blocked when a new approval or material product decision is required.",
    "Your final response must match the supplied JSON output schema and must not include raw logs, tokens, environment values, or file contents.",
    "",
    "SUPERVISOR_TASK:",
    task,
  ].join("\n");
}
function minimalEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["HOME", "CODEX_HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = source[key]; if (value !== undefined) out[key] = value;
  }
  return out;
}

export class ScheduledLunaWorker {
  private readonly executablePath: string;
  private readonly projectRoot: string;
  private readonly stateRoot: string;
  private readonly spawn: SpawnAdapter;
  private readonly clock: LunaWorkerClock;
  private readonly environment: Record<string, string | undefined>;
  private readonly runtimePid: number;
  private readonly active = new Map<string, ActiveControl>();

  constructor(input: { executablePath: string; projectRoot: string; stateRoot: string; spawn: SpawnAdapter; clock?: LunaWorkerClock; environment?: Record<string, string | undefined>; runtimePid?: number }) {
    if (!path.isAbsolute(input.executablePath) || input.executablePath.includes("\0")) throw invalid("Executable path must be absolute");
    if (!path.isAbsolute(input.stateRoot) || input.stateRoot.includes("\0")) throw invalid("stateRoot must be absolute");
    this.executablePath = input.executablePath; this.projectRoot = input.projectRoot; this.stateRoot = input.stateRoot; this.spawn = input.spawn; this.environment = input.environment ?? process.env;
    this.runtimePid = input.runtimePid ?? process.pid;
    if (!Number.isInteger(this.runtimePid) || this.runtimePid <= 0) throw invalid("Invalid Luna runtime pid");
    this.clock = input.clock ?? { now: () => Date.now(), setTimeout, clearTimeout };
  }

  private async atomicJson(file: string, value: unknown): Promise<void> {
    const dir = path.dirname(file); await mkdir(dir, { recursive: true, mode: DIR_MODE }); await chmod(dir, DIR_MODE).catch(() => undefined);
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tmp, "wx", FILE_MODE);
      const json = JSON.stringify(value, null, 2);
      await handle.writeFile(json, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tmp, file);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
  private async readReceipt(operationId: string): Promise<LunaOperationReceipt> {
    try { return ReceiptSchema.parse(JSON.parse(await readFile(operationPath(this.stateRoot, operationId, "receipt.json"), "utf8"))) as LunaOperationReceipt; }
    catch (error) { if (error instanceof DomainError) throw error; throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Luna operation receipt unavailable"); }
  }
  private async persist(receipt: LunaOperationReceipt): Promise<void> { await this.atomicJson(operationPath(this.stateRoot, receipt.operationId, "receipt.json"), ReceiptSchema.parse(receipt)); }

  private async waitForPreparedReceipt(operationId: string): Promise<LunaOperationReceipt> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { return await this.readReceipt(operationId); }
      catch (error) {
        if (!(error instanceof DomainError) || error.code !== ErrorCode.OPERATION_NOT_FOUND) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Luna operation preparation was interrupted");
  }

  async start(input: { requestId: string; prompt: string; safeLabel: string; timeoutMs: number }): Promise<{ operationId: string }> {
    if (!input.requestId || input.requestId.length > 160 || !SAFE_ID.test(input.requestId)) throw invalid("Invalid Luna request id");
    if (!input.prompt || input.prompt.length > MAX_PROMPT || input.prompt.includes("\0")) throw invalid("Invalid Luna prompt");
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 24 * 60 * 60 * 1_000) throw invalid("Invalid Luna timeout");
    const normalizedLabel = safeLabel(input.safeLabel);
    const root = await canonicalRoot(this.projectRoot); const requestDigest = createHash("sha256").update(input.requestId).digest("hex"); const projectRootDigest = createHash("sha256").update(root).digest("hex"); const operationId = `luna_${requestDigest.slice(0, 32)}`; const now = this.clock.now();
    const promptSha256 = createHash("sha256").update(input.prompt).digest("hex");
    const operationsRoot = path.join(this.stateRoot, "agent-operations");
    await mkdir(operationsRoot, { recursive: true, mode: DIR_MODE });
    await chmod(operationsRoot, DIR_MODE).catch(() => undefined);
    let preparedHere = false;
    try {
      await mkdir(operationDir(this.stateRoot, operationId), { mode: DIR_MODE });
      preparedHere = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!preparedHere) {
      const existing = await this.waitForPreparedReceipt(operationId);
      if (existing.requestDigest !== requestDigest || existing.promptSha256 !== promptSha256 || existing.projectRootDigest !== projectRootDigest || existing.safeLabel !== normalizedLabel) throw invalid("Luna request id was reused with different inputs");
      return { operationId };
    }
    const resultPath = operationPath(this.stateRoot, operationId, "result.json"); const schemaPath = operationPath(this.stateRoot, operationId, "result-schema.json");
    const receipt: LunaOperationReceipt = { operationId, state: "QUEUED", safeLabel: normalizedLabel, promptSha256, requestDigest, projectRootDigest, runtimePid: this.runtimePid, subprocessStarted: false, createdAt: now, automaticRetrySafe: false };
    await this.persist(receipt);
    await this.atomicJson(schemaPath, { type: "object", additionalProperties: false, properties: { status: { type: "string", enum: RESULT_STATUSES }, summary: { type: "string", minLength: 1, maxLength: MAX_SUMMARY }, changedFiles: { type: "array", maxItems: MAX_FILES, items: { type: "string", minLength: 1, maxLength: 240 } }, tests: { type: "array", maxItems: MAX_TESTS, items: { type: "object", additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 240 }, status: { type: "string", enum: ["passed", "failed", "skipped", "unknown"] } }, required: ["name", "status"] } }, blocker: { type: ["string", "null"], maxLength: MAX_SUMMARY }, nextRecommendation: { type: ["string", "null"], maxLength: MAX_SUMMARY } }, required: ["status", "summary", "changedFiles", "tests", "blocker", "nextRecommendation"] });
    void this.run(operationId, root, input.prompt, input.timeoutMs, receipt, resultPath, schemaPath);
    return { operationId };
  }

  private async run(operationId: string, root: string, prompt: string, timeoutMs: number, receipt: LunaOperationReceipt, resultPath: string, schemaPath: string): Promise<void> {
    const control: ActiveControl = { cancelRequested: false }; this.active.set(operationId, control);
    try {
      receipt.state = "RUNNING"; receipt.startedAt = this.clock.now(); await this.persist(receipt);
      if (control.cancelRequested) { receipt.state = "CANCELLED"; receipt.finishedAt = this.clock.now(); await this.persist(receipt); return; }
      const argv = ["exec", "--model", "gpt-5.6-luna", "--ephemeral", "--sandbox", "workspace-write", "--approve-for-me", "--cd", root, "--output-schema", schemaPath, "--output-last-message", resultPath, "--json"] as const;
      const child = this.spawn(this.executablePath, argv, { cwd: root, env: minimalEnv(this.environment) }); control.process = child; receipt.subprocessStarted = true; if (child.pid !== undefined) receipt.pid = child.pid; await this.persist(receipt);
      child.stdin.write(boundedWorkerPrompt(prompt)); child.stdin.end();
      const timeout = new Promise<never>((_, reject) => { control.timer = this.clock.setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs); });
      const exit = await Promise.race([child.exited, timeout]);
      if (control.timer) this.clock.clearTimeout(control.timer);
      if (control.cancelRequested) receipt.state = "CANCELLED";
      else if (exit.exitCode !== 0) receipt.state = "FAILED";
      else {
        const parsed = ResultSchema.parse(await readBoundedJson(resultPath)) as LunaResult;
        const result = redactResult(parsed);
        await this.atomicJson(resultPath, result); receipt.state = "COMPLETED"; receipt.resultStatus = result.status;
        receipt.resultRef = path.relative(this.stateRoot, resultPath);
      }
      receipt.exitCode = exit.exitCode; receipt.signal = exit.signal; receipt.finishedAt = this.clock.now(); await this.persist(receipt);
    } catch (error) {
      if (control.timer) this.clock.clearTimeout(control.timer);
      if (error instanceof Error && error.message === "TIMEOUT") {
        receipt.state = "TIMED_OUT"; receipt.subprocessStillRunning = true;
        try {
          control.process?.kill("SIGTERM");
          const exited = control.process?.exited;
          if (exited) {
            const result = await Promise.race([exited.then((value) => ({ value })), new Promise<null>((resolve) => setTimeout(() => resolve(null), 250))]);
            if (result) { receipt.subprocessStillRunning = false; receipt.exitCode = result.value.exitCode; receipt.signal = result.value.signal; }
            else { const process = control.process; if (process) process.kill("SIGKILL"); }
          }
        } catch { receipt.state = "UNKNOWN"; }
      }
      else if (control.cancelRequested) receipt.state = "CANCELLED";
      else receipt.state = "FAILED";
      receipt.finishedAt = this.clock.now();
      // start() intentionally detaches run(). If the runtime/state directory is
      // disappearing during teardown or replacement, the final best-effort
      // receipt write must not escape as an unhandled rejection.
      await this.persist(receipt).catch(() => undefined);
    } finally {
      if (receipt.subprocessStillRunning && control.process) void control.process.exited.finally(() => this.active.delete(operationId));
      else this.active.delete(operationId);
    }
  }

  async status(operationId: string): Promise<LunaCompactStatus> {
    const receipt = await this.readReceipt(operationId);
    if ((receipt.state === "QUEUED" || receipt.state === "RUNNING") && receipt.runtimePid !== this.runtimePid) {
      receipt.state = "UNKNOWN"; receipt.finishedAt = this.clock.now(); await this.persist(receipt);
    }
    return receipt;
  }
  async result(operationId: string): Promise<LunaResult> {
    const receipt = await this.status(operationId);
    if (receipt.state !== "COMPLETED" || !receipt.resultRef) {
      throw new DomainError(ErrorCode.OPERATION_NOT_FOUND, "Luna operation has no completed result", { operationId });
    }
    return redactResult(ResultSchema.parse(await readBoundedJson(operationPath(this.stateRoot, operationId, "result.json"))) as LunaResult);
  }
  async cancel(operationId: string): Promise<LunaCompactStatus> {
    const receipt = await this.readReceipt(operationId); const control = this.active.get(operationId);
    if (!control || ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED", "UNKNOWN"].includes(receipt.state)) return receipt;
    control.cancelRequested = true;
    try { control.process?.kill("SIGTERM"); } catch { receipt.state = "UNKNOWN"; receipt.finishedAt = this.clock.now(); await this.persist(receipt); }
    return this.readReceipt(operationId);
  }
}
