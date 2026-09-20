// Server-side helpers for saving generated images into the session's project.

import { isAbsolute, join, relative, resolve, parse } from "path";
import { lstat, mkdir, realpath, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { isExistingPathWithinRoots } from "./path-security";

export class ImageSaveAccessError extends Error {
  constructor() { super("Access denied"); }
}

/** Resolve existing parents before creating anything; never overwrite or follow a destination link. */
export async function saveImageExclusive(
  cwd: string,
  mimeType: string,
  fileName: string | undefined,
  bytes: Buffer,
  allowedRoots: Set<string>,
): Promise<ResolvedImageSaveTarget> {
  validateSavedImageSize(bytes.byteLength);
  const canonicalCwd = await realpath(cwd);
  if (!isExistingPathWithinRoots(canonicalCwd, allowedRoots)) throw new ImageSaveAccessError();
  const target = resolveImageSaveTarget(canonicalCwd, mimeType, fileName);
  try {
    await mkdir(target.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const directoryStat = await lstat(target.directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
    || !isExistingPathWithinRoots(target.directory, allowedRoots)) throw new ImageSaveAccessError();
  const directory = await realpath(target.directory);
  const { name, ext } = parse(target.fileName);
  for (let attempt = 0; attempt < 10; attempt++) {
    const nextName = attempt === 0 ? target.fileName : `${name}-${randomUUID()}${ext}`;
    const filePath = join(directory, nextName);
    try {
      await writeFile(filePath, bytes, { flag: "wx" });
      return { directory, filePath, fileName: nextName };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a unique image filename");
}

export const GENERATED_IMAGES_DIR = "generated-images";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MAX_SAVED_IMAGE_BYTES = 20 * 1024 * 1024;

export function extensionForMime(mimeType: string): string | undefined {
  const key = mimeType.toLowerCase();
  return Object.hasOwn(MIME_EXTENSIONS, key) ? MIME_EXTENSIONS[key] : undefined;
}

/** Strip everything unsafe from a client-provided file name. The canonical
 *  extension for the mime type is always re-appended, so it cannot be forged. */
export function sanitizeImageFileName(name: string | undefined, mimeType: string): string | undefined {
  const expectedExt = extensionForMime(mimeType);
  if (!name || !expectedExt) return undefined;
  const base = name.split(/[/\\]/).pop() ?? "";
  const withoutExt = base.replace(/\.[^.]*$/, "");
  const stem = withoutExt
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!stem) return undefined;
  // Windows reserves these device names even when an extension is present.
  const safeStem = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)
    ? `image-${stem}` : stem;
  // Common Unix filesystems limit a component to 255 UTF-8 bytes. Reserve
  // 37 bytes for the collision retry's "-<uuid>" plus the file extension.
  const maxStemBytes = 255 - 37 - Buffer.byteLength(`.${expectedExt}`, "utf8");
  let truncated = "";
  let byteLength = 0;
  for (const character of safeStem.slice(0, 110)) {
    const size = Buffer.byteLength(character, "utf8");
    if (byteLength + size > maxStemBytes) break;
    truncated += character;
    byteLength += size;
  }
  return `${truncated.replace(/-+$/, "")}.${expectedExt}`;
}

export interface ResolvedImageSaveTarget {
  directory: string;
  filePath: string;
  fileName: string;
}

/**
 * Resolve the save target under `<cwd>/generated-images/`. The directory
 * component never comes from user input; the file name is sanitized and the
 * final path is re-checked to stay inside the directory (caller still applies
 * the allowed-roots check on the returned path).
 */
export function resolveImageSaveTarget(
  cwd: string,
  mimeType: string,
  fileName: string | undefined,
  now: Date = new Date(),
): ResolvedImageSaveTarget {
  const extension = extensionForMime(mimeType);
  if (!extension) throw new Error(`Unsupported image type: ${mimeType}`);

  const directory = resolve(cwd, GENERATED_IMAGES_DIR);
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const fallback = `image-${stamp}.${extension}`;
  const safeName = sanitizeImageFileName(fileName, mimeType) ?? fallback;
  const candidate = resolve(join(directory, safeName));
  const relativeToDir = relative(directory, candidate);
  if (relativeToDir.startsWith("..") || isAbsolute(relativeToDir)) {
    throw new Error("Resolved image path escapes the generated-images directory");
  }
  return { directory, filePath: candidate, fileName: safeName };
}

export function validateSavedImageSize(byteLength: number): void {
  if (byteLength <= 0) throw new Error("Image data is empty");
  if (byteLength > MAX_SAVED_IMAGE_BYTES) throw new Error("Image data exceeds the 20MB save limit");
}
