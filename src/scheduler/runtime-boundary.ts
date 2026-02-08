import type { StatusCallback } from "../types";

export interface SchedulerExecutionRequest {
  readonly prompt: string;
  readonly sessionKey: string;
  readonly userId: number;
  readonly statusCallback: StatusCallback;
  readonly modelContext: "cron";
}

export interface SchedulerRuntimeBoundary {
  isBusy(): boolean;
  execute(request: SchedulerExecutionRequest): Promise<string>;
}

const defaultRuntimeBoundary: SchedulerRuntimeBoundary = {
  isBusy: () => false,
  execute: async () => {
    throw new Error("Scheduler runtime boundary is not configured.");
  },
};

let schedulerRuntimeBoundary: SchedulerRuntimeBoundary = defaultRuntimeBoundary;

export function configureSchedulerRuntime(boundary: SchedulerRuntimeBoundary): void {
  schedulerRuntimeBoundary = boundary;
}

export function getSchedulerRuntime(): SchedulerRuntimeBoundary {
  return schedulerRuntimeBoundary;
}

export function resetSchedulerRuntimeForTests(): void {
  schedulerRuntimeBoundary = defaultRuntimeBoundary;
}
