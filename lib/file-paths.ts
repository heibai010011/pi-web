export function normalizeFilePathSlashes(filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

export function encodeFilePathForApi(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath);
  const segments = normalized.split("/").filter(Boolean);
  // A literal "//" prefix is normalized away by URL routing before it reaches
  // the catch-all handler, so a UNC root must live inside the first segment:
  // "//host" encodes as "%2F%2Fhost" and decodes back as a single segment.
  if (normalized.startsWith("//") && segments.length > 0) {
    segments[0] = `//${segments[0]}`;
  }
  return segments.map(encodeURIComponent).join("/");
}

export function getFileName(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  return normalized.split("/").pop() ?? normalized;
}

export function getFileDirectory(filePath: string): string {
  const slashed = normalizeFilePathSlashes(filePath);
  if (/^\/+$/.test(slashed)) return "/";
  if (/^[a-zA-Z]:\/+$/.test(slashed)) return slashed.slice(0, 3);
  const normalized = slashed.replace(/\/+$/, "");
  // A UNC share is a filesystem root, not a child of its server name.
  if (/^\/\/[^/]+\/[^/]+$/.test(normalized)) return normalized;
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return "/";
  if (lastSlash === 2 && /^[a-zA-Z]:\//.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, lastSlash);
}

export function getRelativeFilePath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;

  const normalizedFile = normalizeFilePathSlashes(filePath);
  const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/+$/, "");
  // Browser code must infer Windows semantics from the path, not the host OS.
  const isWindowsPath = (path: string) => /^[a-zA-Z]:\//.test(path) || path.startsWith("//");
  const ignoreCase = isWindowsPath(normalizedFile) && isWindowsPath(normalizedCwd + "/");
  const comparableFile = ignoreCase ? normalizedFile.toLowerCase() : normalizedFile;
  const comparableCwd = ignoreCase ? normalizedCwd.toLowerCase() : normalizedCwd;
  if (comparableFile.startsWith(comparableCwd + "/")) {
    return normalizedFile.slice(normalizedCwd.length + 1);
  }
  return filePath;
}

export function joinFilePath(parent: string, child: string): string {
  return `${normalizeFilePathSlashes(parent).replace(/\/+$/, "")}/${child}`;
}
