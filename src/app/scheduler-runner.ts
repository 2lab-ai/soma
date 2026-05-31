import type { Api } from "grammy";
import type { ConfigContext } from "../config/model";
import type { StatusCallback } from "../types/runtime";
import {
  configureSchedulerRuntime,
  type SchedulerExecutionRequest,
} from "../scheduler/runtime-boundary";
import { initScheduler, startScheduler, stopScheduler } from "../scheduler/service";

interface SchedulerSession {
  sendMessageStreaming(
    prompt: string,
    statusCallback: StatusCallback,
    chatId?: number,
    modelContext?: ConfigContext
  ): Promise<string>;
}

interface SchedulerSessionManager {
  getGlobalStats(): {
    sessions: Array<{ sessionKey: string; isRunning: boolean }>;
  };
  getSession(userId: number): SchedulerSession;
  getSessionByKey(sessionKey: string): SchedulerSession;
  resetSessionByKey(sessionKey: string): void;
}

const SCHEDULER_SESSION_KEY_PREFIX = "cron:";

/**
 * Build the scheduler execute() implementation bound to a session manager.
 *
 * Routes each cron job to its dedicated session key (cron:scheduler:jobname)
 * so cron and user sessions never block each other. When the request asks for
 * a fresh session, the persistent session is reset first so the run starts a
 * brand-new SDK session (no resume chain) — this keeps stateless daily jobs
 * from accumulating context across runs and overflowing the model window.
 */
export function createSchedulerExecute(
  manager: SchedulerSessionManager
): (request: SchedulerExecutionRequest) => Promise<string> {
  return async ({
    prompt,
    sessionKey,
    userId,
    statusCallback,
    modelContext,
    freshSession,
  }) => {
    if (freshSession) {
      manager.resetSessionByKey(sessionKey);
    }
    const session = manager.getSessionByKey(sessionKey);
    return session.sendMessageStreaming(prompt, statusCallback, userId, modelContext);
  };
}

export function configureAndStartScheduler(
  botApi: Api,
  manager: SchedulerSessionManager
): void {
  configureSchedulerRuntime({
    isBusy: () => {
      // Only check if a cron session is already running (not user sessions).
      // Cron jobs run in their own isolated sessions, so user activity
      // should never block cron execution and vice versa.
      const stats = manager.getGlobalStats();
      return stats.sessions.some(
        (session) =>
          session.isRunning &&
          session.sessionKey.startsWith(SCHEDULER_SESSION_KEY_PREFIX)
      );
    },
    execute: createSchedulerExecute(manager),
  });

  initScheduler(botApi);
  startScheduler();
}

export function stopSchedulerRunner(): void {
  stopScheduler();
}
