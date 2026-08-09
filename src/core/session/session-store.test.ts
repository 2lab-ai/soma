import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ClaudeSession } from "./session";
import {
  FileSessionStore,
  SESSIONS_ROOT,
  deleteSessionFile,
  ensureSessionsDir,
  getSessionFilePath,
  listSessionKeys,
  loadSession,
  resolveSessionsDir,
  sanitizeServiceName,
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

describe("per-bot sessions directory", () => {
  const originalServiceName = process.env.SERVICE_NAME;

  afterEach(() => {
    if (originalServiceName === undefined) {
      delete process.env.SERVICE_NAME;
    } else {
      process.env.SERVICE_NAME = originalServiceName;
    }
  });

  test("separates pointer paths per SERVICE_NAME", () => {
    expect(resolveSessionsDir("elon-bot")).toBe(`${SESSIONS_ROOT}/elon-bot`);
    expect(resolveSessionsDir("chaewon-bot")).toBe(`${SESSIONS_ROOT}/chaewon-bot`);
    expect(resolveSessionsDir("elon-bot")).not.toBe(resolveSessionsDir("chaewon-bot"));
  });

  test("two bots no longer collide on the cron heartbeat pointer", () => {
    const key = "cron:scheduler:heartbeat";
    expect(getSessionFilePath(key, resolveSessionsDir("elon-bot"))).not.toBe(
      getSessionFilePath(key, resolveSessionsDir("chaewon-bot"))
    );
  });

  test("sanitizes unsafe characters out of the service name", () => {
    expect(sanitizeServiceName("chae/won bot!")).toBe("chaewonbot");
    expect(sanitizeServiceName("np1_v2.0-beta")).toBe("np1_v2.0-beta");
    expect(resolveSessionsDir("../../etc")).toBe(`${SESSIONS_ROOT}/....etc`);
  });

  test("falls back to default for empty or traversal names", () => {
    expect(sanitizeServiceName("")).toBe("default");
    expect(sanitizeServiceName("..")).toBe("default");
    expect(sanitizeServiceName(".")).toBe("default");
    expect(sanitizeServiceName("///")).toBe("default");
  });

  test("reads SERVICE_NAME from process.env and defaults when unset", () => {
    process.env.SERVICE_NAME = "elon-bot";
    expect(resolveSessionsDir()).toBe(`${SESSIONS_ROOT}/elon-bot`);

    delete process.env.SERVICE_NAME;
    expect(resolveSessionsDir()).toBe(`${SESSIONS_ROOT}/default`);
  });

  test("ensureSessionsDir creates the namespaced directory recursively", async () => {
    const base = await createTempDir();
    const dir = join(base, "soma-sessions", "elon-bot");
    expect(existsSync(dir)).toBe(false);

    ensureSessionsDir(dir);
    expect(existsSync(dir)).toBe(true);

    // Idempotent: a second call on an existing directory is a no-op.
    ensureSessionsDir(dir);
    expect(existsSync(dir)).toBe(true);
  });
});
