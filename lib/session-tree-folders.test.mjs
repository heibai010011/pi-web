import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildSessionTree } = await jiti.import("./session-tree.ts");
const { FOLDER_UNGROUPED } = await jiti.import("./session-ui-state-shared.ts");

const BASE = Date.parse("2026-10-01T00:00:00.000Z");
const project = "/work/alpha";

function iso(ms) {
  return new Date(ms).toISOString();
}

function session(id, { cwd = project, modified = BASE, ...rest } = {}) {
  return {
    path: `${cwd}/${id}.jsonl`,
    id,
    cwd,
    projectRoot: project,
    projectKey: project,
    created: iso(modified),
    modified: iso(modified),
    messageCount: 1,
    firstMessage: id,
    ...rest,
  };
}

function uiState({ folders = [], assignments = {}, sessions = {} } = {}) {
  return {
    version: 1,
    revision: 0,
    sessions,
    projects: {},
    ...(folders.length > 0 ? { folders } : {}),
    ...(Object.keys(assignments).length > 0 ? { folderAssignments: assignments } : {}),
  };
}

function build({ sessions, folders = [], assignments = {}, collapsed, pinned = {} }) {
  const sessionState = Object.fromEntries(Object.entries(pinned).map(([id, pinnedAt]) => [id, { pinnedAt }]));
  return buildSessionTree({
    sessions,
    uiState: uiState({ folders, assignments, sessions: sessionState }),
    runningIds: new Set(),
    unreadIds: new Set(),
    selectedSessionId: null,
    currentProject: { key: project, root: project },
    groupExpansion: { [project]: true },
    moreShown: {},
    pinnedCollapsed: false,
    ...(collapsed ? { folderCollapsed: new Set(collapsed) } : {}),
  });
}

function describe(rows) {
  return rows.map((row) => {
    switch (row.kind) {
      case "group": return `group:${row.project.name}`;
      case "pinned-header": return `pinned:${row.count}`;
      case "folder": return `folder:${row.folder.name}:${row.count}:d${row.depth}${row.collapsed ? ":collapsed" : ""}`;
      case "session": return `session:${row.family.root.id}:d${row.depth ?? 0}`;
      case "spacer": return "-";
      case "footer-open": return "footer";
      case "footer-archived": return `archived:${row.count}`;
      case "group-empty": return "empty";
      default: return row.kind;
    }
  });
}

const folders = [
  { id: "f1", name: "Bugs", projectKey: project },
  { id: "f2", name: "Sub", projectKey: project, parentId: "f1" },
];

test("folders render inside their project group, filed sessions under them, loose sessions after", () => {
  const sessions = [
    session("a", { modified: BASE + 3000 }),
    session("b", { modified: BASE + 2000 }),
    session("c", { modified: BASE + 1000 }),
  ];
  const model = build({ sessions, folders, assignments: { a: "f1", b: "f2" } });
  assert.deepEqual(describe(model.rows), [
    "-",
    "group:alpha",
    "folder:Bugs:2:d0",
    "session:a:d1",
    "folder:Sub:1:d1",
    "session:b:d2",
    "session:c:d0",
    "-",
    "footer",
  ]);
});

test("a folded folder keeps its row and its count, and hides its sessions and subfolders", () => {
  const sessions = [
    session("a", { modified: BASE + 3000 }),
    session("b", { modified: BASE + 2000 }),
    session("c", { modified: BASE + 1000 }),
  ];
  const model = build({ sessions, folders, assignments: { a: "f1", b: "f2" }, collapsed: ["f1"] });
  assert.deepEqual(describe(model.rows), [
    "-",
    "group:alpha",
    "folder:Bugs:2:d0:collapsed",
    "session:c:d0",
    "-",
    "footer",
  ]);
});

test("an auto-classify rule takes families with no assignment, first folder in creation order", () => {
  const sessions = [
    session("a", { cwd: "/work/alpha/src" }),
    session("b", { cwd: "/work/alpha/test" }),
  ];
  const ruleFolders = [
    { id: "f1", name: "Work", projectKey: project, autoPattern: "WORK/ALPHA" },
    { id: "f2", name: "Tests", projectKey: project, autoPattern: "test" },
  ];
  const model = build({ sessions, folders: ruleFolders });
  const filed = model.rows.filter((row) => row.kind === "session").map((row) => [row.family.root.id, row.depth]);
  // Both cwds match the first rule, so the second folder stays empty.
  assert.deepEqual(filed, [["a", 1], ["b", 1]]);
  const counts = model.rows.filter((row) => row.kind === "folder").map((row) => [row.folder.name, row.count]);
  assert.deepEqual(counts, [["Work", 2], ["Tests", 0]]);

  // An explicit assignment beats every rule.
  const explicit = build({ sessions, folders: ruleFolders, assignments: { b: "f2" } });
  const explicitFolders = explicit.rows.filter((row) => row.kind === "folder").map((row) => [row.folder.name, row.count]);
  assert.deepEqual(explicitFolders, [["Work", 1], ["Tests", 1]]);
});

test("a child inherits its parent's folder, and an explicit Ungrouped breaks the inheritance", () => {
  const sessions = [
    session("p", { modified: BASE + 3000 }),
    session("f", { modified: BASE + 2000, parentSessionId: "p" }),
    session("u", { modified: BASE + 1000, parentSessionId: "p" }),
  ];
  const model = build({
    sessions,
    folders: [folders[0]],
    assignments: { p: "f1", u: FOLDER_UNGROUPED },
  });
  assert.deepEqual(describe(model.rows), [
    "-",
    "group:alpha",
    "folder:Bugs:2:d0",
    "session:p:d1",
    "session:f:d1",
    "session:u:d0",
    "-",
    "footer",
  ]);
});

test("a pinned family stays in the pinned section, not in its folder", () => {
  const sessions = [session("a", { modified: BASE + 1000 })];
  const model = build({ sessions, folders: [folders[0]], assignments: { a: "f1" }, pinned: { a: BASE } });
  assert.deepEqual(describe(model.rows), [
    "-",
    "pinned:1",
    "session:a:d0",
    "-",
    "group:alpha",
    "folder:Bugs:0:d0",
    "-",
    "footer",
  ]);
});

test("folders of another project never show in this group", () => {
  const sessions = [session("a")];
  const model = build({
    sessions,
    folders: [{ id: "other", name: "Elsewhere", projectKey: "/work/other" }],
    assignments: { a: "other" },
  });
  assert.deepEqual(describe(model.rows), ["-", "group:alpha", "session:a:d0", "-", "footer"]);
});

test("Windows project keys match their folders case-insensitively", () => {
  const key = "C:\\Work\\Alpha";
  const sessions = [session("a", { cwd: key, projectRoot: key, projectKey: key })];
  const model = buildSessionTree({
    sessions,
    uiState: {
      version: 1,
      revision: 0,
      sessions: {},
      projects: {},
      folders: [{ id: "f1", name: "Bugs", projectKey: "c:\\work\\alpha" }],
      folderAssignments: { a: "f1" },
    },
    runningIds: new Set(),
    unreadIds: new Set(),
    selectedSessionId: null,
    currentProject: { key, root: key },
    groupExpansion: { [key]: true },
    moreShown: {},
    pinnedCollapsed: false,
  });
  assert.deepEqual(model.rows.filter((row) => row.kind === "folder").map((row) => [row.folder.name, row.count]), [["Bugs", 1]]);
});

