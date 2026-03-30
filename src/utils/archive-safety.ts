import { resolve } from "path";
import { lstatSync, readdirSync } from "fs";

/**
 * Validate that a resolved path is contained within the expected directory.
 * Prevents path traversal attacks (../../etc/passwd).
 */
export function isPathContained(extractDir: string, filePath: string): boolean {
  const resolvedDir = resolve(extractDir);
  const resolvedPath = resolve(extractDir, filePath);
  return resolvedPath.startsWith(resolvedDir + "/") || resolvedPath === resolvedDir;
}

/**
 * Check if a path is a symlink.
 */
export function isSymlink(fullPath: string): boolean {
  try {
    return lstatSync(fullPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Recursively collect all entries (files, symlinks, dirs) under a directory
 * using lstat so symlinks are not followed.
 */
function collectEntries(dir: string, base: string): string[] {
  const results: string[] = [];
  let items: string[];
  try {
    items = readdirSync(dir);
  } catch {
    return results;
  }
  for (const item of items) {
    const fullPath = resolve(dir, item);
    const relativePath = base ? `${base}/${item}` : item;
    const stat = lstatSync(fullPath);
    results.push(relativePath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      results.push(...collectEntries(fullPath, relativePath));
    }
  }
  return results;
}

/**
 * Validate all extracted files in a directory.
 * Removes any files that escape the directory or are symlinks.
 * Returns list of removed dangerous entries for logging.
 */
export async function sanitizeExtractedDir(extractDir: string): Promise<string[]> {
  const removed: string[] = [];
  const entries = collectEntries(resolve(extractDir), "");

  for (const relativePath of entries) {
    const fullPath = resolve(extractDir, relativePath);

    // Check path containment
    if (!isPathContained(extractDir, relativePath)) {
      removed.push(`path-traversal: ${relativePath}`);
      try { await Bun.$`rm -f ${fullPath}`.quiet(); } catch {}
      continue;
    }

    // Check symlink
    if (isSymlink(fullPath)) {
      removed.push(`symlink: ${relativePath}`);
      try { await Bun.$`rm -f ${fullPath}`.quiet(); } catch {}
      continue;
    }
  }

  return removed;
}
