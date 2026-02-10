import { Cron } from "croner";
import { existsSync, readFileSync, statSync } from "fs";
import type { Api } from "grammy";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import { ALLOWED_USERS, WORKING_DIR } from "../config";
import { getModelForContext, MODEL_DISPLAY_NAMES } from "../config/model";
import { escapeHtml } from "../formatting";
import { isPathAllowed } from "../security";
import type { CronConfig, CronSchedule } from "../types";
import type { StatusCallback } from "../types/runtime";
import { startFileWatcher, stopFileWatcher } from "./file-watcher";
import {
  processQueuedJobs as processQueuedJobsFromQueue,
  startQueueDrainTimer,
  stopQueueDrainTimer,
} from "./queue";
import { buildSchedulerRoute } from "./route";
import { getSchedulerRuntime } from "./runtime-boundary";

const DEFAULT_MAX_PROMPT_LENGTH = 10000;
const DEFAULT_MAX_JOBS_PER_HOUR = 60;
const DEFAULT_MAX_PENDING_QUEUE_SIZE = 100;
const DEFAULT_QUEUE_DRAIN_INTERVAL_MS = 2000;
const DEFAULT_FILE_WATCH_INTERVAL_MS = 2000;
const DEFAULT_FILE_WATCH_DEBOUNCE_MS = 100;

interface SchedulerLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface SchedulerQueueTimers {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

interface SchedulerWatcherTimers extends SchedulerQueueTimers {
  setTimeout: typeof setTimeout;
}

interface ScheduledJobHandle {
  stop(): void;
  nextRun(): Date | null | undefined;
}

export interface SchedulerServiceDependencies {
  cronConfigPath: string;
  maxPromptLength: number;
  maxJobsPerHour: number;
  maxPendingQueueSize: number;
  queueDrainIntervalMs: number;
  fileWatcherIntervalMs: number;
  fileWatcherDebounceMs: number;
  allowedUsers: ReadonlyArray<number>;
  now: () => number;
  createCronJob: (
    cronExpression: string,
    onTick: () => Promise<void>
  ) => ScheduledJobHandle;
  loadCronConfig: () => CronConfig | null;
  getRuntime: typeof getSchedulerRuntime;
  getModelForContext: typeof getModelForContext;
  modelDisplayNames: typeof MODEL_DISPLAY_NAMES;
  buildSchedulerRoute: typeof buildSchedulerRoute;
  escapeHtml: typeof escapeHtml;
  logger: SchedulerLogger;
  existsSync: typeof existsSync;
  statSync: typeof statSync;
  queueTimers: SchedulerQueueTimers;
  watcherTimers: SchedulerWatcherTimers;
}

function validateCronConfig(
  config: unknown,
  maxPromptLength: number,
  logger: SchedulerLogger
): config is CronConfig {
  if (!config || typeof config !== "object") {
    return false;
  }

  const candidate = config as Record<string, unknown>;
  if (!Array.isArray(candidate.schedules)) {
    return false;
  }

  for (const schedule of candidate.schedules) {
    if (!schedule || typeof schedule !== "object") {
      return false;
    }
    const entry = schedule as Record<string, unknown>;

    if (typeof entry.name !== "string" || !entry.name) {
      return false;
    }
    if (typeof entry.cron !== "string" || !entry.cron) {
      return false;
    }
    if (typeof entry.prompt !== "string" || !entry.prompt) {
      return false;
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      return false;
    }
    if (entry.notify !== undefined && typeof entry.notify !== "boolean") {
      return false;
    }

    if (entry.prompt.length > maxPromptLength) {
      logger.error(
        `[CRON] Prompt too long in ${entry.name}: ${entry.prompt.length} chars`
      );
      return false;
    }
  }

  return true;
}

function createDefaultCronConfigLoader(
  cronConfigPath: string,
  maxPromptLength: number,
  logger: SchedulerLogger
): () => CronConfig | null {
  return () => {
    if (!isPathAllowed(cronConfigPath)) {
      logger.error("[CRON] cron.yaml path not in allowed directories");
      return null;
    }

    if (!existsSync(cronConfigPath)) {
      logger.log(`No cron.yaml found at ${cronConfigPath}`);
      return null;
    }

    try {
      const content = readFileSync(cronConfigPath, "utf-8");
      const parsed = parseYaml(content);

      if (!validateCronConfig(parsed, maxPromptLength, logger)) {
        logger.error("[CRON] Invalid cron.yaml structure");
        return null;
      }

      return parsed;
    } catch (error) {
      logger.error(`Failed to parse cron.yaml: ${error}`);
      return null;
    }
  };
}

function createDefaultDependencies(): SchedulerServiceDependencies {
  const cronConfigPath = resolve(WORKING_DIR, "cron.yaml");
  const logger = console;

  return {
    cronConfigPath,
    maxPromptLength: DEFAULT_MAX_PROMPT_LENGTH,
    maxJobsPerHour: DEFAULT_MAX_JOBS_PER_HOUR,
    maxPendingQueueSize: DEFAULT_MAX_PENDING_QUEUE_SIZE,
    queueDrainIntervalMs: DEFAULT_QUEUE_DRAIN_INTERVAL_MS,
    fileWatcherIntervalMs: DEFAULT_FILE_WATCH_INTERVAL_MS,
    fileWatcherDebounceMs: DEFAULT_FILE_WATCH_DEBOUNCE_MS,
    allowedUsers: ALLOWED_USERS,
    now: () => Date.now(),
    createCronJob: (cronExpression, onTick) =>
      new Cron(cronExpression, async () => {
        await onTick();
      }),
    loadCronConfig: createDefaultCronConfigLoader(
      cronConfigPath,
      DEFAULT_MAX_PROMPT_LENGTH,
      logger
    ),
    getRuntime: getSchedulerRuntime,
    getModelForContext,
    modelDisplayNames: MODEL_DISPLAY_NAMES,
    buildSchedulerRoute,
    escapeHtml,
    logger,
    existsSync,
    statSync,
    queueTimers: {
      setInterval,
      clearInterval,
    },
    watcherTimers: {
      setInterval,
      clearInterval,
      setTimeout,
    },
  };
}

export interface SchedulerService {
  initScheduler(api: Api): void;
  startScheduler(): void;
  stopScheduler(): void;
  reloadScheduler(): number;
  getSchedulerStatus(): string;
  processQueuedJobs(): Promise<void>;
}

export function createSchedulerService(
  overrides: Partial<SchedulerServiceDependencies> = {}
): SchedulerService {
  const defaults = createDefaultDependencies();
  const dependencies: SchedulerServiceDependencies = {
    ...defaults,
    ...overrides,
    queueTimers: {
      ...defaults.queueTimers,
      ...overrides.queueTimers,
    },
    watcherTimers: {
      ...defaults.watcherTimers,
      ...overrides.watcherTimers,
    },
  };

  if (!overrides.loadCronConfig) {
    dependencies.loadCronConfig = createDefaultCronConfigLoader(
      dependencies.cronConfigPath,
      dependencies.maxPromptLength,
      dependencies.logger
    );
  }

  const activeJobs = new Map<string, ScheduledJobHandle>();
  const jobExecutions: number[] = [];
  const queueState = {
    pendingCronJobs: [] as Array<{ schedule: CronSchedule; timestamp: number }>,
    queueDrainTimer: null as Timer | null,
  };
  const fileWatcherState = {
    fileWatcher: null as Timer | null,
    lastModifiedTime: null as number | null,
  };

  let botApi: Api | null = null;
  let cronExecutionLock = false;

  function initScheduler(api: Api): void {
    botApi = api;
  }

  function checkRateLimit(): boolean {
    const now = dependencies.now();
    const oneHourAgo = now - 3600000;

    while (jobExecutions.length > 0 && jobExecutions[0]! < oneHourAgo) {
      jobExecutions.shift();
    }

    return jobExecutions.length < dependencies.maxJobsPerHour;
  }

  function startQueueDrainTimerInternal(): void {
    startQueueDrainTimer({
      state: queueState,
      drainIntervalMs: dependencies.queueDrainIntervalMs,
      onDrain: () => processQueuedJobsInternal(),
      onError: (error) => {
        dependencies.logger.error("[CRON] Queue drain failed:", error);
      },
      timers: dependencies.queueTimers,
    });
  }

  function stopQueueDrainTimerInternal(): void {
    stopQueueDrainTimer({
      state: queueState,
      timers: dependencies.queueTimers,
    });
  }

  async function executeScheduledPrompt(schedule: CronSchedule): Promise<void> {
    const { name, prompt, notify } = schedule;
    const cronModel = dependencies.getModelForContext("cron");
    const runtime = dependencies.getRuntime();
    dependencies.logger.log(
      `[CRON] Executing scheduled job: ${name} (model: ${dependencies.modelDisplayNames[cronModel]})`
    );

    if (cronExecutionLock || runtime.isBusy()) {
      if (queueState.pendingCronJobs.length >= dependencies.maxPendingQueueSize) {
        dependencies.logger.warn(
          `[CRON] Queue full (${dependencies.maxPendingQueueSize}), dropping oldest job`
        );
        queueState.pendingCronJobs.shift();
      }
      dependencies.logger.log(`[CRON] Session busy - queuing job: ${name}`);
      queueState.pendingCronJobs.push({
        schedule,
        timestamp: dependencies.now(),
      });
      startQueueDrainTimerInternal();
      return;
    }

    if (!checkRateLimit()) {
      dependencies.logger.log(`[CRON] Rate limit reached, skipping ${name}`);
      return;
    }

    cronExecutionLock = true;
    jobExecutions.push(dependencies.now());

    try {
      const statusCallback: StatusCallback = async (type, content) => {
        if (type === "tool") {
          dependencies.logger.log(`[CRON:${name}] Tool: ${content}`);
        }
      };

      const route = dependencies.buildSchedulerRoute(name);
      const userId = dependencies.allowedUsers[0] || 0;
      const result = await runtime.execute({
        prompt,
        sessionKey: route.sessionKey as string,
        userId,
        statusCallback,
        modelContext: "cron",
      });

      dependencies.logger.log(`[CRON] Job ${name} completed`);
      dependencies.logger.log(
        `[CRON:${name}] Prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}`
      );
      dependencies.logger.log(
        `[CRON:${name}] Response: ${result.slice(0, 500)}${result.length > 500 ? "..." : ""}`
      );

      if (notify && botApi && dependencies.allowedUsers.length > 0) {
        const notifyUserId = dependencies.allowedUsers[0]!;
        const safeName = dependencies.escapeHtml(name);
        const safeResult = dependencies.escapeHtml(result.slice(0, 3500));
        await botApi.sendMessage(
          notifyUserId,
          `🕐 <b>Scheduled: ${safeName}</b>\n\n${safeResult}`,
          { parse_mode: "HTML" }
        );
      }
    } catch (error) {
      dependencies.logger.error(`[CRON] Job ${name} failed: ${error}`);

      if (notify && botApi && dependencies.allowedUsers.length > 0) {
        const notifyUserId = dependencies.allowedUsers[0]!;
        const safeName = dependencies.escapeHtml(name);
        const safeError = dependencies.escapeHtml(String(error).slice(0, 500));
        try {
          await botApi.sendMessage(
            notifyUserId,
            `❌ <b>Scheduled job failed: ${safeName}</b>\n\n${safeError}`,
            { parse_mode: "HTML" }
          );
        } catch (notifyError) {
          dependencies.logger.error(
            `[CRON] Failed to notify user of job failure for ${name}: ${notifyError}`
          );
        }
      }
    } finally {
      cronExecutionLock = false;
      if (queueState.pendingCronJobs.length > 0) {
        processQueuedJobsInternal().catch((error) => {
          dependencies.logger.error("[CRON] Failed to process queued jobs:", error);
        });
        startQueueDrainTimerInternal();
      } else {
        stopQueueDrainTimerInternal();
      }
    }
  }

  function scheduleJobs(config: CronConfig, verbose: boolean): number {
    let loaded = 0;
    for (const schedule of config.schedules) {
      if (schedule.enabled === false) {
        if (verbose) {
          dependencies.logger.log(
            `[CRON] Skipping disabled schedule: ${schedule.name}`
          );
        }
        continue;
      }

      try {
        const job = dependencies.createCronJob(schedule.cron, async () => {
          await executeScheduledPrompt(schedule);
        });
        activeJobs.set(schedule.name, job);
        loaded += 1;

        if (verbose) {
          const nextRun = job.nextRun();
          dependencies.logger.log(
            `[CRON] Scheduled: ${schedule.name} (${schedule.cron}) - next: ${nextRun?.toLocaleString() || "never"}`
          );
        }
      } catch (error) {
        dependencies.logger.error(
          `[CRON] Failed to schedule ${schedule.name}: ${error}`
        );
      }
    }

    return loaded;
  }

  function stopFileWatcherInternal(): void {
    stopFileWatcher({
      state: fileWatcherState,
      timers: dependencies.watcherTimers,
      onStop: () => dependencies.logger.log("[CRON] File watcher stopped"),
    });
  }

  function startFileWatcherInternal(): void {
    startFileWatcher({
      state: fileWatcherState,
      configPath: dependencies.cronConfigPath,
      pollIntervalMs: dependencies.fileWatcherIntervalMs,
      debounceMs: dependencies.fileWatcherDebounceMs,
      existsSync: dependencies.existsSync,
      statSync: dependencies.statSync,
      onDetectedChange: () => {
        dependencies.logger.log("[CRON] Detected cron.yaml change, auto-reloading...");
      },
      onChange: () => {
        const count = reloadScheduler();
        if (count > 0) {
          dependencies.logger.log(`[CRON] Auto-reloaded ${count} jobs`);
        }
      },
      onError: (error) => {
        dependencies.logger.error(`[CRON] File watcher error: ${error}`);
      },
      onStart: () => dependencies.logger.log("[CRON] File watcher started"),
      onStop: () => dependencies.logger.log("[CRON] File watcher stopped"),
      timers: dependencies.watcherTimers,
    });
  }

  function startScheduler(): void {
    stopScheduler();

    const config = dependencies.loadCronConfig();
    if (!config || config.schedules.length === 0) {
      dependencies.logger.log("[CRON] No schedules configured");
      return;
    }

    dependencies.logger.log(`[CRON] Loading ${config.schedules.length} schedules`);
    const loaded = scheduleJobs(config, true);
    dependencies.logger.log(`[CRON] Started ${loaded} jobs`);
    startFileWatcherInternal();
  }

  function stopScheduler(): void {
    if (activeJobs.size > 0) {
      dependencies.logger.log(`[CRON] Stopping ${activeJobs.size} jobs`);
      for (const [, job] of activeJobs) {
        job.stop();
      }
      activeJobs.clear();
    }

    stopFileWatcherInternal();
    stopQueueDrainTimerInternal();
  }

  function reloadScheduler(): number {
    dependencies.logger.log("[CRON] Reloading configuration");
    stopScheduler();

    const config = dependencies.loadCronConfig();
    if (!config || config.schedules.length === 0) {
      return 0;
    }

    const loaded = scheduleJobs(config, false);
    dependencies.logger.log(`[CRON] Reloaded ${loaded} jobs`);
    startFileWatcherInternal();
    return loaded;
  }

  function getSchedulerStatus(): string {
    if (activeJobs.size === 0) {
      return "No scheduled jobs";
    }

    const lines = [`📅 <b>Scheduled Jobs (${activeJobs.size})</b>`];
    for (const [name, job] of activeJobs) {
      const nextRun = job.nextRun();
      const nextStr = nextRun
        ? nextRun.toLocaleString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        : "never";
      lines.push(`• ${name}: next at ${nextStr}`);
    }

    if (queueState.pendingCronJobs.length > 0) {
      lines.push(`\n⏳ <b>Queued Jobs (${queueState.pendingCronJobs.length})</b>`);
      for (const { schedule } of queueState.pendingCronJobs) {
        lines.push(`• ${schedule.name}`);
      }
    }

    return lines.join("\n");
  }

  async function processQueuedJobsInternal(): Promise<void> {
    return processQueuedJobsFromQueue({
      state: queueState,
      isBusy: () => cronExecutionLock || dependencies.getRuntime().isBusy(),
      executeJob: async (schedule) => {
        await executeScheduledPrompt(schedule);
      },
      onQueueNotEmpty: () => startQueueDrainTimerInternal(),
      onQueueEmpty: () => stopQueueDrainTimerInternal(),
      log: (message) => dependencies.logger.log(message),
    });
  }

  return {
    initScheduler,
    startScheduler,
    stopScheduler,
    reloadScheduler,
    getSchedulerStatus,
    processQueuedJobs: () => processQueuedJobsInternal(),
  };
}

const defaultSchedulerService = createSchedulerService();

export const initScheduler = (api: Api): void =>
  defaultSchedulerService.initScheduler(api);
export const startScheduler = (): void => defaultSchedulerService.startScheduler();
export const stopScheduler = (): void => defaultSchedulerService.stopScheduler();
export const reloadScheduler = (): number => defaultSchedulerService.reloadScheduler();
export const getSchedulerStatus = (): string =>
  defaultSchedulerService.getSchedulerStatus();
export const processQueuedJobs = (): Promise<void> =>
  defaultSchedulerService.processQueuedJobs();
