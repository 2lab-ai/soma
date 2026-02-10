import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import type { SessionData } from "./types/session";
import { SessionManager } from "./core/session/session-manager";
import type { ProviderOrchestrator } from "./providers/orchestrator";
import type { SessionStore } from "./core/session/session-store";
import type { ThreadWorkdirProvider } from "./core/session/thread-workdir";
import { sessionManager } from "./core/session/session-manager";

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

    await writeSessionFile(legacyPath, createPersistedSessionData(`legacy-${chatId}`));
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

  test("hasSession returns true for in-memory session even before persistence", async () => {
    const chatId = uniqueChatId(3);
    const threadId = 99;

    expect(sessionManager.hasSession(chatId, threadId)).toBe(false);
    sessionManager.getSession(chatId, threadId);
    expect(sessionManager.hasSession(chatId, threadId)).toBe(true);

    await sessionManager.killSession(chatId, threadId);
  });

  test("supports injected store/workdir boundaries for isolated lifecycle tests", async () => {
    const persisted = new Map<string, SessionData>();
    const mockStore: SessionStore = {
      ensureDirectory: () => {},
      getSessionFilePath: (key: string) => `/virtual/${key}.json`,
      sessionFileExists: (key: string) => persisted.has(key),
      saveSession: (key, session) => {
        if (!session.sessionId) return;
        persisted.set(key, {
          session_id: session.sessionId,
          saved_at: new Date().toISOString(),
          working_dir: session.workingDir,
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          totalQueries: session.totalQueries,
        });
      },
      loadSession: (key: string) => persisted.get(key) ?? null,
      listSessionKeys: () => Array.from(persisted.keys()),
      deleteSessionFile: (key: string) => {
        persisted.delete(key);
      },
    };
    const mockWorkdirProvider: ThreadWorkdirProvider = {
      ensureDirectory: () => {},
      getThreadWorkingDir: () => "/tmp",
      getThreadWorkingDirFromSessionKey: () => "/tmp",
    };
    const manager = new SessionManager({
      sessionStore: mockStore,
      threadWorkdirProvider: mockWorkdirProvider,
      chatCaptureService: null,
      startCleanupTimer: false,
    });
    const chatId = uniqueChatId(4);
    const threadId = 7;
    const key = manager.deriveKey(chatId, threadId);

    const session = manager.getSession(chatId, threadId);
    session.sessionId = "mock-persisted-session";
    manager.saveAllSessions();

    expect(persisted.has(key)).toBe(true);
    expect(manager.hasSession(chatId, threadId)).toBe(true);

    await manager.killSession(chatId, threadId);
    expect(persisted.has(key)).toBe(false);

    manager.stop();
  });

  test("uses injected provider orchestrator on runtime query path", async () => {
    const mockStore: SessionStore = {
      ensureDirectory: () => {},
      getSessionFilePath: (key: string) => `/virtual/${key}.json`,
      sessionFileExists: () => false,
      saveSession: () => {},
      loadSession: () => null,
      listSessionKeys: () => [],
      deleteSessionFile: () => {},
    };
    const mockWorkdirProvider: ThreadWorkdirProvider = {
      ensureDirectory: () => {},
      getThreadWorkingDir: () => "/tmp",
      getThreadWorkingDirFromSessionKey: () => "/tmp",
    };

    let executeCalls = 0;
    const providerOrchestrator = {
      executeProviderQuery: async (params: {
        input: { queryId: string };
        onEvent: (event: {
          providerId: string;
          queryId: string;
          timestamp: number;
          type: "session" | "text" | "done";
          providerSessionId?: string;
          resumed?: boolean;
          delta?: string;
          reason?: "completed";
        }) => Promise<void>;
      }) => {
        executeCalls += 1;
        await params.onEvent({
          providerId: "anthropic",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "session",
          providerSessionId: "provider-session-1",
          resumed: false,
        });
        await params.onEvent({
          providerId: "anthropic",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "text",
          delta: "provider runtime response",
        });
        await params.onEvent({
          providerId: "anthropic",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "done",
          reason: "completed",
        });
        return {
          providerId: "anthropic",
          attempts: 1,
        };
      },
      registerProvider: () => {},
      listProviders: () => ["anthropic"],
    } as unknown as ProviderOrchestrator;

    const manager = new SessionManager({
      sessionStore: mockStore,
      threadWorkdirProvider: mockWorkdirProvider,
      chatCaptureService: null,
      providerOrchestrator,
      startCleanupTimer: false,
    });

    const session = manager.getSession(uniqueChatId(9), 33);
    const response = await session.sendMessageStreaming(
      "run provider orchestrator path",
      async () => {}
    );

    expect(executeCalls).toBe(1);
    expect(response).toContain("provider runtime response");

    await manager.killSession(uniqueChatId(9), 33);
    manager.stop();
  });
});
