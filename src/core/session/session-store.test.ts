import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ClaudeSession } from "./session";
import {
  FileSessionStore,
  deleteSessionFile,
  getSessionFilePath,
  listSessionKeys,
  loadSession,
  saveSession,
  sessionFileExists,
} from "./session-store";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "soma-session-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("session-store", () => {
  test("getSessionFilePath keeps canonical key format and filename mapping", async () => {
    const dir = await createTempDir();
    const key = "default:980000001:main";
    expect(getSessionFilePath(key, dir)).toBe(`${dir}/default_980000001_main.json`);
  });

  test("saveSession/loadSession round-trips persisted data", async () => {
    const dir = await createTempDir();
    const key = "default:980000002:42";
    const session = new ClaudeSession(key);
    session.sessionId = "session-abc";
    session.totalInputTokens = 123;
    session.totalOutputTokens = 45;
    session.totalQueries = 6;

    saveSession(key, session, dir);

    expect(sessionFileExists(key, dir)).toBe(true);
    const loaded = loadSession(key, dir);
    expect(loaded?.session_id).toBe("session-abc");
    expect(loaded?.totalInputTokens).toBe(123);
    expect(loaded?.totalOutputTokens).toBe(45);
    expect(loaded?.totalQueries).toBe(6);
  });

  test("FileSessionStore lists canonical keys and deletes persisted files", async () => {
    const dir = await createTempDir();
    const store = new FileSessionStore(dir);
    const key = "default:980000003:main";
    const session = new ClaudeSession(key);
    session.sessionId = "session-delete";

    store.saveSession(key, session);
    expect(store.listSessionKeys()).toEqual([key]);

    const filePath = store.getSessionFilePath(key);
    expect(existsSync(filePath)).toBe(true);

    deleteSessionFile(key, dir);
    expect(existsSync(filePath)).toBe(false);
    expect(listSessionKeys(dir)).toEqual([]);
  });
});
