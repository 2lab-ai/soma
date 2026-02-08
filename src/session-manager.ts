/**
 * Multi-session manager for Claude Telegram Bot.
 *
 * Manages multiple ClaudeSession instances keyed by tenant:channel:thread.
 * Supports TTL-based expiration and LRU eviction.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  readFileSync,
  symlinkSync,
} from "fs";
import { ClaudeSession } from "./session";
import type { KillResult, SessionData } from "./types";
import { ChatCaptureService } from "./services/chat-capture-service";
import { FileChatStorage } from "./storage/chat-storage";
import { CHAT_HISTORY_ENABLED, CHAT_HISTORY_DATA_DIR, WORKING_DIR } from "./config";
import {
  buildSessionKey,
  buildStoragePartitionKey,
  createSessionIdentity,
  parseSessionKey,
} from "./routing/session-key";

const SESSIONS_DIR = "/tmp/soma-sessions";
const THREAD_WORKDIRS_DIR = "/tmp/soma-thread-workdirs";
const MAX_SESSIONS = 100;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_TENANT_ID = "default";
const TELEGRAM_MAIN_THREAD_ID = 1;

export interface SessionKey {
  chatId: number;
  threadId?: number;
}

/**
 * Manages multiple Claude sessions, one per chat/thread.
 */
class SessionManager {
  private sessions: Map<string, ClaudeSession> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private chatCaptureService: ChatCaptureService | null = null;

  constructor() {
    this.ensureSessionsDir();
    this.initializeChatCapture();
    this.startCleanupTimer();
  }

  private initializeChatCapture() {
    if (!CHAT_HISTORY_ENABLED) {
      console.log("[SessionManager] Chat history disabled");
      return;
    }

    try {
      const storage = new FileChatStorage(CHAT_HISTORY_DATA_DIR);
      this.chatCaptureService = new ChatCaptureService(storage);
      console.log(`[SessionManager] Chat history enabled (${CHAT_HISTORY_DATA_DIR})`);
    } catch (error) {
      console.error("[SessionManager] Failed to initialize chat capture:", error);
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
        workingDir: this.getThreadWorkingDir(route.storagePartitionKey),
      });
      this.sessions.set(key, session);

      // Load persisted session for canonical key only.
      const loaded = this.loadSession(key);
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
    return this.sessions.has(key) || this.sessionFileExists(key);
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

    // Delete persisted file
    const filePath = this.getSessionFilePath(key);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }

    console.log(`[SessionManager] Killed session for ${key}, lost ${result.count} messages`);
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

    // Sort by last activity (most recent first)
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
      this.saveSession(key, session);
    }
    console.log(`[SessionManager] Saved ${this.sessions.size} sessions`);
  }

  /**
   * Load all persisted sessions from disk.
   */
  loadAllSessions(): void {
    if (!existsSync(SESSIONS_DIR)) return;

    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    let loadedCount = 0;

    for (const file of files) {
      const key = file.replace(".json", "").replace(/_/g, ":");
      const data = this.loadSession(key);

      if (data) {
        const session = new ClaudeSession(key, this.chatCaptureService, {
          workingDir: this.getThreadWorkingDirFromSessionKey(key),
        });
        session.restoreFromData(data);
        this.sessions.set(key, session);
        loadedCount++;
      }
    }

    console.log(`[SessionManager] Loaded ${loadedCount} sessions from disk`);
  }

  /**
   * Clean up expired sessions (TTL) and enforce max sessions (LRU).
   */
  cleanup(): void {
    const now = Date.now();
    const sessionsToRemove: string[] = [];

    // Find expired sessions
    for (const [key, session] of this.sessions) {
      if (session.lastActivity) {
        const age = now - session.lastActivity.getTime();
        if (age > SESSION_TTL_MS) {
          sessionsToRemove.push(key);
        }
      }
    }

    // Remove expired sessions
    for (const key of sessionsToRemove) {
      const session = this.sessions.get(key);
      if (session) {
        this.saveSession(key, session); // Save before removing
      }
      this.sessions.delete(key);
      console.log(`[SessionManager] Removed expired session: ${key}`);
    }

    // LRU eviction if still over limit
    if (this.sessions.size > MAX_SESSIONS) {
      const sorted = Array.from(this.sessions.entries())
        .filter(([, s]) => s.lastActivity !== null)
        .sort((a, b) => {
          const aTime = a[1].lastActivity?.getTime() || 0;
          const bTime = b[1].lastActivity?.getTime() || 0;
          return aTime - bTime;
        });

      const toEvict = sorted.slice(0, sorted.length - MAX_SESSIONS);
      for (const [key, session] of toEvict) {
        this.saveSession(key, session);
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

  // --- Private methods ---

  private ensureSessionsDir(): void {
    if (!existsSync(SESSIONS_DIR)) {
      mkdirSync(SESSIONS_DIR, { recursive: true });
    }
    if (!existsSync(THREAD_WORKDIRS_DIR)) {
      mkdirSync(THREAD_WORKDIRS_DIR, { recursive: true });
    }
  }

  private getSessionFilePath(key: string): string {
    // Sanitize key for filename (replace : with _)
    const safeKey = key.replace(/:/g, "_");
    return `${SESSIONS_DIR}/${safeKey}.json`;
  }

  private getThreadWorkingDir(storagePartitionKey: string): string {
    const aliasName = storagePartitionKey.replace(/\//g, "__");
    const aliasPath = `${THREAD_WORKDIRS_DIR}/${aliasName}`;
    if (existsSync(aliasPath)) {
      return aliasPath;
    }

    try {
      symlinkSync(WORKING_DIR, aliasPath, "dir");
      return aliasPath;
    } catch (error) {
      console.warn(`[SessionManager] Failed to create thread workdir for ${aliasName}: ${error}`);
      return WORKING_DIR;
    }
  }

  private getThreadWorkingDirFromSessionKey(key: string): string {
    try {
      const identity = parseSessionKey(key);
      return this.getThreadWorkingDir(buildStoragePartitionKey(identity) as string);
    } catch {
      return WORKING_DIR;
    }
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

  private sessionFileExists(key: string): boolean {
    return existsSync(this.getSessionFilePath(key));
  }

  private saveSession(key: string, session: ClaudeSession): void {
    if (!session.sessionId) return;

    try {
      const data: SessionData = {
        session_id: session.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: session.workingDir,
        contextWindowUsage: session.contextWindowUsage,
        contextWindowSize: session.contextWindowSize,
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalQueries: session.totalQueries,
        sessionStartTime: session.sessionStartTime?.toISOString(),
      };

      const filePath = this.getSessionFilePath(key);
      Bun.write(filePath, JSON.stringify(data));
    } catch (error) {
      console.warn(`[SessionManager] Failed to save session ${key}: ${error}`);
    }
  }

  private loadSession(key: string): SessionData | null {
    const filePath = this.getSessionFilePath(key);

    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const text = readFileSync(filePath, "utf-8");
      return JSON.parse(text) as SessionData;
    } catch (error) {
      console.warn(`[SessionManager] Failed to load session ${key}: ${error}`);
      return null;
    }
  }

  private startCleanupTimer(): void {
    // Run cleanup every hour
    this.cleanupInterval = setInterval(
      () => {
        this.cleanup();
      },
      60 * 60 * 1000
    );
  }
}

// Global session manager instance
export const sessionManager = new SessionManager();
