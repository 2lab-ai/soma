import { describe, expect, test } from "bun:test";
import { ClaudeSession } from "./session";

describe("core/session/session", () => {
  test("creates working session instance from core path", () => {
    const session = new ClaudeSession("core-session-test");
    expect(session.isActive).toBe(false);
    expect(session.activityState).toBe("idle");
  });
});

describe("sendMessageStreaming re-entrancy guard (soma-fkx2)", () => {
  test("throws when called while already running", async () => {
    const session = new ClaudeSession("test:reentrant:guard");
    (session as any)._queryState = "running";

    await expect(
      session.sendMessageStreaming("test", async () => {}, 1)
    ).rejects.toThrow("sendMessageStreaming is already running");
  });

  test("allows call when idle (isRunning is false)", () => {
    const session = new ClaudeSession("test:reentrant:idle");
    expect(session.isRunning).toBe(false);
    expect(session.queryState).toBe("idle");
  });

  test("BUG soma-ps2x: preparing is busy but does not count as already running", () => {
    const session = new ClaudeSession("test:reentrant:preparing");
    (session as any)._queryState = "preparing";

    expect(session.isProcessing).toBe(true);
    expect(session.isRunning).toBe(false);
  });

  test("rejects for active runtime query states", async () => {
    const session = new ClaudeSession("test:reentrant:states");

    for (const state of ["running", "aborting", "completing"] as const) {
      (session as any)._queryState = state;
      expect(session.isRunning).toBe(true);

      await expect(
        session.sendMessageStreaming("test", async () => {}, 1)
      ).rejects.toThrow("already running");

      // Reset for next iteration
      (session as any)._queryState = "idle";
    }
  });

  test("BUG soma-qivc: runSerializedQuery serializes concurrent tasks", async () => {
    const session = new ClaudeSession("test:serialized:queries");
    const runSerializedQuery = (session as any).runSerializedQuery;

    expect(typeof runSerializedQuery).toBe("function");
    if (typeof runSerializedQuery !== "function") {
      return;
    }

    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const makeTask = (label: string, delayMs: number) =>
      runSerializedQuery.call(session, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`${label}:start`);
        await Bun.sleep(delayMs);
        events.push(`${label}:end`);
        active -= 1;
        return label;
      });

    const results = await Promise.all([
      makeTask("first", 20),
      makeTask("second", 1),
      makeTask("third", 1),
    ]);

    expect(results).toEqual(["first", "second", "third"]);
    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
      "third:start",
      "third:end",
    ]);
  });
});
