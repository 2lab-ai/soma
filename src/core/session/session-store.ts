import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import type { SessionData } from "../../types/session";
import type { ClaudeSession } from "./session";

export const SESSIONS_DIR = "/tmp/soma-sessions";

export interface SessionStore {
  ensureDirectory(): void;
  getSessionFilePath(key: string): string;
  sessionFileExists(key: string): boolean;
  saveSession(key: string, session: ClaudeSession): void;
  loadSession(key: string): SessionData | null;
  listSessionKeys(): string[];
  deleteSessionFile(key: string): void;
}

function toFileKey(key: string): string {
  return key.replace(/:/g, "_");
}

function fromFileKey(fileKey: string): string {
  return fileKey.replace(/_/g, ":");
}

export function getSessionFilePath(key: string, sessionsDir = SESSIONS_DIR): string {
  return `${sessionsDir}/${toFileKey(key)}.json`;
}

export function sessionFileExists(key: string, sessionsDir = SESSIONS_DIR): boolean {
  return existsSync(getSessionFilePath(key, sessionsDir));
}

export function saveSession(
  key: string,
  session: ClaudeSession,
  sessionsDir = SESSIONS_DIR
): void {
  if (!session.sessionId) {
    return;
  }

  try {
    ensureSessionsDir(sessionsDir);
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
    writeFileSync(getSessionFilePath(key, sessionsDir), JSON.stringify(data), "utf-8");
  } catch (error) {
    console.warn(`[SessionStore] Failed to save session ${key}: ${error}`);
  }
}

export function loadSession(
  key: string,
  sessionsDir = SESSIONS_DIR
): SessionData | null {
  const filePath = getSessionFilePath(key, sessionsDir);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as SessionData;
  } catch (error) {
    console.warn(`[SessionStore] Failed to load session ${key}: ${error}`);
    return null;
  }
}

export function listSessionKeys(sessionsDir = SESSIONS_DIR): string[] {
  if (!existsSync(sessionsDir)) {
    return [];
  }
  return readdirSync(sessionsDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => fromFileKey(fileName.replace(/\.json$/, "")));
}

export function deleteSessionFile(key: string, sessionsDir = SESSIONS_DIR): void {
  const filePath = getSessionFilePath(key, sessionsDir);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

export function ensureSessionsDir(sessionsDir = SESSIONS_DIR): void {
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly sessionsDir = SESSIONS_DIR) {}

  ensureDirectory(): void {
    ensureSessionsDir(this.sessionsDir);
  }

  getSessionFilePath(key: string): string {
    return getSessionFilePath(key, this.sessionsDir);
  }

  sessionFileExists(key: string): boolean {
    return sessionFileExists(key, this.sessionsDir);
  }

  saveSession(key: string, session: ClaudeSession): void {
    saveSession(key, session, this.sessionsDir);
  }

  loadSession(key: string): SessionData | null {
    return loadSession(key, this.sessionsDir);
  }

  listSessionKeys(): string[] {
    return listSessionKeys(this.sessionsDir);
  }

  deleteSessionFile(key: string): void {
    deleteSessionFile(key, this.sessionsDir);
  }
}
