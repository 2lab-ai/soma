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
    (session as any)._queryState = "preparing";

    await expect(
      session.sendMessageStreaming("test", async () => {}, 1)
    ).rejects.toThrow("sendMessageStreaming is already running");
  });

  test("allows call when idle (isRunning is false)", () => {
    const session = new ClaudeSession("test:reentrant:idle");
    expect(session.isRunning).toBe(false);
    expect(session.queryState).toBe("idle");
  });

  test("rejects for all non-idle query states", async () => {
    const session = new ClaudeSession("test:reentrant:states");

    for (const state of ["preparing", "running", "responding"] as const) {
      (session as any)._queryState = state;
      expect(session.isRunning).toBe(true);

      await expect(
        session.sendMessageStreaming("test", async () => {}, 1)
      ).rejects.toThrow("already running");

      // Reset for next iteration
      (session as any)._queryState = "idle";
    }
  });
});
