/**
 * Tests for SessionManager — lifecycle, TTL expiry, LRU eviction, key derivation.
 * soma-j7x4: CRITICAL session lifecycle had zero tests.
 */
import { describe, expect, test } from "bun:test";
import { SessionManager } from "./session-manager";
import type { SessionStore } from "./session-store";
import type { ThreadWorkdirProvider } from "./thread-workdir";

// ─── In-memory test doubles ────────────────────────────────────────

function createInMemorySessionStore(): SessionStore & { saved: Map<string, unknown> } {
  const saved = new Map<string, unknown>();
  const deleted: string[] = [];

  return {
    saved,
    ensureDirectory: () => {},
    getSessionFilePath: (key: string) => `/tmp/test-sessions/${key}.json`,
    loadSession: (key: string) => saved.get(key) as any ?? null,
    saveSession: (key: string, session: unknown) => {
      saved.set(key, session);
    },
    deleteSessionFile: (key: string) => {
      deleted.push(key);
      saved.delete(key);
    },
    sessionFileExists: (key: string) => saved.has(key),
    listSessionKeys: () => Array.from(saved.keys()),
  };
}

function createNoopWorkdirProvider(): ThreadWorkdirProvider {
  return {
    ensureDirectory: () => {},
    getThreadWorkingDir: () => "/tmp/test-workdir",
    getThreadWorkingDirFromSessionKey: () => "/tmp/test-workdir",
  };
}

function createTestManager(store?: SessionStore): SessionManager {
  return new SessionManager({
    sessionStore: store ?? createInMemorySessionStore(),
    threadWorkdirProvider: createNoopWorkdirProvider(),
    chatCaptureService: null,
    providerOrchestrator: null,
    startCleanupTimer: false, // Don't leak timers in tests
  });
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("SessionManager", () => {
  describe("session creation and retrieval", () => {
    test("getSession creates new session for unknown chatId", () => {
      const manager = createTestManager();
      const session = manager.getSession(1001);
      expect(session).toBeDefined();
      expect(session.isActive).toBe(false);
      expect(manager.sessionCount).toBe(1);
    });

    test("getSession returns same session for same chatId", () => {
      const manager = createTestManager();
      const s1 = manager.getSession(1001);
      const s2 = manager.getSession(1001);
      expect(s1).toBe(s2); // Same object reference
      expect(manager.sessionCount).toBe(1);
    });

    test("different chatIds create different sessions", () => {
      const manager = createTestManager();
      const s1 = manager.getSession(1001);
      const s2 = manager.getSession(2002);
      expect(s1).not.toBe(s2);
      expect(manager.sessionCount).toBe(2);
    });

    test("thread ID creates separate session", () => {
      const manager = createTestManager();
      const s1 = manager.getSession(1001);
      const s2 = manager.getSession(1001, 42);
      expect(s1).not.toBe(s2);
      expect(manager.sessionCount).toBe(2);
    });

    test("thread ID 1 (main) maps to same session as no thread", () => {
      const manager = createTestManager();
      const s1 = manager.getSession(1001);
      const s2 = manager.getSession(1001, 1); // main thread
      expect(s1).toBe(s2);
      expect(manager.sessionCount).toBe(1);
    });
  });

  describe("key derivation", () => {
    test("deriveKey returns consistent key for same input", () => {
      const manager = createTestManager();
      const k1 = manager.deriveKey(1001);
      const k2 = manager.deriveKey(1001);
      expect(k1).toBe(k2);
    });

    test("deriveKey produces different keys for different threads", () => {
      const manager = createTestManager();
      const k1 = manager.deriveKey(1001);
      const k2 = manager.deriveKey(1001, 42);
      expect(k1).not.toBe(k2);
    });

    test("deriveKey format includes tenant:channel:thread", () => {
      const manager = createTestManager();
      const key = manager.deriveKey(1001, 42);
      expect(key).toContain("1001");
      expect(key).toContain("42");
    });
  });

  describe("hasSession", () => {
    test("returns false for non-existent session", () => {
      const manager = createTestManager();
      expect(manager.hasSession(9999)).toBe(false);
    });

    test("returns true for in-memory session", () => {
      const manager = createTestManager();
      manager.getSession(1001); // create
      expect(manager.hasSession(1001)).toBe(true);
    });
  });

  describe("killSession", () => {
    test("removes session from memory", async () => {
      const manager = createTestManager();
      manager.getSession(1001);
      expect(manager.sessionCount).toBe(1);

      await manager.killSession(1001);
      expect(manager.sessionCount).toBe(0);
    });

    test("returns kill result with count", async () => {
      const manager = createTestManager();
      manager.getSession(1001);

      const result = await manager.killSession(1001);
      expect(result).toHaveProperty("count");
      expect(result).toHaveProperty("messages");
    });

    test("killing non-existent session is safe", async () => {
      const manager = createTestManager();
      const result = await manager.killSession(9999);
      expect(result.count).toBe(0);
    });
  });

  describe("cleanup — TTL expiry", () => {
    test("removes sessions older than TTL", () => {
      const manager = createTestManager();
      const session = manager.getSession(1001);

      // Simulate old activity (25 hours ago)
      session.lastActivity = new Date(Date.now() - 25 * 60 * 60 * 1000);

      expect(manager.sessionCount).toBe(1);
      manager.cleanup();
      expect(manager.sessionCount).toBe(0);
    });

    test("keeps sessions within TTL", () => {
      const manager = createTestManager();
      const session = manager.getSession(1001);

      // Recent activity (1 hour ago)
      session.lastActivity = new Date(Date.now() - 1 * 60 * 60 * 1000);

      manager.cleanup();
      expect(manager.sessionCount).toBe(1);
    });

    test("skips sessions with null lastActivity", () => {
      const manager = createTestManager();
      const session = manager.getSession(1001);
      session.lastActivity = null; // never used

      manager.cleanup();
      expect(manager.sessionCount).toBe(1); // not removed
    });
  });

  describe("cleanup — LRU eviction", () => {
    test("evicts oldest sessions when exceeding MAX_SESSIONS", () => {
      const manager = createTestManager();

      // Create 102 sessions (exceeds MAX_SESSIONS=100)
      for (let i = 0; i < 102; i++) {
        const session = manager.getSession(i + 1000);
        session.lastActivity = new Date(Date.now() - (102 - i) * 1000); // older first
      }

      expect(manager.sessionCount).toBe(102);
      manager.cleanup();
      expect(manager.sessionCount).toBeLessThanOrEqual(100);
    });
  });

  describe("getGlobalStats", () => {
    test("returns empty stats for no sessions", () => {
      const manager = createTestManager();
      const stats = manager.getGlobalStats();
      expect(stats.totalSessions).toBe(0);
      expect(stats.totalQueries).toBe(0);
    });

    test("aggregates stats across sessions", () => {
      const manager = createTestManager();
      const s1 = manager.getSession(1001);
      const s2 = manager.getSession(2002);

      s1.totalQueries = 5;
      s1.totalInputTokens = 100;
      s2.totalQueries = 3;
      s2.totalInputTokens = 200;

      const stats = manager.getGlobalStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.totalQueries).toBe(8);
      expect(stats.totalInputTokens).toBe(300);
    });
  });

  describe("getActiveSessionKeys", () => {
    test("returns all session keys", () => {
      const manager = createTestManager();
      manager.getSession(1001);
      manager.getSession(2002);

      const keys = manager.getActiveSessionKeys();
      expect(keys.length).toBe(2);
    });
  });

  describe("saveAllSessions", () => {
    test("saves all sessions to store", () => {
      const store = createInMemorySessionStore();
      const manager = createTestManager(store);

      manager.getSession(1001);
      manager.getSession(2002);

      manager.saveAllSessions();
      expect(store.saved.size).toBe(2);
    });
  });

  describe("stop", () => {
    test("saves sessions and cleans up", () => {
      const store = createInMemorySessionStore();
      const manager = createTestManager(store);

      manager.getSession(1001);
      manager.stop();

      expect(store.saved.size).toBe(1);
    });
  });
});
