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
    sessions: Array<{ isRunning: boolean }>;
  };
  getSession(userId: number): SchedulerSession;
}

export function configureAndStartScheduler(
  botApi: Api,
  manager: SchedulerSessionManager
): void {
  configureSchedulerRuntime({
    isBusy: () =>
      manager.getGlobalStats().sessions.some((session) => session.isRunning),
    execute: async ({ prompt, userId, statusCallback, modelContext }) => {
      const session = manager.getSession(userId);
      return session.sendMessageStreaming(prompt, statusCallback, userId, modelContext);
    },
  });

  initScheduler(botApi);
  startScheduler();
}

export function stopSchedulerRunner(): void {
  stopScheduler();
}
