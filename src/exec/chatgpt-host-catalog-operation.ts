import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";
import {
  refreshChatGptHostCatalog,
  type ChatGptHostCatalogProgress,
  type ChatGptHostCatalogProgressListener,
  type ChatGptHostCatalogRefreshResult,
} from "./chatgpt-host-catalog-refresh.js";

const OPERATION_ID = /^hcr_[0-9a-f-]{36}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const instanceId = randomUUID();
const ResultSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["refresh-requested", "manual-action-required", "unavailable", "failed"]),
  catalogRefreshRequested: z.boolean(),
  hostScanCompleted: z.boolean(),
  errorCode: z.string().max(80).optional(),
  message: z.string().max(500).optional(),
  failureStage: z.enum(["resolveExecutable", "catalogRefresh", "scanTools"]).optional(),
  failureExitCode: z.number().int().nullable().optional(),
  failureTimedOut: z.boolean().optional(),
  scan: z.object({
    scanned: z.boolean().optional(), installed: z.boolean().optional(),
    toolCount: z.number().int().nonnegative().optional(), enabledToolCount: z.number().int().nonnegative().optional(),
    hostToolCount: z.number().int().nonnegative().optional(), hostMcpToolsListVerified: z.boolean().optional(),
    hostCatalogNamespaceMatched: z.boolean().optional(),
    currentChatRebindProbeTool: z.string().regex(/^chatgpt_catalog_refresh_marker_[a-f0-9]{12}$/u).optional(),
    currentChatRebindProbeRequired: z.boolean().optional(),
    hostCatalogGenerationMatched: z.boolean().optional(),
  }).optional(),
  stageDurationsMs: z.object({
    resolveExecutable: z.number().nonnegative().optional(),
    catalogRefresh: z.number().nonnegative().optional(),
    scanTools: z.number().nonnegative().optional(),
  }).optional(),
  stageResults: z.object({
    catalogRefresh: z.object({
      exitCode: z.number().int().nullable(), timedOut: z.boolean(), timeoutMs: z.number().int().positive(),
    }).optional(),
    scanTools: z.object({
      exitCode: z.number().int().nullable(), timedOut: z.boolean(), timeoutMs: z.number().int().positive(),
    }).optional(),
  }).optional(),
  recommendedAction: z.enum(["requery-current-chat", "use-settings-force-refresh", "install-chatgpt-send", "inspect-chatgpt-send-failure"]),
  runtimeRestarted: z.literal(false), connectorChanged: z.literal(false), projectFilesChanged: z.literal(false),
});
const ProgressSchema = z.object({
  schemaVersion: z.literal(1),
  phase: z.enum(["catalog-refresh", "scan-tools"]),
  state: z.enum(["running", "completed", "failed"]),
  verified: z.boolean().optional(),
  updatedAt: z.number().nonnegative(),
});
const ReceiptSchema = z.object({
  schemaVersion: z.literal(1), operationId: z.string().regex(OPERATION_ID),
  ownerDigest: z.string().regex(/^[a-f0-9]{64}$/u), requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  runtimeInstanceId: z.string().uuid(),
  state: z.enum(["queued", "running", "completed", "failed"]),
  createdAt: z.number().nonnegative(), updatedAt: z.number().nonnegative(),
  progress: ProgressSchema.optional(),
  result: ResultSchema.optional(),
});
type Receipt = z.infer<typeof ReceiptSchema>;

export type CatalogRefreshOperationSnapshot = {
  operationId: string;
  state: Receipt["state"] | "interrupted";
  createdAt: number;
  updatedAt: number;
  result?: ChatGptHostCatalogRefreshResult;
  automaticRetrySafe: false;
  recoveryMode: "status-only";
  progress?: z.infer<typeof ProgressSchema>;
  pipelineTerminal: boolean;
  failureAssessmentAllowed: boolean;
  pollAfterMs?: number;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A receipt is persisted before any fixed action can start. No startup replay. */
export class ChatGptCatalogRefreshOperations {
  private readonly directory: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly workers = new Map<string, Promise<void>>();

  constructor(
    stateDir: string,
    private readonly refresh: (onProgress?: ChatGptHostCatalogProgressListener) => Promise<ChatGptHostCatalogRefreshResult>
      = (onProgress) => refreshChatGptHostCatalog({}, onProgress),
  ) {
    this.directory = path.join(stateDir, "chatgpt-catalog-refresh");
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await run(); } finally { release(); }
  }

  private file(operationId: string): string {
    if (!OPERATION_ID.test(operationId)) throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid catalog refresh operation identifier");
    return path.join(this.directory, `${operationId}.json`);
  }

  private async read(operationId: string): Promise<Receipt | null> {
    try {
      return ReceiptSchema.parse(JSON.parse(await fs.readFile(this.file(operationId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async write(receipt: Receipt, exclusive = false): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.file(receipt.operationId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
      if (exclusive) await fs.link(temporary, destination);
      else await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }

  private snapshot(receipt: Receipt): CatalogRefreshOperationSnapshot {
    const active = receipt.state === "queued" || receipt.state === "running";
    const interrupted = active && (receipt.runtimeInstanceId !== instanceId || !this.workers.has(receipt.operationId));
    const pipelineTerminal = receipt.state === "completed" || receipt.state === "failed";
    return {
      operationId: receipt.operationId, state: interrupted ? "interrupted" : receipt.state,
      createdAt: receipt.createdAt, updatedAt: receipt.updatedAt,
      ...(receipt.progress ? { progress: receipt.progress } : {}),
      ...(receipt.result ? { result: receipt.result } : {}),
      automaticRetrySafe: false, recoveryMode: "status-only",
      pipelineTerminal,
      failureAssessmentAllowed: pipelineTerminal,
      ...(active && !interrupted ? { pollAfterMs: 1000 } : {}),
    };
  }

  async start(input: { sessionScope: string; generation: string; requestId?: string }): Promise<CatalogRefreshOperationSnapshot> {
    if (!input.sessionScope) throw new DomainError(ErrorCode.PERMISSION_DENIED, "Catalog refresh requires a conversation scope");
    if (input.requestId !== undefined && !REQUEST_ID.test(input.requestId)) throw new DomainError(ErrorCode.INVALID_ARGUMENT, "Invalid catalog refresh request identifier");
    const ownerDigest = digest(input.sessionScope);
    // Compatibility calls with no requestId are one attempt per conversation
    // and runtime generation. A fresh confirmed attempt needs a new requestId.
    const requestDigest = digest(JSON.stringify([ownerDigest, input.requestId ?? ["generation", input.generation]]));
    // Deterministic opaque identity makes exact replay lookup constant-size;
    // retained history never adds a full-directory scan to the MCP handoff.
    const operationId = "hcr_" + [requestDigest.slice(0, 8), requestDigest.slice(8, 12), requestDigest.slice(12, 16), requestDigest.slice(16, 20), requestDigest.slice(20, 32)].join("-");
    return this.withLock(async () => {
      const existing = await this.read(operationId);
      if (existing) {
        if (existing.ownerDigest !== ownerDigest || existing.requestDigest !== requestDigest) throw new DomainError(ErrorCode.PERMISSION_DENIED, "Catalog refresh identity mismatch");
        return this.snapshot(existing);
      }
      if (this.workers.size > 0) {
        throw new DomainError(ErrorCode.ACTIVE_OPERATION_IN_PROGRESS, "A catalog refresh is already in progress; inspect its status without replaying");
      }
      const now = Date.now();
      const receipt: Receipt = {
        schemaVersion: 1, operationId, ownerDigest, requestDigest,
        runtimeInstanceId: instanceId, state: "queued", createdAt: now, updatedAt: now,
      };
      try {
        // Claim the complete initial receipt atomically across processes too.
        await this.write(receipt, true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const claimed = await this.read(operationId);
        if (!claimed || claimed.ownerDigest !== ownerDigest || claimed.requestDigest !== requestDigest) throw new DomainError(ErrorCode.PERMISSION_DENIED, "Catalog refresh identity mismatch");
        return this.snapshot(claimed);
      }
      const worker = Promise.resolve().then(async () => {
        let progressWrites: Promise<void> = Promise.resolve();
        const recordProgress: ChatGptHostCatalogProgressListener = (progress: ChatGptHostCatalogProgress) => {
          progressWrites = progressWrites.then(async () => {
            const progressAt = Date.now();
            receipt.progress = { ...progress, updatedAt: progressAt };
            receipt.updatedAt = progressAt;
            await this.write(receipt);
          }).catch(() => undefined);
        };
        try {
          receipt.state = "running";
          receipt.updatedAt = Date.now();
          receipt.progress = {
            schemaVersion: 1,
            phase: "catalog-refresh",
            state: "running",
            updatedAt: receipt.updatedAt,
          };
          await this.write(receipt);
          const result = ResultSchema.parse(await this.refresh(recordProgress));
          await progressWrites;
          if (result.message) result.message = redact(result.message);
          receipt.result = result;
          receipt.state = result.ok ? "completed" : "failed";
          const terminalAt = Date.now();
          receipt.progress = {
            schemaVersion: 1,
            phase: result.failureStage === "scanTools" || result.hostScanCompleted ? "scan-tools" : "catalog-refresh",
            state: result.ok ? "completed" : "failed",
            verified: result.ok && result.hostScanCompleted,
            updatedAt: terminalAt,
          };
        } catch {
          await progressWrites.catch(() => undefined);
          receipt.state = "failed";
          const terminalAt = Date.now();
          receipt.progress = {
            schemaVersion: 1,
            phase: receipt.progress?.phase ?? "catalog-refresh",
            state: "failed",
            verified: false,
            updatedAt: terminalAt,
          };
          receipt.result = {
            ok: false, status: "failed", catalogRefreshRequested: false, hostScanCompleted: false,
            errorCode: "CATALOG_REFRESH_OUTCOME_UNKNOWN",
            recommendedAction: "inspect-chatgpt-send-failure", runtimeRestarted: false,
            connectorChanged: false, projectFilesChanged: false,
          };
        }
        receipt.updatedAt = Date.now();
        await this.write(receipt);
      }).catch(() => undefined).finally(() => { this.workers.delete(receipt.operationId); });
      this.workers.set(receipt.operationId, worker);
      return this.snapshot(receipt);
    });
  }

  async status(input: { sessionScope: string; operationId: string }): Promise<CatalogRefreshOperationSnapshot | null> {
    if (!input.sessionScope) throw new DomainError(ErrorCode.PERMISSION_DENIED, "Catalog status requires a conversation scope");
    const receipt = await this.read(input.operationId);
    // Foreign and absent receipts are indistinguishable to this caller.
    return receipt && receipt.ownerDigest === digest(input.sessionScope) ? this.snapshot(receipt) : null;
  }

  async settle(): Promise<void> { await Promise.all([...this.workers.values()]); }
}

const managers = new Map<string, ChatGptCatalogRefreshOperations>();
export function chatGptCatalogRefreshOperations(stateDir: string): ChatGptCatalogRefreshOperations {
  const key = path.resolve(stateDir);
  let manager = managers.get(key);
  if (!manager) { manager = new ChatGptCatalogRefreshOperations(key); managers.set(key, manager); }
  return manager;
}
