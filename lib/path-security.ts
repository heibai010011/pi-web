import { realpathSync } from "fs";
import path from "path";
import { isWindowsAbsolutePath } from "./paths";

/** Lexical containment with Windows namespace, separator and case normalization. */
export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = useWindowsRules ? path.win32.toNamespacedPath(resolver.resolve(target)) : resolver.resolve(target);
    const normalizedRoot = useWindowsRules ? path.win32.toNamespacedPath(resolver.resolve(root)) : resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) return true;
  }
  return false;
}

/** The roots after resolving symbolic links, for comparing canonical paths. */
export function resolveRealRoots(roots: Set<string>): Set<string> {
  const realRoots = new Set<string>();
  for (const root of roots) {
    try {
      realRoots.add(realpathSync.native(root));
    } catch {
      // Ignore stale roots derived from removed sessions or worktrees.
    }
  }
  return realRoots;
}

/** Reject parent segments before normalization can hide traversal through a link. */
export function hasParentDirectorySegment(target: string): boolean {
  const separator = process.platform === "win32" || isWindowsAbsolutePath(target) ? /[\\/]/ : "/";
  return target.split(separator).includes("..");
}

export function isExistingPathWithinRoots(target: string, roots: Set<string>): boolean {
  if (hasParentDirectorySegment(target)) return false;
  let realTarget: string;
  try {
    realTarget = realpathSync.native(target);
  } catch {
    return false;
  }
  return isPathWithinRoots(realTarget, resolveRealRoots(roots));
}
