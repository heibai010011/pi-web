/** Process-local request correlation, not authentication or cross-process coordination. */
export class PromptCancellationError extends Error {
  constructor(message: string, public readonly status = 409) { super(message); }
}
export function parsePromptRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new PromptCancellationError("Malformed promptRequestId", 400);
  }
  return value;
}
type Entry = { timestamp: number; claimed: boolean; canceled: boolean; pinned: boolean };
export class PromptCancellationRegistry {
  private entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now, private readonly capacity = 10000,
    private readonly lifetime = 300000, private readonly futureSkew = 30000) {}
  private key(sid: string, id: string) { return JSON.stringify([sid, id]); }
  private prune() {
    for (const [key, entry] of this.entries) {
      if (!entry.pinned && this.now() - entry.timestamp > this.lifetime) this.entries.delete(key);
    }
  }
  private entry(sid: string, id: string, allowPinned = false): Entry {
    parsePromptRequestId(id);
    this.prune();
    const key = this.key(sid, id);
    const existing = this.entries.get(key);
    const timestamp = Number(id.split(":")[0]);
    if (!(allowPinned && existing?.pinned) && (this.now() - timestamp > this.lifetime || timestamp - this.now() > this.futureSkew)) {
      throw new PromptCancellationError("Expired or future promptRequestId");
    }
    if (existing) return existing;
    if (this.entries.size >= this.capacity) throw new PromptCancellationError("Prompt cancellation registry is full", 503);
    const entry = { timestamp, claimed: false, canceled: false, pinned: false };
    this.entries.set(key, entry);
    return entry;
  }
  check(sid: string, id: string) {
    const entry = this.entry(sid, id);
    if (entry.canceled) throw new PromptCancellationError("Prompt request canceled");
  }
  available(sid: string, id: string) {
    const entry = this.entry(sid, id);
    if (entry.canceled) throw new PromptCancellationError("Prompt request canceled");
    if (entry.claimed) throw new PromptCancellationError("Duplicate promptRequestId");
  }
  claim(sid: string, id: string) {
    this.available(sid, id);
    const entry = this.entry(sid, id);
    entry.claimed = true; entry.pinned = true;
  }
  cancel(sid: string, id: string) { this.entry(sid, id, true).canceled = true; }
  finish(sid: string, id: string) {
    const entry = this.entries.get(this.key(sid, id));
    if (entry) entry.pinned = false;
  }
}
const globalRegistry = globalThis as typeof globalThis & { __piPromptCancellation?: PromptCancellationRegistry };
export const promptCancellation = globalRegistry.__piPromptCancellation ??= new PromptCancellationRegistry();
