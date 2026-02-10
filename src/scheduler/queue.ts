import type { CronSchedule } from "../types";

export interface PendingCronJob {
  schedule: CronSchedule;
  timestamp: number;
}

export interface SchedulerQueueState {
  pendingCronJobs: PendingCronJob[];
  queueDrainTimer: Timer | null;
}

interface QueueTimers {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

export interface StartQueueDrainTimerOptions {
  state: SchedulerQueueState;
  drainIntervalMs: number;
  onDrain: () => Promise<void>;
  onError?: (error: unknown) => void;
  timers?: QueueTimers;
}

export function startQueueDrainTimer(options: StartQueueDrainTimerOptions): void {
  if (options.state.queueDrainTimer) {
    return;
  }

  const timers = options.timers ?? {
    setInterval,
    clearInterval,
  };

  options.state.queueDrainTimer = timers.setInterval(() => {
    options.onDrain().catch((error) => {
      options.onError?.(error);
    });
  }, options.drainIntervalMs);
}

export interface StopQueueDrainTimerOptions {
  state: SchedulerQueueState;
  timers?: QueueTimers;
}

export function stopQueueDrainTimer(options: StopQueueDrainTimerOptions): void {
  if (!options.state.queueDrainTimer) {
    return;
  }

  const timers = options.timers ?? {
    setInterval,
    clearInterval,
  };
  timers.clearInterval(options.state.queueDrainTimer);
  options.state.queueDrainTimer = null;
}

export interface ProcessQueuedJobsOptions {
  state: SchedulerQueueState;
  isBusy: () => boolean;
  executeJob: (schedule: CronSchedule) => Promise<void>;
  onQueueNotEmpty: () => void;
  onQueueEmpty: () => void;
  log?: (message: string) => void;
}

export async function processQueuedJobs(
  options: ProcessQueuedJobsOptions
): Promise<void> {
  if (options.state.pendingCronJobs.length === 0) {
    options.onQueueEmpty();
    return;
  }

  if (options.isBusy()) {
    options.onQueueNotEmpty();
    return;
  }

  const job = options.state.pendingCronJobs.shift();
  if (!job) {
    options.onQueueEmpty();
    return;
  }

  options.log?.(`[CRON] Processing queued job: ${job.schedule.name}`);
  await options.executeJob(job.schedule);

  if (options.state.pendingCronJobs.length > 0) {
    options.log?.(
      `[CRON] ${options.state.pendingCronJobs.length} jobs remaining in queue`
    );
    options.onQueueNotEmpty();
  } else {
    options.onQueueEmpty();
  }
}
