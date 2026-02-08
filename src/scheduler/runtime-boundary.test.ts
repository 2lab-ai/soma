import { afterEach, describe, expect, test } from "bun:test";
import {
  configureSchedulerRuntime,
  getSchedulerRuntime,
  resetSchedulerRuntimeForTests,
} from "./runtime-boundary";

describe("scheduler runtime boundary", () => {
  afterEach(() => {
    resetSchedulerRuntimeForTests();
  });

  test("uses injected runtime execute/isBusy contract", async () => {
    const calls: string[] = [];
    configureSchedulerRuntime({
      isBusy: () => false,
      execute: async (request) => {
        calls.push(`${request.sessionKey}:${request.modelContext}`);
        return "ok";
      },
    });

    const runtime = getSchedulerRuntime();
    expect(runtime.isBusy()).toBe(false);
    const result = await runtime.execute({
      prompt: "run",
      sessionKey: "cron:scheduler:job",
      userId: 1,
      statusCallback: async () => {},
      modelContext: "cron",
    });
    expect(result).toBe("ok");
    expect(calls).toEqual(["cron:scheduler:job:cron"]);
  });

  test("throws when runtime is not configured", async () => {
    const runtime = getSchedulerRuntime();
    await expect(
      runtime.execute({
        prompt: "run",
        sessionKey: "cron:scheduler:job",
        userId: 1,
        statusCallback: async () => {},
        modelContext: "cron",
      })
    ).rejects.toThrow("Scheduler runtime boundary is not configured.");
  });
});
