import type { AgentMessage } from "./types";

/** A tail window of a session as returned by the context endpoints. */
export interface TailSnapshot {
  messages: AgentMessage[];
  entryIds: string[];
  oldestEntryId: string | null;
  hasMore: boolean;
}

/**
 * Index of the incoming window's oldest entry inside the previously loaded
 * entry ids: > 0 means older pages are loaded above the incoming tail, 0 means
 * the incoming window starts exactly at the oldest loaded entry, and -1 means
 * no overlap (fresh load, branch switch, or a compaction rewrite).
 */
export function tailAnchorIndex(prevEntryIds: string[], incomingOldestEntryId: string | null): number {
  if (incomingOldestEntryId === null) return -1;
  return prevEntryIds.indexOf(incomingOldestEntryId);
}

/**
 * Merge a freshly reloaded server tail snapshot into the window the user
 * currently sees. Reloads always refetch the most-recent `tail` entries, so a
 * plain replace would drop any earlier page the user scrolled up to load (the
 * list shrinks and the viewport jumps). When the incoming tail overlaps the
 * loaded window (its oldest entry sits at index > 0 of the previous entry
 * ids), splice it on top of the retained older pages and keep the older
 * cursor; otherwise — no overlap, or a window that starts exactly at the
 * oldest loaded entry — the incoming snapshot replaces the window verbatim.
 */
export function mergeTailSnapshot(
  prevEntryIds: string[],
  prevMessages: AgentMessage[],
  prevOldestEntryId: string | null,
  prevHasMore: boolean,
  incoming: TailSnapshot,
): TailSnapshot {
  const anchor = tailAnchorIndex(prevEntryIds, incoming.oldestEntryId);
  if (anchor <= 0) return incoming;
  return {
    messages: [...prevMessages.slice(0, anchor), ...incoming.messages],
    entryIds: [...prevEntryIds.slice(0, anchor), ...incoming.entryIds],
    // Older pages remain loaded above the anchor, so pagination keeps the
    // previous cursor and unions the hasMore flags instead of resetting.
    oldestEntryId: prevOldestEntryId,
    hasMore: prevHasMore || incoming.hasMore,
  };
}
