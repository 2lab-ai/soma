/**
 * Multi-session manager for Claude Telegram Bot.
 *
 * Manages multiple ClaudeSession instances keyed by tenant:channel:thread.
 * Supports TTL-based expiration and LRU eviction.
 */

import { CHAT_HISTORY_DATA_DIR, CHAT_HISTORY_ENABLED } from "../../config";
import { createProviderOrchestrator } from "../../providers/create-orchestrator";
import type { ProviderOrchestrator } from "../../providers/orchestrator";
import { ChatCaptureService } from "../../services/chat-capture-service";
import { FileChatStorage } from "../../storage/chat-storage";
import type { KillResult } from "../../types/session";
import {
  buildSessionKey,
  buildStoragePartitionKey,
  createSessionIdentity,
} from "../routing/session-key";
import { ClaudeSession } from "./session";
import { FileSessionStore, type SessionStore } from "./session-store";
import {
  SymlinkThreadWorkdirProvider,
  type ThreadWorkdirProvider,
} from "./thread-workdir";

const MAX_SESSIONS = 100;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_TENANT_ID = "default";
const TELEGRAM_MAIN_THREAD_ID = 1;

export interface SessionManagerOptions {
  sessionStore?: SessionStore;
  threadWorkdirProvider?: ThreadWorkdirProvider;
  chatCaptureService?: ChatCaptureService | null;
  providerOrchestrator?: ProviderOrchestrator | null;
  startCleanupTimer?: boolean;
}

/**
 * Manages multiple Claude sessions, one per chat/thread.
 */
export class SessionManager {
  private readonly sessions: Map<string, ClaudeSession> = new Map();
  private readonly sessionStore: SessionStore;
  private readonly threadWorkdirProvider: ThreadWorkdirProvider;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly chatCaptureService: ChatCaptureService | null;
  private providerOrchestrator: ProviderOrchestrator | null;

  constructor(options: SessionManagerOptions = {}) {
    this.sessionStore = options.sessionStore ?? new FileSessionStore();
    this.threadWorkdirProvider =
      options.threadWorkdirProvider ?? new SymlinkThreadWorkdirProvider();

    this.sessionStore.ensureDirectory();
    this.threadWorkdirProvider.ensureDirectory();

    this.chatCaptureService =
      options.chatCaptureService !== undefined
        ? options.chatCaptureService
        : this.initializeChatCapture();
    this.providerOrchestrator =
      options.providerOrchestrator !== undefined
        ? options.providerOrchestrator
        : createProviderOrchestrator();

    if (options.startCleanupTimer !== false) {
      this.startCleanupTimer();
    }
  }

  private initializeChatCapture(): ChatCaptureService | null {
    if (!CHAT_HISTORY_ENABLED) {
      console.log("[SessionManager] Chat history disabled");
      return null;
    }

    try {
      const storage = new FileChatStorage(CHAT_HISTORY_DATA_DIR);
      const captureService = new ChatCaptureService(storage);
      console.log(`[SessionManager] Chat history enabled (${CHAT_HISTORY_DATA_DIR})`);
      return captureService;
    } catch (error) {
      console.error("[SessionManager] Failed to initialize chat capture:", error);
      return null;
    }
  }

  /**
   * Derive canonical session key from chat/thread identity.
   * Format: "tenant:channel:thread"
   */
  deriveKey(chatId: number, threadId?: number): string {
    return this.buildRoute(chatId, threadId).sessionKey;
  }

  /**
   * Get or create a session for the given chat/thread.
   */
  getSession(chatId: number, threadId?: number): ClaudeSession {
    const route = this.buildRoute(chatId, threadId);
    const key = route.sessionKey;

    if (!this.sessions.has(key)) {
      const session = new ClaudeSession(key, this.chatCaptureService, {
        workingDir: this.threadWorkdirProvider.getThreadWorkingDir(
          route.storagePartitionKey
        ),
        providerOrchestrator: this.providerOrchestrator,
      });
      this.sessions.set(key, session);

      const loaded = this.sessionStore.loadSession(key);
      if (loaded) {
        session.restoreFromData(loaded);
        console.log(`[SessionManager] Loaded session for ${key}`);
      } else {
        console.log(`[SessionManager] Created new session for ${key}`);
      }
    }

    return this.sessions.get(key)!;
  }

  /**
   * Check if a session exists for the given chat/thread.
   */
  hasSession(chatId: number, threadId?: number): boolean {
    const key = this.deriveKey(chatId, threadId);
    return this.sessions.has(key) || this.sessionStore.sessionFileExists(key);
  }

  /**
   * Kill (clear) a specific session.
   * @returns Lost messages for recovery UI
   */
  async killSession(chatId: number, threadId?: number): Promise<KillResult> {
    const key = this.deriveKey(chatId, threadId);
    const session = this.sessions.get(key);

    let result: KillResult = { count: 0, messages: [] };
    if (session) {
      result = await session.kill();
      this.sessions.delete(key);
    }

    this.sessionStore.deleteSessionFile(key);

    console.log(
      `[SessionManager] Killed session for ${key}, lost ${result.count} messages`
    );
    return result;
  }

  /**
   * Get all active session keys.
   */
  getActiveSessionKeys(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get count of active sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get aggregated stats across all sessions.
   */
  getGlobalStats(): {
    totalSessions: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalQueries: number;
    sessions: Array<{
      sessionKey: string;
      queries: number;
      isRunning: boolean;
      isActive: boolean;
      lastActivity: Date;
    }>;
  } {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalQueries = 0;
    const sessionList: Array<{
      sessionKey: string;
      queries: number;
      isRunning: boolean;
      isActive: boolean;
      lastActivity: Date;
    }> = [];

    for (const [key, session] of this.sessions) {
      totalInputTokens += session.totalInputTokens;
      totalOutputTokens += session.totalOutputTokens;
      totalQueries += session.totalQueries;
      sessionList.push({
        sessionKey: key,
        queries: session.totalQueries,
        isRunning: session.isRunning,
        isActive: session.isActive,
        lastActivity: session.lastActivity || new Date(),
      });
    }

    sessionList.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());

    return {
      totalSessions: this.sessions.size,
      totalInputTokens,
      totalOutputTokens,
      totalQueries,
      sessions: sessionList,
    };
  }

  /**
   * Save all active sessions to disk.
   */
  saveAllSessions(): void {
    for (const [key, session] of this.sessions) {
      this.sessionStore.saveSession(key, session);
    }
    console.log(`[SessionManager] Saved ${this.sessions.size} sessions`);
  }

  /**
   * Load all persisted sessions from disk.
   */
  loadAllSessions(): void {
    const keys = this.sessionStore.listSessionKeys();
    let loadedCount = 0;

    for (const key of keys) {
      const data = this.sessionStore.loadSession(key);
      if (!data) {
        continue;
      }

      const session = new ClaudeSession(key, this.chatCaptureService, {
        workingDir: this.threadWorkdirProvider.getThreadWorkingDirFromSessionKey(key),
        providerOrchestrator: this.providerOrchestrator,
      });
      session.restoreFromData(data);
      this.sessions.set(key, session);
      loadedCount++;
    }

    console.log(`[SessionManager] Loaded ${loadedCount} sessions from disk`);
  }

  /**
   * Clean up expired sessions (TTL) and enforce max sessions (LRU).
   */
  cleanup(): void {
    const now = Date.now();
    const sessionsToRemove: string[] = [];

    for (const [key, session] of this.sessions) {
      if (!session.lastActivity) {
        continue;
      }
      const age = now - session.lastActivity.getTime();
      if (age > SESSION_TTL_MS) {
        sessionsToRemove.push(key);
      }
    }

    for (const key of sessionsToRemove) {
      const session = this.sessions.get(key);
      if (session) {
        this.sessionStore.saveSession(key, session);
      }
      this.sessions.delete(key);
      console.log(`[SessionManager] Removed expired session: ${key}`);
    }

    if (this.sessions.size > MAX_SESSIONS) {
      const sorted = Array.from(this.sessions.entries())
        .filter(([, session]) => session.lastActivity !== null)
        .sort((a, b) => {
          const aTime = a[1].lastActivity?.getTime() || 0;
          const bTime = b[1].lastActivity?.getTime() || 0;
          return aTime - bTime;
        });

      const toEvict = sorted.slice(0, sorted.length - MAX_SESSIONS);
      for (const [key, session] of toEvict) {
        this.sessionStore.saveSession(key, session);
        this.sessions.delete(key);
        console.log(`[SessionManager] Evicted LRU session: ${key}`);
      }
    }
  }

  /**
   * Stop the cleanup timer (for graceful shutdown).
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.saveAllSessions();
  }

  private toThreadIdentity(threadId?: number): string {
    if (!threadId || threadId === TELEGRAM_MAIN_THREAD_ID) {
      return "main";
    }
    return String(threadId);
  }

  private buildRoute(
    chatId: number,
    threadId?: number
  ): { sessionKey: string; storagePartitionKey: string } {
    const identity = createSessionIdentity({
      tenantId: DEFAULT_TENANT_ID,
      channelId: String(chatId),
      threadId: this.toThreadIdentity(threadId),
    });
    return {
      sessionKey: buildSessionKey(identity) as string,
      storagePartitionKey: buildStoragePartitionKey(identity) as string,
    };
  }

  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(
      () => {
        this.cleanup();
      },
      60 * 60 * 1000
    );
  }

  setProviderOrchestrator(orchestrator: ProviderOrchestrator | null): void {
    this.providerOrchestrator = orchestrator;
    for (const session of this.sessions.values()) {
      session.setProviderOrchestrator(orchestrator);
    }
  }
}

// Global session manager instance
export const sessionManager = new SessionManager();
