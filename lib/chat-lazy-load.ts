export const VISIBLE_PAGE_SIZE = 50;
export const CHAT_SCROLL_TAIL_TOLERANCE = 8;
export const CHAT_SCROLL_REATTACH_TOLERANCE = 96;

/**
 * Where the viewport sits while an agent reply streams in.
 * - "tail": the streaming content sticks to the bottom of the viewport.
 * - "prompt-anchor": the user's prompt is pinned to the top and the reply
 *   streams below it (legacy behavior; leaves the lower half empty until the
 *   reply grows past the viewport).
 */
export type ChatStreamAnchorMode = "tail" | "prompt-anchor";

export const CHAT_ANCHOR_MODE_STORAGE_KEY = "pi-chat-anchor-mode";
export const DEFAULT_CHAT_ANCHOR_MODE: ChatStreamAnchorMode = "tail";

export function normalizeChatAnchorMode(value: string | null | undefined): ChatStreamAnchorMode | null {
  if (value === "tail" || value === "prompt-anchor") return value;
  return null;
}

export function loadChatAnchorMode(): ChatStreamAnchorMode {
  if (typeof window === "undefined") return DEFAULT_CHAT_ANCHOR_MODE;
  try {
    return normalizeChatAnchorMode(window.localStorage.getItem(CHAT_ANCHOR_MODE_STORAGE_KEY)) ?? DEFAULT_CHAT_ANCHOR_MODE;
  } catch {
    return DEFAULT_CHAT_ANCHOR_MODE;
  }
}

export function persistChatAnchorMode(mode: ChatStreamAnchorMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_ANCHOR_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage unavailable (private mode etc.) — the choice stays per-session.
  }
}

export function getVisibleRenderWindow(totalCount: number, visibleCount: number): {
  startIndex: number;
  hasMore: boolean;
} {
  const clampedVisibleCount = Math.min(Math.max(visibleCount, 0), Math.max(totalCount, 0));
  const startIndex = Math.max(0, totalCount - clampedVisibleCount);
  return { startIndex, hasMore: startIndex > 0 };
}

export function getNextVisibleCount(currentVisibleCount: number, pageSize = VISIBLE_PAGE_SIZE): number {
  return currentVisibleCount + pageSize;
}

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}

export function isScrollAtTail(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance;
}

export function getLiveFollowAttached(
  wasAttached: boolean,
  previousScrollTop: number,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  reattachTolerance = CHAT_SCROLL_REATTACH_TOLERANCE,
): boolean {
  if (isScrollAtTail(scrollTop, clientHeight, scrollHeight)) return true;
  if (scrollTop < previousScrollTop) return false;
  if (
    !wasAttached
    && scrollTop > previousScrollTop
    && isScrollAtTail(scrollTop, clientHeight, scrollHeight, reattachTolerance)
  ) return true;
  return wasAttached;
}

export function getPromptAnchorSpacerHeight(
  targetTop: number,
  contentEnd: number,
  clientHeight: number,
): number {
  const clampedTargetTop = Math.max(0, targetTop);
  if (clampedTargetTop === 0) return 0;

  return Math.max(0, Math.ceil(
    clampedTargetTop + clientHeight - Math.max(0, contentEnd),
  ));
}
