import { describe, expect, mock, test } from "bun:test";
import type { CronConfig, CronSchedule } from "../types";
import { createSchedulerService } from "./service";

interface SchedulerTestHarness {
  service: ReturnType<typeof createSchedulerService>;
  scheduledTicks: Array<() => Promise<void>>;
  stopCalls: Array<ReturnType<typeof mock>>;
  executeCalls: Array<{
    prompt: string;
    sessionKey: string;
    userId: number;
    modelContext: "cron";
  }>;
  setRuntimeBusy: (busy: boolean) => void;
  setConfig: (config: CronConfig | null) => void;
}

function buildSchedule(
  name: string,
  overrides: Partial<CronSchedule> = {}
): CronSchedule {
  return {
    name,
    cron: "*/5 * * * *",
    prompt: `run ${name}`,
    notify: false,
    ...overrides,
  };
}

function createHarness(initialConfig: CronConfig | null): SchedulerTestHarness {
  let config = initialConfig;
  let runtimeBusy = false;
  const scheduledTicks: Array<() => Promise<void>> = [];
  const stopCalls: Array<ReturnType<typeof mock>> = [];
  const executeCalls: Array<{
    prompt: string;
    sessionKey: string;
    userId: number;
    modelContext: "cron";
  }> = [];
  const queueSetInterval = ((
    _: Parameters<typeof setInterval>[0],
    _interval?: number
  ) => {
    return { id: "queue" } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  const watcherSetInterval = ((
    _: Parameters<typeof setInterval>[0],
    _interval?: number
  ) => {
    return { id: "watcher" } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  const watcherSetTimeout = ((handler: Parameters<typeof setTimeout>[0]) => {
    if (typeof handler === "function") {
      handler();
    }
    return { id: "timeout" } as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  const service = createSchedulerService({
    cronConfigPath: "/tmp/test-cron.yaml",
    maxPromptLength: 1000,
    maxJobsPerHour: 60,
    maxPendingQueueSize: 3,
    queueDrainIntervalMs: 10,
    fileWatcherIntervalMs: 10,
    fileWatcherDebounceMs: 0,
    allowedUsers: [4242],
    now: () => 1_700_000_000_000,
    loadCronConfig: () => config,
    createCronJob: (_expression, onTick) => {
      const stop = mock(() => {});
      stopCalls.push(stop);
      scheduledTicks.push(onTick);
      return {
        stop,
        nextRun: () => new Date("2026-02-10T12:00:00.000Z"),
      };
    },
    getRuntime: () => ({
      isBusy: () => runtimeBusy,
      execute: async (request) => {
        executeCalls.push({
          prompt: request.prompt,
          sessionKey: request.sessionKey,
          userId: request.userId,
          modelContext: request.modelContext,
        });
        return "ok";
      },
    }),
    getModelForContext: () => "test" as never,
    modelDisplayNames: {
      test: "Test Model",
    } as never,
    buildSchedulerRoute: (name: string) => ({
      identity: {
        tenantId: "cron",
        channelId: "scheduler",
        threadId: name,
      } as never,
      sessionKey: `cron:scheduler:${name}` as never,
      storagePartitionKey: `cron/scheduler/${name}` as never,
    }),
    escapeHtml: (value: string) => value,
    logger: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    existsSync: () => false,
    statSync: () => ({ mtimeMs: 0 }) as never,
    queueTimers: {
      setInterval: queueSetInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    },
    watcherTimers: {
      setInterval: watcherSetInterval,
      clearInterval: (() => {}) as typeof clearInterval,
      setTimeout: watcherSetTimeout,
    },
  });

  return {
    service,
    scheduledTicks,
    stopCalls,
    executeCalls,
    setRuntimeBusy: (busy) => {
      runtimeBusy = busy;
    },
    setConfig: (nextConfig) => {
      config = nextConfig;
    },
  };
}

describe("scheduler service", () => {
  test("loads enabled schedules and supports reload with stop/start semantics", () => {
    const harness = createHarness({
      schedules: [
        buildSchedule("daily-report"),
        buildSchedule("disabled-job", { enabled: false }),
      ],
    });

    harness.service.startScheduler();
    expect(harness.scheduledTicks).toHaveLength(1);
    expect(harness.service.getSchedulerStatus()).toContain("daily-report");

    harness.setConfig({
      schedules: [buildSchedule("daily-report"), buildSchedule("weekly-summary")],
    });
    const loaded = harness.service.reloadScheduler();

    expect(loaded).toBe(2);
    expect(harness.scheduledTicks).toHaveLength(3);
    expect(harness.stopCalls[0]).toHaveBeenCalledTimes(1);
  });

  test("queues jobs while busy and drains them once runtime is available", async () => {
    const harness = createHarness({
      schedules: [buildSchedule("queue-job")],
    });

    harness.service.startScheduler();
    harness.setRuntimeBusy(true);
    await harness.scheduledTicks[0]!();
    expect(harness.executeCalls).toHaveLength(0);
    expect(harness.service.getSchedulerStatus()).toContain("Queued Jobs (1)");

    harness.setRuntimeBusy(false);
    await harness.service.processQueuedJobs();

    expect(harness.executeCalls).toEqual([
      {
        prompt: "run queue-job",
        sessionKey: "cron:scheduler:queue-job",
        userId: 4242,
        modelContext: "cron",
      },
    ]);
    expect(harness.service.getSchedulerStatus()).not.toContain("Queued Jobs");
  });

  test("is executable in tests without initScheduler or bot startup", async () => {
    const harness = createHarness({
      schedules: [buildSchedule("no-bot", { notify: true })],
    });

    harness.service.startScheduler();
    await harness.scheduledTicks[0]!();

    expect(harness.executeCalls).toHaveLength(1);
  });
});
