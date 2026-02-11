import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { getThreadWorkingDir } from "./thread-workdir";

const createdDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("thread workdir symlink lifecycle", () => {
  test("repairs broken symlink aliases instead of failing with EEXIST", () => {
    const root = makeTmpDir("thread-workdir-broken-");
    const threadRoot = `${root}/aliases`;
    mkdirSync(threadRoot, { recursive: true });

    const staleTarget = `${root}/old-working-dir`;
    mkdirSync(staleTarget, { recursive: true });

    const storagePartitionKey = "default/58705735/main";
    const aliasPath = `${threadRoot}/${storagePartitionKey.replace(/\//g, "__")}`;
    symlinkSync(staleTarget, aliasPath, "dir");

    // Make existing alias broken.
    rmSync(staleTarget, { recursive: true, force: true });

    const newWorkingDir = `${root}/new-working-dir`;
    mkdirSync(newWorkingDir, { recursive: true });

    const resolved = getThreadWorkingDir(
      storagePartitionKey,
      threadRoot,
      newWorkingDir
    );

    expect(resolved).toBe(aliasPath);
    expect(readlinkSync(aliasPath)).toBe(newWorkingDir);
  });

  test("retargets stale symlink when alias points to old existing directory", () => {
    const root = makeTmpDir("thread-workdir-stale-");
    const threadRoot = `${root}/aliases`;
    mkdirSync(threadRoot, { recursive: true });

    const oldWorkingDir = `${root}/old-working-dir`;
    const newWorkingDir = `${root}/new-working-dir`;
    mkdirSync(oldWorkingDir, { recursive: true });
    mkdirSync(newWorkingDir, { recursive: true });
    writeFileSync(`${oldWorkingDir}/marker.txt`, "old");

    const storagePartitionKey = "default/58705735/main";
    const aliasPath = `${threadRoot}/${storagePartitionKey.replace(/\//g, "__")}`;
    symlinkSync(oldWorkingDir, aliasPath, "dir");

    const resolved = getThreadWorkingDir(
      storagePartitionKey,
      threadRoot,
      newWorkingDir
    );

    expect(resolved).toBe(aliasPath);
    expect(readlinkSync(aliasPath)).toBe(newWorkingDir);
  });
});
