export interface BoundedOutputSummary {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

/**
 * Collect a child-process stream without retaining its complete output.
 *
 * Until the head+tail budget is crossed, chunks are retained verbatim so
 * small outputs can be returned unchanged. After that point only the first
 * `headBytes` and most recent `tailBytes` are kept.
 */
export class BoundedOutputCollector {
  private readonly limit: number;
  private totalBytes = 0;
  private fullChunks: Buffer[] = [];
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private isTruncated = false;

  constructor(
    private readonly headBytes: number,
    private readonly tailBytes: number,
  ) {
    if (!Number.isInteger(headBytes) || headBytes < 0 || !Number.isInteger(tailBytes) || tailBytes < 0) {
      throw new RangeError("headBytes and tailBytes must be non-negative integers");
    }
    this.limit = headBytes + tailBytes;
  }

  append(chunk: Buffer | Uint8Array | string): void {
    const incoming =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (incoming.length === 0) return;

    const previousTotal = this.totalBytes;
    this.totalBytes += incoming.length;

    if (!this.isTruncated && this.totalBytes <= this.limit) {
      // Copy pipe-backed slabs so the collector retains only the bytes it owns.
      this.fullChunks.push(Buffer.from(incoming));
      return;
    }

    if (!this.isTruncated) {
      this.isTruncated = true;
      const prefix = Buffer.concat([...this.fullChunks, incoming], previousTotal + incoming.length);
      this.head = Buffer.from(prefix.subarray(0, this.headBytes));
      this.tail =
        this.tailBytes === 0
          ? Buffer.alloc(0)
          : Buffer.from(prefix.subarray(Math.max(0, prefix.length - this.tailBytes)));
      this.fullChunks = [];
      return;
    }

    if (this.tailBytes === 0) return;
    if (incoming.length >= this.tailBytes) {
      this.tail = Buffer.from(incoming.subarray(incoming.length - this.tailBytes));
      return;
    }

    const combined = Buffer.concat([this.tail, incoming]);
    this.tail = Buffer.from(combined.subarray(Math.max(0, combined.length - this.tailBytes)));
  }

  summarize(): BoundedOutputSummary {
    if (!this.isTruncated) {
      return {
        text: Buffer.concat(this.fullChunks, this.totalBytes).toString("utf8"),
        truncated: false,
        totalBytes: this.totalBytes,
      };
    }

    return {
      text: `${this.head.toString("utf8")}\n...[truncated ${this.totalBytes - this.limit} bytes]...\n${this.tail.toString("utf8")}`,
      truncated: true,
      totalBytes: this.totalBytes,
    };
  }
}
