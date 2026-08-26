import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("exposes the polled running-session set to the shell", () => {
  assert.match(source, /onRunningSessionIdsChange\?: \(ids: Set<string>\) => void/);
  assert.match(source, /onRunningSessionIdsChange\?\.\(runningSessionIds\)/);
});

test("includes project activity counts in accessible labels", () => {
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{activity\.running\}\)`\}/,
  );
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{activity\.unread\}\)`\}/,
  );
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});

test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});

test("manual and lifecycle refreshes bypass the server session-list cache", () => {
  assert.match(source, /force \? "\/api\/sessions\?force=1" : "\/api\/sessions"/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /loadSessions\(isFirst, !isFirst\)/);
  assert.match(source, /onClick=\{\(\) => loadSessions\(false, true\)\}/);
  assert.match(source, /loadSessions\(false, true\);[\s\S]*?onBackgroundTaskDone/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{\(hovered \|\| folderMenuOpen\) && !session\.transient && !bulkMode && \(/);
});

test("folder and pinned groups render parent-child trees instead of flat rows", () => {
  assert.match(source, /const groupedTrees = useMemo\([\s\S]*?groupSessionTrees\(/);
  assert.match(source, /pinnedTree\.map\(\(node\) => renderSessionTree\(node, 0\)\)/);
  assert.match(source, /recent\.map\(\(n\) => renderSessionTree\(n, depth \+ 1\)\)/);
  assert.match(source, /renderOlderTrees\(`folder:\$\{folder\.id\}`, older, depth \+ 1\)/);
  assert.doesNotMatch(source, /no fork nesting inside those/);
});

test("creating a folder from a session menu moves that session into it", () => {
  assert.match(
    sessionItemSource,
    /const folderId = onCreateFolder\?\.\(folderMenuNewName\);\s*if \(folderId\) onMoveToFolder\?\.\(folderId\);/,
  );
});

test("failed rename and delete requests do not report successful mutations", () => {
  assert.match(sessionItemSource, /if \(response\.ok\) onRenamed\?\.\(\);/);
  assert.match(sessionItemSource, /if \(!response\.ok\) \{\s*setDeleting\(false\);\s*return;/);
  assert.match(source, /if \(!response\.ok\) continue;/);
});

test("every session delete path purges or hands down organization metadata", () => {
  assert.match(source, /const handleDeletedSessionOrganization[\s\S]*?removeSessionOrganizationReferences\(org, id, filteredSessions\)/);
  assert.match(source, /onSessionDeleted=\{handleDeletedSessionOrganization\}/);
});

test("successful deletion hides the row before cleaning folder organization", () => {
  assert.match(source, /const handleDeletedSessionOrganization = \(id: string\) => \{\s*hideDeletedSession\(id\);\s*onSessionDeleted\?\.\(id\);[\s\S]*?updateSessionOrg/);
  assert.match(source, /if \(!response\.ok\) continue;\s*hideDeletedSession\(id\);\s*onSessionDeleted\?\.\(id\);/);
});

test("deleted-session tombstones filter stale session-list responses", () => {
  assert.match(source, /data\.sessions\.filter\(\(session\) => !deletedSessionTombstonesRef\.current\.has\(session\.id\)\)/);
  assert.doesNotMatch(source, /deletedSessionTombstonesRef\.current\.delete/);
});

test("sidebar offers remembered Current work and All sessions views", () => {
  assert.match(source, /pi-web:session-sidebar-view/);
  assert.match(source, /t\("sidebar\.currentWork"\)/);
  assert.match(source, /t\("sidebar\.allSessions"\)/);
  assert.match(source, /const effectiveSessionView = hasSearchQuery \|\| bulkMode \? "all" : sessionView/);
});

test("current work groups complete trees while all view folds older roots per group", () => {
  assert.match(source, /const currentWorkRoots = useMemo\(\(\) => \[[\s\S]*?\.\.\.pinnedTree,[\s\S]*?folderTrees\.get\(folder\.id\)[\s\S]*?\.\.\.ungroupedTree/);
  assert.match(source, /buildCurrentWorkSections\(currentWorkRoots, focusedImportantIds\)/);
  assert.match(source, /renderOlderTrees\(`folder:\$\{folder\.id\}`, older, depth \+ 1\)/);
  assert.match(source, /renderOlderTrees\("ungrouped", ungroupedAgeSplit\.older, 0\)/);
  assert.match(source, /flatList \? \{ recent: ungroupedTree, older: \[\] \}/);
});

test("folder rows can create a draft session directly in that folder", () => {
  assert.match(source, /onNewSession=\{\(\) => handleNewSessionInFolder\(folder\.id\)\}/);
  assert.match(source, /registerSessionFolderDraft\(draftKey, selectedProject\.key, folderId, temporarySessionId\);\s*onNewSession\?\.\(temporarySessionId, selectedCwd\);/);
  assert.match(source, /title=\{t\("sidebar\.newSessionInFolder"\)\}/);
});

test("folders render as a nested tree with cycle-safe recursion", () => {
  assert.match(source, /buildFolderTree\(sessionOrg\.folders\)\.map\(\(root\) => renderFolderNode\(root, 0\)\)/);
  assert.match(source, /node\.children\.map\(\(child\) => renderFolderNode\(child, depth \+ 1\)\)/);
  assert.match(source, /onMoveTo=\{\(parentId\) => moveFolderTo\(folder\.id, parentId\)\}/);
  assert.match(source, /wouldCreateFolderCycle\(org\.folders, folderId, targetParentId\)/);
  assert.match(source, /removeFolderPromotingChildren\(org\.folders, folderId\)/);
});

test("new sessions register rule-based auto-classification before composer switch", () => {
  assert.match(
    source,
    /registerAutoSessionFolderDraft\([\s\S]*?selectedProject\.key,\s*selectedCwd,\s*temporarySessionId,\s*\);[\s\S]*?onNewSession\?\.\(temporarySessionId, selectedCwd\);/,
  );
  assert.match(source, /onSetRule=\{\(pattern\) => setFolderRule\(folder\.id, pattern\)\}/);
  assert.match(source, /t\("sidebar\.newSubfolder"\)/);
});
