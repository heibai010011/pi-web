import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("real session creation promotes its pending folder draft before refresh", () => {
  assert.match(
    source,
    /const handleSessionCreated[\s\S]*?promoteSessionFolderDraft\(sourceDraftKey, session\.id\);[\s\S]*?setRefreshKey/,
  );
});

test("leaving an unsent composer discards pending folder intent", () => {
  assert.match(
    source,
    /const handleSelectSession[\s\S]*?discardSessionFolderDraft\(activeNewSessionDraftKeyRef\.current\);/,
  );
  assert.match(
    source,
    /const handleNewSession[\s\S]*?discardSessionFolderDraft\(activeNewSessionDraftKeyRef\.current\);/,
  );
});
