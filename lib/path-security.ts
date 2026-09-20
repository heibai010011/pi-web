import { realpathSync } from "fs";
import path from "path";
import { isWindowsAbsolutePath } from "./paths";

/**
 * Lexical containment check. Accepts either canonical form on both sides: it
 * re-resolves through path.win32/path.posix and case-folds on Windows, so
 * separator style and drive-letter case never decide the answer.
 */
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

export function isExistingPathWithinRoots(target: string, roots: Set<string>): boolean {
  let realTarget: string;
  try {
    realTarget = realpathSync.native(target);
  } catch {
    return false;
  }

  const realRoots = new Set<string>();
  for (const root of roots) {
    try {
      realRoots.add(realpathSync.native(root));
    } catch {
      // Ignore stale roots derived from removed sessions or worktrees.
    }
  }
  // realpath can retain a Windows namespace prefix depending on its input.
  // Canonicalize both resolved sides rather than comparing mixed path forms.
  if (process.platform === "win32") {
    return isPathWithinRoots(path.toNamespacedPath(realTarget), new Set([...realRoots].map(root => path.toNamespacedPath(root))));
  }
  return isPathWithinRoots(realTarget, realRoots);
}
