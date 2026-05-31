/**
 * RED-GREEN proof for fresh-session cron jobs.
 *
 * Bug: stateless daily cron jobs (e.g. daily-es-send) RESUME a persistent
 * `cron:scheduler:<name>` session every run. The SDK resume chain accumulates
 * across runs; under a 200K-window model (Haiku 4.5) the resumed transcript
 * eventually exceeds the window → `NormalizedProviderError: Prompt is too long`.
 *
 * Fix: a schedule may set `freshSession: true`. The runner then resets the
 * session (drops in-memory + persisted file) BEFORE getSessionByKey so each
 * run starts a brand-new SDK session and context never accumulates.
 *
 * These tests FAIL before the fix (createSchedulerExecute / resetSessionByKey
 * do not exist) and PASS after.
 */
import { describe, expect, mock, test } from "bun:test";
import { createSchedulerExecute } from "./scheduler-runner";
import type { SchedulerExecutionRequest } from "../scheduler/runtime-boundary";

function setup() {
  const calls: string[] = [];
  const session = {
    sendMessageStreaming: mock(async () => {
      calls.push("send");
      return "ok";
    }),
  };
  const manager = {
    getGlobalStats: () => ({ sessions: [] }),
    getSession: () => session,
    getSessionByKey: (key: string) => {
      calls.push(`getByKey:${key}`);
      return session;
    },
    resetSessionByKey: (key: string) => {
      calls.push(`reset:${key}`);
    },
  };
  return { calls, manager };
}

function buildRequest(
  overrides: Partial<SchedulerExecutionRequest> = {}
): SchedulerExecutionRequest {
  return {
    prompt: "run",
    sessionKey: "cron:scheduler:job",
    userId: 1,
    statusCallback: async () => {},
    modelContext: "cron",
    ...overrides,
  };
}

describe("scheduler execute — fresh session handling", () => {
  test("freshSession:true resets session before getSessionByKey, then sends", async () => {
    const { calls, manager } = setup();
    const execute = createSchedulerExecute(manager);

    const result = await execute(
      buildRequest({
        sessionKey: "cron:scheduler:daily-es-generate",
        freshSession: true,
      })
    );

    expect(result).toBe("ok");
    expect(calls).toEqual([
      "reset:cron:scheduler:daily-es-generate",
      "getByKey:cron:scheduler:daily-es-generate",
      "send",
    ]);
  });

  test("freshSession undefined preserves resume (no reset)", async () => {
    const { calls, manager } = setup();
    const execute = createSchedulerExecute(manager);

    await execute(buildRequest({ sessionKey: "cron:scheduler:heartbeat" }));

    expect(calls).toEqual(["getByKey:cron:scheduler:heartbeat", "send"]);
    expect(calls.some((c) => c.startsWith("reset:"))).toBe(false);
  });

  test("freshSession:false preserves resume (no reset)", async () => {
    const { calls, manager } = setup();
    const execute = createSchedulerExecute(manager);

    await execute(
      buildRequest({ sessionKey: "cron:scheduler:heartbeat", freshSession: false })
    );

    expect(calls.some((c) => c.startsWith("reset:"))).toBe(false);
  });
});
