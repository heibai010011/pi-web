import { resolve } from "path";
import { getBase64DecodedByteLength } from "@/lib/image-attachments";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import {
  resolveImageSaveTarget,
  validateSavedImageSize,
  saveImageExclusive,
  ImageSaveAccessError,
} from "@/lib/image-save";

export const dynamic = "force-dynamic";

interface SaveImageBody {
  cwd?: unknown;
  data?: unknown;
  mimeType?: unknown;
  fileName?: unknown;
}

export async function POST(req: Request) {
  let body: SaveImageBody;
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
    }
    body = parsed as SaveImageBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.cwd !== "string" || !body.cwd) {
    return Response.json({ error: "cwd is required" }, { status: 400 });
  }
  if (typeof body.data !== "string" || !body.data) {
    return Response.json({ error: "data (base64 image) is required" }, { status: 400 });
  }
  if (typeof body.mimeType !== "string" || !body.mimeType) {
    return Response.json({ error: "mimeType is required" }, { status: 400 });
  }

  const cwd = resolve(body.cwd);
  const allowedRoots = await getAllowedFileRoots();
  // The generated-images directory inherits the cwd's authorization; the
  // parent cwd itself must already be an allowed root.
  if (!isFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  let bytes: Buffer;
  try {
    const decodedSize = getBase64DecodedByteLength(body.data);
    if (decodedSize === null) throw new Error("Invalid base64 image data");
    validateSavedImageSize(decodedSize);
    bytes = Buffer.from(body.data, "base64");
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid image data" }, { status: 400 });
  }

  let target;
  try {
    target = resolveImageSaveTarget(cwd, body.mimeType, typeof body.fileName === "string" ? body.fileName : undefined);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid save target" }, { status: 400 });
  }

  try {
    target = await saveImageExclusive(cwd, body.mimeType, target.fileName, bytes, allowedRoots);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to write image file" },
      { status: error instanceof ImageSaveAccessError ? 403 : 500 },
    );
  }

  return Response.json({ ok: true, path: target.filePath, fileName: target.fileName });
}
