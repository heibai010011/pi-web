/** Consume partial-success IDs even on error responses. Older servers only
 * returned {ok:true}, so retain that one-ID compatibility fallback. */
export async function readDeletedSessionIds(response: Response, requestedId: string): Promise<string[]> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "deletedIds" in body && Array.isArray(body.deletedIds)) {
    return [...new Set(body.deletedIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  }
  return response.ok ? [requestedId] : [];
}
