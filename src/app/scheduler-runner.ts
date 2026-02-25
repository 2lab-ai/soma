import type { Api } from "grammy";
import type { ConfigContext } from "../config/model";
import type { StatusCallback } from "../types/runtime";
import { configureSchedulerRuntime } from "../scheduler/runtime-boundary";
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
}

const SCHEDULER_SESSION_KEY_PREFIX = "cron:";

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
    execute: async ({ prompt, sessionKey, userId, statusCallback, modelContext }) => {
      // Use the scheduler's dedicated session key (cron:scheduler:jobname)
      // instead of the user's session. This prevents cron jobs from
      // blocking user messages and vice versa.
      const session = manager.getSessionByKey(sessionKey);
      return session.sendMessageStreaming(prompt, statusCallback, userId, modelContext);
    },
  });

  initScheduler(botApi);
  startScheduler();
}

export function stopSchedulerRunner(): void {
  stopScheduler();
}
