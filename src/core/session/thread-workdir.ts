import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { WORKING_DIR } from "../../config";
import { buildStoragePartitionKey, parseSessionKey } from "../routing/session-key";

export const THREAD_WORKDIRS_DIR = "/tmp/soma-thread-workdirs";

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

  try {
    const stat = lstatSync(aliasPath);
    if (!stat.isSymbolicLink()) {
      console.warn(
        `[ThreadWorkdir] Alias path exists but is not a symlink: ${aliasPath}. Falling back to working dir ${workingDir}`
      );
      return workingDir;
    }

    const linkTarget = readlinkSync(aliasPath);
    const resolvedTarget = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(aliasPath), linkTarget);
    if (resolvedTarget === workingDir) {
      return aliasPath;
    }

    console.warn(
      `[ThreadWorkdir] Stale thread workdir alias detected for ${aliasName}. Repointing ${aliasPath} -> ${workingDir} (was: ${resolvedTarget})`
    );
    unlinkSync(aliasPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(
        `[ThreadWorkdir] Failed to inspect thread workdir alias ${aliasPath}: ${error}`
      );
    }
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
