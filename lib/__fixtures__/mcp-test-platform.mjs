import assert from "node:assert/strict";
import { stat, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Skip only a file-link case when Windows denies the symlink privilege. */
export async function fileSymlink(t, target, path) {
  try {
    await symlink(target, path, "file");
    return true;
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    t.skip("Windows file symlinks require Developer Mode or the symlink privilege (EPERM)");
    return false;
  }
}

/** NTFS permissions are ACLs, not POSIX mode bits; keep the surrounding IO tests running. */
export async function assertPosixMode(t, path, mode) {
  await t.test(`POSIX mode ${mode.toString(8)}`, {
    skip: process.platform === "win32" ? "Windows does not implement POSIX permission bits" : false,
  }, async () => assert.equal((await stat(path)).mode & 0o777, mode));
}

/** A real shell-resolved !command, without relying on touch or POSIX quoting. */
export function shellMarkerCommand(marker, value = "ok") {
  const quote = (path) => process.platform === "win32"
    ? `"${path}"`
    : `'${path.replaceAll("'", "'\\''")}'`;
  const script = fileURLToPath(new URL("./mcp-shell-marker.mjs", import.meta.url));
  return `!${quote(process.execPath)} ${quote(script)} ${Buffer.from(marker).toString("base64")} ${Buffer.from(value).toString("base64")}`;
}
