// Static + behavior coverage for the context pagination API (the #555 transfer fix):
// ?tail bounds the returned chain, ?before rewinds the walk and excludes its own
// boundary so prepending the page never duplicates it. Data behavior is covered
// end-to-end in lib/session-reader.pagination.test.mjs; here we assert the route wires
// the params through to buildSessionContext (excludeLeaf on ?before).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const routeSrc = await readFileSync(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { buildSessionContext } = await jiti.import("@/lib/session-reader");

test("context route parses ?tail and ?before, excluding the boundary on paging", () => {
  assert.match(routeSrc, /const tail = Number\.isFinite\(rawTail\) && rawTail > 0 \? Math\.min\(rawTail, 1000\) : 50/);
  assert.match(routeSrc, /const before = url\.searchParams\.get\("before"\)/);
  assert.match(routeSrc, /buildSessionContext\(sm\.getEntries\(\) as never, before \?\? activeLeafId, \{[^}]*excludeLeaf: Boolean\(before\)/);
});

test("context route: ?before pages upward without duplicating the boundary", () => {
  const entries = [];
  for (let i = 0; i < 100; i++) {
    entries.push({ id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`, type: "message", timestamp: new Date(1000 + i * 1000).toISOString(), message: { role: "user", content: `m${i}` } });
  }
  const page1 = buildSessionContext(entries, "e99", { tail: 5 }).entryIds;
  assert.deepEqual(page1, ["e95", "e96", "e97", "e98", "e99"]);
  const oldest = page1[0]; // e95
  const page2 = buildSessionContext(entries, oldest, { tail: 5, excludeLeaf: true }).entryIds;
  assert.equal(page2[page2.length - 1], "e94");
  assert.ok(!page2.includes(oldest), "boundary `before` must not be duplicated");
  assert.ok(page1.every((id) => !page2.includes(id)), "adjacent pages share no entry");
});

for (const live of [true, false]) test(`context route uses actual active leaf, including empty root (live=${live})`, async () => {
  const entries = [
    { id: "first", parentId: null, type: "message", message: { role: "user", content: "first" } },
    { id: "answer", parentId: "first", type: "message", message: { role: "assistant", content: [] } },
    { id: "edited", parentId: "answer", type: "message", message: { role: "user", content: "edited" } },
  ];
  let activeLeaf = "answer";
  const sm = { getEntries: () => entries, getLeafId: () => activeLeaf };
  const ast = ts.createSourceFile("route.ts", routeSrc, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "GET");
  const context = createContext({
    URL, Number, Boolean, String, buildSessionContext,
    NextResponse: { json: body => body },
    getRpcSession: () => live ? { isAlive: () => true, inner: { sessionManager: sm } } : null,
    resolveSessionPath: async () => "fixture", SessionManager: { open: () => sm },
  });
  const handler = new Script(ts.transpileModule(fn.getText(ast).replace("export ", "") + "\nGET;", {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText).runInContext(context);
  const get = query => handler({ url: `http://fixture/context${query}` }, { params: Promise.resolve({ id: "fixture" }) });
  assert.deepEqual((await get("")).context.entryIds, ["first", "answer"]);
  activeLeaf = null;
  const empty = await get("");
  assert.deepEqual(empty.context.messages, []);
  assert.equal(empty.leafId, null);
  assert.deepEqual((await get("?leafId=edited")).context.entryIds, ["first", "answer", "edited"]);
  assert.deepEqual((await get("?leafId=edited&before=answer")).context.entryIds, ["first"]);
});

test("context route data reports when pagination reaches the root", () => {
  const entries = [
    { id: "e0", parentId: null, type: "message", timestamp: new Date(1000).toISOString(), message: { role: "user", content: "root" } },
  ];
  const page = buildSessionContext(entries, "e0", { tail: 50, excludeLeaf: true });
  assert.deepEqual(page.entryIds, []);
  assert.equal(page.hasMore, false);
});
