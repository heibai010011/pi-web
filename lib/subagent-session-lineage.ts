import { AsyncLocalStorage } from "node:async_hooks";
import { SessionManager, type NewSessionOptions } from "@earendil-works/pi-coding-agent";
import { invalidateSessionListCache } from "./session-reader";

/**
 * pi-subagents currently creates persisted child SessionManagers without
 * forwarding the active parent's session file. The missing header lineage
 * makes pi-web render those children as unrelated root sessions.
 *
 * Keep the parent path in AsyncLocalStorage around a prompt. Any persistent
 * SessionManager created by extension work spawned from that prompt inherits
 * the path automatically. AsyncLocalStorage also follows background promises
 * and timers, while ordinary new-session requests outside the prompt context
 * remain untouched.
 */

declare global {
  var __piSubagentParentSessionContext: AsyncLocalStorage<string> | undefined;
  var __piSessionManagerCreateLineagePatched: boolean | undefined;
}

const parentSessionContext = globalThis.__piSubagentParentSessionContext
  ?? new AsyncLocalStorage<string>();
globalThis.__piSubagentParentSessionContext = parentSessionContext;

const SESSION_WRITE_METHODS = [
  "appendMessage",
  "appendThinkingLevelChange",
  "appendModelChange",
  "appendCompaction",
  "appendCustomEntry",
  "appendSessionInfo",
  "appendCustomMessageEntry",
  "appendLabelChange",
] as const;

function invalidateAfterFirstChildWrite(manager: SessionManager): void {
  let pending = true;
  for (const method of SESSION_WRITE_METHODS) {
    const original = manager[method];
    if (typeof original !== "function") continue;
    (manager as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const result = (original as (...values: unknown[]) => unknown).apply(manager, args);
      if (pending) {
        pending = false;
        invalidateSessionListCache();
      }
      return result;
    };
  }
}

function installSessionManagerLineagePatch(): void {
  if (globalThis.__piSessionManagerCreateLineagePatched) return;
  const originalCreate = SessionManager.create.bind(SessionManager);
  SessionManager.create = ((
    cwd: string,
    sessionDir?: string,
    options?: NewSessionOptions,
  ) => {
    const inheritedParent = parentSessionContext.getStore();
    const manager = originalCreate(
      cwd,
      sessionDir,
      inheritedParent && !options?.parentSession
        ? { ...options, parentSession: inheritedParent }
        : options,
    );
    if (inheritedParent) {
      // Creation chooses a path but does not flush the JSONL yet. Invalidate
      // both now and after the first actual append so an intervening sidebar
      // scan cannot cache the child as absent for the full cache TTL.
      invalidateSessionListCache();
      invalidateAfterFirstChildWrite(manager);
    }
    return manager;
  }) as typeof SessionManager.create;
  globalThis.__piSessionManagerCreateLineagePatched = true;
}

installSessionManagerLineagePatch();

export function runWithSubagentParentSession<T>(
  parentSessionFile: string | null | undefined,
  operation: () => T,
): T {
  if (!parentSessionFile) return operation();
  return parentSessionContext.run(parentSessionFile, operation);
}
