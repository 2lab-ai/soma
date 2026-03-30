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
 * Check if a path is a hardlink (nlink > 1).
 * Hardlinks share inodes with their target but appear as regular files to lstat.
 */
export function isHardlink(fullPath: string): boolean {
  try {
    const stat = lstatSync(fullPath);
    // Directories naturally have nlink > 1 (. and ..), skip them
    if (stat.isDirectory()) return false;
    return stat.nlink > 1;
  } catch {
    return false;
  }
}

/**
 * Validate archive members BEFORE extraction.
 * Checks for path traversal entries in member names.
 * Throws if dangerous entries detected.
 */
export async function validateArchiveMembers(
  archivePath: string,
  fileName: string
): Promise<void> {
  const ext = fileName.toLowerCase();
  let memberList: string;

  if (ext.endsWith(".zip")) {
    const result = await Bun.$`unzip -l ${archivePath}`.quiet();
    memberList = result.text();
  } else {
    // tar, tar.gz, tgz
    const result = await Bun.$`tar -tf ${archivePath}`.quiet();
    memberList = result.text();
  }

  const lines = memberList.split("\n").filter(Boolean);
  const dangerous: string[] = [];

  for (const line of lines) {
    // For unzip -l, the filename is the last column
    // For tar -tf, each line is a filename
    const memberName = ext.endsWith(".zip")
      ? line.trim().split(/\s+/).pop() || ""
      : line.trim();

    if (memberName.includes("..")) {
      dangerous.push(memberName);
    }
  }

  if (dangerous.length > 0) {
    throw new Error(
      `[SECURITY] Archive contains path traversal entries: ${dangerous.join(", ")}`
    );
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

    // Check hardlink (nlink > 1 indicates shared inode)
    if (isHardlink(fullPath)) {
      removed.push(`hardlink: ${relativePath}`);
      try { await Bun.$`rm -f ${fullPath}`.quiet(); } catch {}
      continue;
    }
  }

  return removed;
}
