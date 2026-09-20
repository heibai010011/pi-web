import { randomUUID } from "crypto";
import { renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 */
export function writePrivateFileAtomicSync(path: string, contents: string): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.pi-atomic-${randomUUID()}.tmp`);
  let operationFailed = false;
  let tempCollision = false;
  let tempWritten = false;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    tempWritten = true;
    renameSync(tempPath, path);
  } catch (error) {
    operationFailed = true;
    tempCollision = !tempWritten && (error as NodeJS.ErrnoException).code === "EEXIST";
    throw error;
  } finally {
    // Exclusive creation did not grant ownership of an existing temp file.
    // A successful rename already consumed our temporary path.
    if (operationFailed && !tempCollision) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Preserve the original write/rename error if cleanup also fails.
      }
    }
  }
}
