import { existsSync, mkdirSync, symlinkSync } from "fs";
import { basename } from "path";
import { WORKING_DIR } from "../../config";
import { buildStoragePartitionKey, parseSessionKey } from "../routing/session-key";

// Per-service isolation: each WORKING_DIR gets its own thread-workdirs to prevent
// symlink collisions when multiple bot instances share the same binary (e.g. p9 + np1)
export const THREAD_WORKDIRS_DIR = `/tmp/soma-thread-workdirs-${basename(WORKING_DIR)}`;

export interface ThreadWorkdirProvider {
  ensureDirectory(): void;
  getThreadWorkingDir(storagePartitionKey: string): string;
  getThreadWorkingDirFromSessionKey(sessionKey: string): string;
}

export function ensureThreadWorkdirsDir(threadWorkdirsDir = THREAD_WORKDIRS_DIR): void {
  if (!existsSync(threadWorkdirsDir)) {
    mkdirSync(threadWorkdirsDir, { recursive: true });
  }
}

export function getThreadWorkingDir(
  storagePartitionKey: string,
  threadWorkdirsDir = THREAD_WORKDIRS_DIR,
  workingDir = WORKING_DIR
): string {
  ensureThreadWorkdirsDir(threadWorkdirsDir);
  const aliasName = storagePartitionKey.replace(/\//g, "__");
  const aliasPath = `${threadWorkdirsDir}/${aliasName}`;
  if (existsSync(aliasPath)) {
    return aliasPath;
  }

  try {
    symlinkSync(workingDir, aliasPath, "dir");
    return aliasPath;
  } catch (error) {
    console.warn(
      `[ThreadWorkdir] Failed to create thread workdir for ${aliasName}: ${error}`
    );
    return workingDir;
  }
}

export function getThreadWorkingDirFromSessionKey(
  key: string,
  threadWorkdirsDir = THREAD_WORKDIRS_DIR,
  workingDir = WORKING_DIR
): string {
  try {
    const identity = parseSessionKey(key);
    return getThreadWorkingDir(
      buildStoragePartitionKey(identity) as string,
      threadWorkdirsDir,
      workingDir
    );
  } catch {
    return workingDir;
  }
}

export class SymlinkThreadWorkdirProvider implements ThreadWorkdirProvider {
  constructor(
    private readonly threadWorkdirsDir = THREAD_WORKDIRS_DIR,
    private readonly workingDir = WORKING_DIR
  ) {}

  ensureDirectory(): void {
    ensureThreadWorkdirsDir(this.threadWorkdirsDir);
  }

  getThreadWorkingDir(storagePartitionKey: string): string {
    return getThreadWorkingDir(
      storagePartitionKey,
      this.threadWorkdirsDir,
      this.workingDir
    );
  }

  getThreadWorkingDirFromSessionKey(sessionKey: string): string {
    return getThreadWorkingDirFromSessionKey(
      sessionKey,
      this.threadWorkdirsDir,
      this.workingDir
    );
  }
}
