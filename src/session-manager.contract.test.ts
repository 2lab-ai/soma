import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import type { SessionData } from "./types";
import { sessionManager } from "./session-manager";

const SESSIONS_DIR = "/tmp/soma-sessions";

function buildCanonicalPath(chatId: number, threadId?: number): string {
  const key = sessionManager.deriveKey(chatId, threadId);
  return `${SESSIONS_DIR}/${key.replace(/:/g, "_")}.json`;
}

function buildLegacyPath(chatId: number, threadId?: number): string {
  if (threadId && threadId !== 1) {
    return `${SESSIONS_DIR}/${chatId}_${threadId}.json`;
  }
  return `${SESSIONS_DIR}/${chatId}.json`;
}

function createPersistedSessionData(sessionId: string): SessionData {
  return {
    session_id: sessionId,
    saved_at: new Date().toISOString(),
    working_dir: "/tmp",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalQueries: 0,
  };
}

function uniqueChatId(seed: number): number {
  return 980000000 + seed;
}

async function writeSessionFile(path: string, data: SessionData): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(data), "utf-8");
}

async function cleanupFiles(paths: string[]): Promise<void> {
  for (const path of paths) {
    if (existsSync(path)) {
      await rm(path, { force: true });
    }
  }
}

describe("SessionManager canonical contract", () => {
  afterEach(async () => {
    const chatA = uniqueChatId(1);
    const chatB = uniqueChatId(2);
    const thread = 42;

    await cleanupFiles([
      buildCanonicalPath(chatA),
      buildCanonicalPath(chatB, thread),
      buildLegacyPath(chatA),
      buildLegacyPath(chatB, thread),
    ]);
  });

  test("deriveKey uses tenant:channel:thread canonical format", () => {
    const chatId = uniqueChatId(1);

    expect(sessionManager.deriveKey(chatId)).toBe(`default:${chatId}:main`);
    expect(sessionManager.deriveKey(chatId, 1)).toBe(`default:${chatId}:main`);
    expect(sessionManager.deriveKey(chatId, 42)).toBe(`default:${chatId}:42`);
  });

  test("hasSession ignores legacy flat key files", async () => {
    const chatId = uniqueChatId(1);
    const canonicalPath = buildCanonicalPath(chatId);
    const legacyPath = buildLegacyPath(chatId);

    await writeSessionFile(
      legacyPath,
      createPersistedSessionData(`legacy-${chatId}`)
    );
    expect(sessionManager.hasSession(chatId)).toBe(false);

    await writeSessionFile(
      canonicalPath,
      createPersistedSessionData(`canonical-${chatId}`)
    );
    expect(sessionManager.hasSession(chatId)).toBe(true);
  });

  test("killSession removes canonical file only", async () => {
    const chatId = uniqueChatId(2);
    const threadId = 42;
    const canonicalPath = buildCanonicalPath(chatId, threadId);
    const legacyPath = buildLegacyPath(chatId, threadId);

    await writeSessionFile(
      canonicalPath,
      createPersistedSessionData(`canonical-${chatId}-${threadId}`)
    );
    await writeSessionFile(
      legacyPath,
      createPersistedSessionData(`legacy-${chatId}-${threadId}`)
    );

    await sessionManager.killSession(chatId, threadId);

    expect(existsSync(canonicalPath)).toBe(false);
    expect(existsSync(legacyPath)).toBe(true);
  });
});
