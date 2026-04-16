import type { ClaudeSession } from "./session";
import type { SessionData } from "../../types/session";

// Single source of truth for SessionData shape on disk. Both saveSession sites
// (session-store.ts and session.ts) must go through this helper so persisted
// sessions are byte-equal regardless of which code path wrote them.
export function serializeSessionData(session: ClaudeSession): SessionData {
  if (!session.sessionId) {
    throw new Error("Cannot serialize session without sessionId");
  }
  return {
    session_id: session.sessionId,
    saved_at: new Date().toISOString(),
    working_dir: session.workingDir,
    contextWindowUsage: session.contextWindowUsage,
    contextWindowSize: session.contextWindowSize,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    totalQueries: session.totalQueries,
    sessionStartTime: session.sessionStartTime?.toISOString(),
    lastUsedModel: session.getLastUsedModel() ?? undefined,
  };
}
