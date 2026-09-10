import { applySessionDeletion, planSessionDeletion, type DeletionSessionInfo } from "./session-delete-lineage";
import { blockSessionDeletion, releaseSessionDeletion, serializeSessionDeletion } from "./session-deletion-state";
import { drainSessionStartsForDeletion, getRpcSessionInfos, shutdownSessionsForDeletion } from "./rpc-manager";
import { invalidateSessionListCache, invalidateSessionPathCache, listAllSessions, resolveSessionPath } from "./session-reader";

/** One coordinator owns ordering: fence -> drain startups -> snapshot -> stop
 * writers (including surviving forks) -> resnapshot -> atomic file mutation.
 * No real user data is touched by tests; dependencies accept isolated fixtures.
 */
export async function deleteSessionFamily(id: string) {
  return serializeSessionDeletion(async () => {
    if (globalThis.__piSessionDeleted?.has(id)) return { status: 200, body: { ok: true, deletedIds: [id] } };
    const runtime = getRpcSessionInfos(true);
    const filePath = runtime.find((session) => session.id === id)?.path || await resolveSessionPath(id);
    if (!filePath && !runtime.some((session) => session.id === id)) {
      return { status: 404, body: { error: "Session not found", deletedIds: [] } };
    }
    const fenced = new Set([id]);
    let deletedIds: string[] = [];
    blockSessionDeletion(fenced);
    const snapshot = async (): Promise<DeletionSessionInfo[]> => {
      const sessions = new Map((await listAllSessions({ force: true })).map((session) => [session.id, session]));
      for (const session of getRpcSessionInfos(true)) {
        const persisted = sessions.get(session.id);
        sessions.set(session.id, persisted && !session.transient ? persisted : session);
      }
      return [...sessions.values()];
    };
    try {
      let sessions = await snapshot();
      let plan = planSessionDeletion(sessions, id, filePath ?? "");
      // New child IDs may appear while SDK construction was awaiting services.
      // Fence each discovered family before allowing another async boundary.
      while (true) {
        const affected = [...plan.deletedIds, ...plan.rewrites.map((rewrite) => rewrite.id)];
        for (const affectedId of affected) fenced.add(affectedId);
        blockSessionDeletion(fenced);
        await drainSessionStartsForDeletion(fenced);
        sessions = await snapshot();
        const next = planSessionDeletion(sessions, id, filePath ?? "");
        const unseen = [...next.deletedIds, ...next.rewrites.map((rewrite) => rewrite.id)].some((key) => !fenced.has(key));
        plan = next;
        if (!unseen) break;
      }
      // Capture empty runtime headers before shutdown removes registry entries.
      const runtimeSnapshots = sessions.filter((session) => session.runtimeContent);
      await shutdownSessionsForDeletion(fenced);
      const disk = await snapshot();
      const combined = new Map(runtimeSnapshots.map((session) => [session.id, session]));
      for (const session of disk) combined.set(session.id, session);
      plan = planSessionDeletion([...combined.values()], id, filePath ?? "");
      const result = applySessionDeletion(plan);
      deletedIds = result.deletedIds;
      for (const deletedId of deletedIds) invalidateSessionPathCache(deletedId);
      if (result.error) return { status: 500, body: { error: result.error, deletedIds, rollbackFailedIds: result.rollbackFailedIds } };
      return { status: 200, body: { ok: true, deletedIds } };
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error && error.status === 409 ? 409 : 500;
      return { status, body: { error: error instanceof Error ? error.message : String(error), deletedIds } };
    } finally {
      releaseSessionDeletion(fenced, deletedIds);
      invalidateSessionListCache();
    }
  });
}
