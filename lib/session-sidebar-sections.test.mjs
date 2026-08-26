import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildCurrentWorkSections, splitOlderSessionTrees } = await jiti.import("./session-sidebar-sections.ts");
const now = new Date(2026, 2, 15, 12);
const iso = (daysAgo, hour = 12) => {
  const d = new Date(2026, 2, 15, hour);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
};
const node = (id, daysAgo, children = []) => ({ session: { id, modified: iso(daysAgo) }, children });

function occurrences(sections, id) {
  return sections.flatMap((section) => section.trees).filter((tree) => tree.session.id === id).length;
}

test("important descendant promotes one complete tree into Active only once", () => {
  const root = node("root", 60, [node("child", 40, [node("running", 50)])]);
  const sections = buildCurrentWorkSections([root], new Set(["running"]), now);
  assert.deepEqual(sections.map((section) => section.id), ["active"]);
  assert.equal(sections[0].trees[0], root);
  assert.equal(occurrences(sections, "root"), 1);
});

test("classifies complete trees by their newest descendant using local-day buckets", () => {
  const roots = [
    node("today", 40, [node("today-child", 0)]),
    node("yesterday", 1),
    node("week", 5),
    node("month", 20),
    node("old", 31),
  ];
  const sections = buildCurrentWorkSections(roots, new Set(), now);
  assert.deepEqual(sections.map((s) => [s.id, s.trees.map((tree) => tree.session.id)]), [
    ["today", ["today"]], ["yesterday", ["yesterday"]], ["week", ["week"]], ["month", ["month"]],
  ]);
});

test("keeps an old root recent when a descendant was modified recently", () => {
  const tree = node("old-root", 100, [node("recent-child", 2)]);
  const split = splitOlderSessionTrees([tree], now);
  assert.deepEqual(split.recent, [tree]);
  assert.deepEqual(split.older, []);
});

test("trees idle beyond 7 local days fold into older by default", () => {
  const recent = node("recent", 7);
  const older = node("older", 8);
  const split = splitOlderSessionTrees([older, recent], now);
  assert.deepEqual(split.recent, [recent]);
  assert.deepEqual(split.older, [older]);
});

test("splits roots without mutating input order", () => {
  const recent = node("recent", 2);
  const older = node("older", 31);
  const input = Object.freeze([older, recent]);
  const split = splitOlderSessionTrees(input, now);
  assert.deepEqual(split.recent, [recent]);
  assert.deepEqual(split.older, [older]);
  assert.deepEqual(input, [older, recent]);
});

test("invalid timestamps degrade to older unless the tree is important", () => {
  const invalid = { session: { id: "invalid", modified: "bad" }, children: [] };
  assert.deepEqual(buildCurrentWorkSections([invalid], new Set(), now), []);
  assert.equal(buildCurrentWorkSections([invalid], new Set(["invalid"]), now)[0].id, "active");
  assert.deepEqual(splitOlderSessionTrees([invalid], now).older, [invalid]);
});
