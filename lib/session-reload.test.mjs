import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { mergeTailSnapshot, tailAnchorIndex } = await jiti.import("./session-reload.ts");

// entryIds e0..e(n-1) with parallel messages m0..m(n-1).
function window(ids, { oldestEntryId = null, hasMore = false } = {}) {
  return {
    entryIds: ids,
    messages: ids.map((id) => ({ role: "user", content: `msg ${id}` })),
    oldestEntryId: oldestEntryId ?? ids[0] ?? null,
    hasMore,
  };
}

test("suffix merge keeps earlier pages and splices on the fresh tail", () => {
  // User paged back: loaded e0..e19 with the cursor at e0 (paged to the start).
  const ids = Array.from({ length: 20 }, (_, i) => `e${i}`);
  const prevEntryIds = ids;
  const prevMessages = ids.map((id) => ({ role: "user", content: `msg ${id}` }));
  // Background reload returns the most-recent tail e12..e21 (turn 20 arrived).
  const incoming = window(["e12", "e13", "e14", "e15", "e16", "e17", "e18", "e19", "e20", "e21"], { hasMore: true });

  const merged = mergeTailSnapshot(prevEntryIds, prevMessages, "e0", false, incoming);

  assert.deepEqual(merged.entryIds, [...ids.slice(0, 12), ...incoming.entryIds]);
  assert.deepEqual(
    merged.messages.map((m) => m.content),
    [...ids.slice(0, 12).map((id) => `msg ${id}`), ...incoming.messages.map((m) => m.content)],
  );
  // The older cursor survives; hasMore unions instead of resetting to the tail.
  assert.equal(merged.oldestEntryId, "e0");
  assert.equal(merged.hasMore, true);
});

test("hasMore unions when the fresh tail reports none but older pages stay loaded", () => {
  const prevEntryIds = ["e0", "e1", "e2", "e3"];
  const prevMessages = prevEntryIds.map((id) => ({ role: "user", content: `msg ${id}` }));
  const incoming = window(["e2", "e3"], { hasMore: false });

  const merged = mergeTailSnapshot(prevEntryIds, prevMessages, "e0", true, incoming);

  assert.equal(merged.hasMore, true);
  assert.equal(merged.oldestEntryId, "e0");
});

test("unknown anchor replaces the window verbatim (branch switch / compaction rewrite)", () => {
  const prevEntryIds = ["e0", "e1", "e2"];
  const prevMessages = prevEntryIds.map((id) => ({ role: "user", content: `msg ${id}` }));
  const incoming = window(["b1", "b2"], { hasMore: false });

  const merged = mergeTailSnapshot(prevEntryIds, prevMessages, "e0", true, incoming);

  assert.equal(merged, incoming);
});

test("incoming window starting exactly at the oldest loaded entry replaces it", () => {
  const prevEntryIds = ["e0", "e1", "e2"];
  const prevMessages = prevEntryIds.map((id) => ({ role: "user", content: `msg ${id}` }));
  const incoming = window(["e0", "e1", "e2", "e3"], { hasMore: false });

  const merged = mergeTailSnapshot(prevEntryIds, prevMessages, "e0", false, incoming);

  assert.equal(merged, incoming);
});

test("empty previous window takes the incoming snapshot as-is", () => {
  const incoming = window(["e0", "e1"], { hasMore: false });

  const merged = mergeTailSnapshot([], [], null, false, incoming);

  assert.equal(merged, incoming);
});

test("null incoming oldestEntryId (whole history fits one window) replaces", () => {
  const prevEntryIds = ["e0", "e1"];
  const prevMessages = prevEntryIds.map((id) => ({ role: "user", content: `msg ${id}` }));
  const incoming = {
    messages: [{ role: "user", content: "all" }],
    entryIds: ["e0"],
    oldestEntryId: null,
    hasMore: false,
  };

  assert.equal(mergeTailSnapshot(prevEntryIds, prevMessages, "e0", true, incoming), incoming);
  assert.equal(tailAnchorIndex(prevEntryIds, null), -1);
});

test("an ordinary tail refresh without pagination replaces without duplicating", () => {
  // No pagination: prev is just the last tail window e10..e19; the reload
  // returns e10..e21 (turn 20 and 21 appended server-side).
  const prevEntryIds = Array.from({ length: 10 }, (_, i) => `e${i + 10}`);
  const prevMessages = prevEntryIds.map((id) => ({ role: "user", content: `msg ${id}` }));
  const incoming = window(Array.from({ length: 12 }, (_, i) => `e${i + 10}`), { hasMore: true });

  const merged = mergeTailSnapshot(prevEntryIds, prevMessages, "e10", true, incoming);

  assert.equal(merged, incoming);
  assert.deepEqual(merged.entryIds, incoming.entryIds);
});

test("tailAnchorIndex reports 0, -1 and interior positions", () => {
  const ids = ["e0", "e1", "e2", "e3"];
  assert.equal(tailAnchorIndex(ids, "e0"), 0);
  assert.equal(tailAnchorIndex(ids, "e3"), 3);
  assert.equal(tailAnchorIndex(ids, "zz"), -1);
  assert.equal(tailAnchorIndex([], "e0"), -1);
});

test("merge preserves alignment between entryIds and messages", () => {
  const prevEntryIds = ["e0", "e1", "e2", "e3", "e4"];
  const prevMessages = prevEntryIds.map((id) => ({ role: "user", content: `msg ${id}` }));
  const incoming = window(["e3", "e4", "e5"], { hasMore: true });

  const merged = mergeTailSnapshot(prevEntryIds, prevMessages, "e0", false, incoming);

  assert.equal(merged.entryIds.length, merged.messages.length);
  merged.entryIds.forEach((id, i) => {
    assert.equal(merged.messages[i].content, `msg ${id}`);
  });
});
