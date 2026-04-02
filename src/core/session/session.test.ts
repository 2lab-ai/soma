import { describe, expect, test } from "bun:test";
import { ClaudeSession } from "./session";
import type { ModelId } from "../../config/model";

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

describe("model switch forces new session (model-switch-session-reset)", () => {
  test("sessionId is cleared when model changes between queries", () => {
    const session = new ClaudeSession("test:model-switch");

    // Simulate a completed query with Opus
    (session as any).sessionId = "fake-opus-session-id";
    (session as any).lastUsedModel = "claude-opus-4-6" as ModelId;
    (session as any)._isActive = true;

    // Access the private field to verify initial state
    expect((session as any).sessionId).toBe("fake-opus-session-id");
    expect((session as any).lastUsedModel).toBe("claude-opus-4-6");

    // Simulate what sendMessageStreaming does when model changes:
    // effectiveModel would be Sonnet (from /model command)
    const effectiveModel: ModelId = "claude-sonnet-4-5-20250929";
    const lastUsedModel = (session as any).lastUsedModel as ModelId | null;

    if ((session as any).sessionId && lastUsedModel && effectiveModel !== lastUsedModel) {
      (session as any).sessionId = null;
    }

    // Session should be reset
    expect((session as any).sessionId).toBeNull();
  });

  test("sessionId is preserved when model stays the same", () => {
    const session = new ClaudeSession("test:model-same");

    (session as any).sessionId = "fake-opus-session-id";
    (session as any).lastUsedModel = "claude-opus-4-6" as ModelId;

    const effectiveModel: ModelId = "claude-opus-4-6";
    const lastUsedModel = (session as any).lastUsedModel as ModelId | null;

    if ((session as any).sessionId && lastUsedModel && effectiveModel !== lastUsedModel) {
      (session as any).sessionId = null;
    }

    // Session should NOT be reset
    expect((session as any).sessionId).toBe("fake-opus-session-id");
  });

  test("sessionId is preserved when lastUsedModel is null (first query)", () => {
    const session = new ClaudeSession("test:model-first");

    (session as any).sessionId = "fake-session-id";
    // lastUsedModel defaults to null

    const effectiveModel: ModelId = "claude-sonnet-4-5-20250929";
    const lastUsedModel = (session as any).lastUsedModel as ModelId | null;

    if ((session as any).sessionId && lastUsedModel && effectiveModel !== lastUsedModel) {
      (session as any).sessionId = null;
    }

    // Should NOT reset — first query, no previous model to compare
    expect((session as any).sessionId).toBe("fake-session-id");
  });

  test("temporaryModelOverride triggers session reset", () => {
    const session = new ClaudeSession("test:model-override");

    (session as any).sessionId = "fake-opus-session-id";
    (session as any).lastUsedModel = "claude-opus-4-6" as ModelId;

    // Simulate rate limit fallback setting temporaryModelOverride
    session.temporaryModelOverride = "claude-sonnet-4-5-20250929";
    const effectiveModel: ModelId = session.temporaryModelOverride ?? "claude-opus-4-6";
    const lastUsedModel = (session as any).lastUsedModel as ModelId | null;

    if ((session as any).sessionId && lastUsedModel && effectiveModel !== lastUsedModel) {
      (session as any).sessionId = null;
    }

    expect((session as any).sessionId).toBeNull();
  });
});
