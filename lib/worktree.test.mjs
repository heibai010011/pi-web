import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./worktree.ts");
}

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

// Needs to spawn git; skipped automatically where child processes are denied.
test("main and linked worktrees share one canonical project root", { skip: process.env.PI_WEB_TEST_NO_SPAWN === "1" }, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/test", linked]);

  const { findCurrentWorktreePath, listWorktrees, resolveProject, removeWorktree, addWorktree } = await loadSubject();
  const mainProject = await resolveProject(`${repo}${path.sep}`);
  const linkedProject = await resolveProject(linked);

  assert.equal(mainProject.isTopLevel, true);
  assert.equal(mainProject.isWorktree, false);
  assert.equal(linkedProject.isTopLevel, true);
  assert.equal(linkedProject.isWorktree, true);
  assert.equal(linkedProject.branch, "feature/test");
  assert.equal(mainProject.projectRoot, linkedProject.projectRoot);

  const worktrees = await listWorktrees(linked);
  const listedLinked = worktrees.find((worktree) => worktree.branch === "feature/test");
  assert.ok(listedLinked);
  assert.equal(findCurrentWorktreePath(worktrees, `${linked}${path.sep}`), listedLinked.path);
  await assert.rejects(removeWorktree(linked, repo, true), /Cannot remove the main worktree/);
  await assert.rejects(removeWorktree(repo, path.join(tempRoot, "unrelated"), true), /Not a worktree of this repository/);
  assert.equal((await listWorktrees(repo)).length, 2);
  await git(repo, ["status", "--porcelain"]);
  await git(linked, ["status", "--porcelain"]);
  const untracked = path.join(linked, "unsaved.txt");
  await writeFile(untracked, "must survive");
  await assert.rejects(removeWorktree(repo, linked), /contains modified or untracked files|is dirty/i);
  const { createJiti } = await import("jiti");
  const routeLoader = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
  const { allowFileRoot } = await routeLoader.import("./file-access.ts");
  const { DELETE } = await routeLoader.import("../app/api/worktrees/route.ts");
  allowFileRoot(repo);
  const deniedRemoval = await DELETE(new Request("http://localhost/api/worktrees", {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: repo, path: linked }),
  }));
  assert.equal(deniedRemoval.status, 409);
  assert.equal((await deniedRemoval.json()).dirty, true);
  const mainRemoval = await DELETE(new Request("http://localhost/api/worktrees", {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: repo, path: repo, force: true }),
  }));
  assert.equal(mainRemoval.status, 400);
  const mainError = await mainRemoval.json();
  assert.equal(mainError.dirty, false);
  assert.match(mainError.error, /Cannot remove the main worktree/);
  assert.equal(await readFile(untracked, "utf8"), "must survive");
  assert.equal((await listWorktrees(repo)).length, 2);
  await rm(untracked);
  await removeWorktree(repo, linked);
  const remaining = await listWorktrees(repo);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].isMain, true);
  assert.equal((await resolveProject(linked)).isWorktree, false);
  const recreated = await addWorktree(repo, " feature/test ");
  assert.equal(recreated.branch, "feature/test");
  assert.equal(recreated.path, path.join(`${repo}-worktrees`, "feature-test"));
  assert.equal((await listWorktrees(repo)).filter(item => item.branch === "feature/test").length, 1);
  const readmeBeforeCollision = await readFile(path.join(recreated.path, "README.md"), "utf8");
  await assert.rejects(addWorktree(repo, "feature-test"), /Directory already exists/);
  assert.equal((await resolveProject(recreated.path)).branch, "feature/test");
  assert.equal(await readFile(path.join(recreated.path, "README.md"), "utf8"), readmeBeforeCollision);
  assert.equal((await listWorktrees(repo)).length, 2);
  await removeWorktree(repo, recreated.path);
  const fresh = await addWorktree(repo, "fresh/new");
  assert.equal(fresh.branch, "fresh/new");
  assert.equal((await resolveProject(fresh.path)).branch, "fresh/new");
  await git(repo, ["show-ref", "--verify", "refs/heads/fresh/new"]);
  await removeWorktree(repo, fresh.path);
  const removedProject = await resolveProject(fresh.path);
  assert.equal(removedProject.projectRoot, mainProject.projectRoot);
  assert.equal(removedProject.isWorktree, true);
  assert.equal(removedProject.branch, "fresh-new");
  await git(repo, ["show-ref", "--verify", "refs/heads/fresh/new"]);
  assert.equal((await listWorktrees(repo)).length, 1);
  await assert.rejects(addWorktree(repo, "bad..branch"), /not a valid branch name|invalid branch/i);
  assert.equal((await listWorktrees(repo)).length, 1);
  await assert.rejects(lstat(path.join(`${repo}-worktrees`, "bad..branch")), { code: "ENOENT" });
  await git(repo, ["status", "--porcelain"]);
});
