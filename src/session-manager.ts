/**
 * Multi-session manager for Claude Telegram Bot.
 *
 * Manages multiple ClaudeSession instances keyed by chatId or chatId:threadId.
 * Supports TTL-based expiration and LRU eviction.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync } from "fs";
import { ClaudeSession } from "./session";
import type { SessionData } from "./types";
import { ChatCaptureService } from "./services/chat-capture-service";
import { FileChatStorage } from "./storage/chat-storage";
import { CHAT_HISTORY_ENABLED, CHAT_HISTORY_DATA_DIR } from "./config";

const SESSIONS_DIR = "/tmp/soma-sessions";
const LEGACY_SESSION_FILE = "/tmp/soma-session.json";
const MAX_SESSIONS = 100;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    this.migrateLegacySession();
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
   * Derive session key from chatId and optional threadId.
   * Format: "{chatId}" or "{chatId}:{threadId}"
   */
  deriveKey(chatId: number, threadId?: number): string {
    if (threadId && threadId !== 1) {
      // threadId 1 is "General" topic, treat as main chat
      return `${chatId}:${threadId}`;
    }
    return String(chatId);
  }

  /**
   * Get or create a session for the given chat/thread.
   */
  getSession(chatId: number, threadId?: number): ClaudeSession {
    const key = this.deriveKey(chatId, threadId);

    if (!this.sessions.has(key)) {
      const session = new ClaudeSession(key, this.chatCaptureService);
      this.sessions.set(key, session);

      // Try to load persisted session
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
   */
  async killSession(chatId: number, threadId?: number): Promise<void> {
    const key = this.deriveKey(chatId, threadId);
    const session = this.sessions.get(key);

    if (session) {
      await session.kill();
      this.sessions.delete(key);
    }

    // Delete persisted file
    const filePath = this.getSessionFilePath(key);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }

    console.log(`[SessionManager] Killed session for ${key}`);
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
      const key = file.replace(".json", "");
      const data = this.loadSession(key);

      if (data) {
        const session = new ClaudeSession(key);
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
  }

  private getSessionFilePath(key: string): string {
    // Sanitize key for filename (replace : with _)
    const safeKey = key.replace(/:/g, "_");
    return `${SESSIONS_DIR}/${safeKey}.json`;
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

  private migrateLegacySession(): void {
    if (!existsSync(LEGACY_SESSION_FILE)) return;

    try {
      const text = readFileSync(LEGACY_SESSION_FILE, "utf-8");
      const data = JSON.parse(text) as SessionData;

      if (data.session_id) {
        // We don't know the original chatId, so we can't migrate automatically
        // The legacy session will be picked up on first use from the first private chat
        console.log(
          "[SessionManager] Legacy session found - will migrate on first private chat use"
        );
      }
    } catch (error) {
      console.warn(`[SessionManager] Failed to read legacy session: ${error}`);
    }
  }

  /**
   * Migrate legacy session to a specific chat (called on first private chat message).
   */
  migrateLegacyToChat(chatId: number): boolean {
    if (!existsSync(LEGACY_SESSION_FILE)) return false;

    try {
      const text = readFileSync(LEGACY_SESSION_FILE, "utf-8");
      const data = JSON.parse(text) as SessionData;

      if (!data.session_id) return false;

      // Save to new location
      const key = String(chatId);
      const newPath = this.getSessionFilePath(key);

      Bun.write(newPath, text);
      unlinkSync(LEGACY_SESSION_FILE);

      console.log(`[SessionManager] Migrated legacy session to chat ${chatId}`);
      return true;
    } catch (error) {
      console.warn(`[SessionManager] Failed to migrate legacy session: ${error}`);
      return false;
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
