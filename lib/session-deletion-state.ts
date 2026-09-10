/** Process-local admission barrier. Tombstones also reject late completion/reopen work. */
declare global {
  var __piSessionDeletionBlocked: Set<string> | undefined;
  var __piSessionDeleted: Set<string> | undefined;
  var __piSessionDeletionTail: Promise<void> | undefined;
  var __piSessionDeletionWaiters: Map<string, Array<() => void>> | undefined;
}

export class SessionDeletionConflict extends Error {
  readonly status = 409;
}

export function isSessionDeletionBlocked(id: string): boolean {
  return Boolean(globalThis.__piSessionDeletionBlocked?.has(id) || globalThis.__piSessionDeleted?.has(id));
}

export function assertSessionNotDeleting(id: string): void {
  if (isSessionDeletionBlocked(id)) throw new Error(`Session is being deleted or has been deleted: ${id}`);
}

export function blockSessionDeletion(ids: Iterable<string>): void {
  const blocked = globalThis.__piSessionDeletionBlocked ??= new Set();
  for (const id of ids) blocked.add(id);
}

export function releaseSessionDeletion(ids: Iterable<string>, deletedIds: Iterable<string> = []): void {
  const deleted = globalThis.__piSessionDeleted ??= new Set();
  for (const id of deletedIds) deleted.add(id);
  for (const id of ids) {
    globalThis.__piSessionDeletionBlocked?.delete(id);
    for (const resolve of globalThis.__piSessionDeletionWaiters?.get(id) ?? []) resolve();
    globalThis.__piSessionDeletionWaiters?.delete(id);
  }
}

/** A surviving fork may be fenced while its header is rewritten. Notifications
 * wait rather than disappearing; deleted targets are dropped after release. */
export async function waitForSessionDeletion(id: string): Promise<void> {
  while (globalThis.__piSessionDeletionBlocked?.has(id)) {
    await new Promise<void>((resolve) => {
      const waiters = globalThis.__piSessionDeletionWaiters ??= new Map();
      const list = waiters.get(id) ?? [];
      list.push(resolve); waiters.set(id, list);
    });
  }
}

/** Serialize overlapping family deletes; a rejected request must not poison the queue. */
export async function serializeSessionDeletion<T>(operation: () => Promise<T>): Promise<T> {
  const previous = globalThis.__piSessionDeletionTail ?? Promise.resolve();
  let release!: () => void;
  globalThis.__piSessionDeletionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await operation(); } finally { release(); }
}
