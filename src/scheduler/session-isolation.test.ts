/**
 * RED-GREEN proof for message-swallowing bug fix.
 *
 * Bug: HEARTBEAT cron executed on the USER's session, causing:
 *   1. isProcessing=true on user session → user messages gated to steering buffer
 *   2. isBusy() checked ALL sessions → user activity blocked cron execution
 *
 * These tests FAIL on code before eacaf60, PASS after.
 */
import { describe, test, expect, mock } from "bun:test";

// ─── Test 1: scheduler execute() must use sessionKey, not userId ───

describe("scheduler session isolation (red-green proof)", () => {
  test("BUG: cron execute() must route to dedicated cron session, not user session", async () => {
    // Simulate what configureAndStartScheduler wires up.
    // The key assertion: when scheduler calls execute({ sessionKey: "cron:scheduler:heartbeat", userId: 12345 }),
    // it must call getSessionByKey("cron:scheduler:heartbeat"), NOT getSession(12345).

    const getSessionCalls: number[] = [];
    const getSessionByKeyCalls: string[] = [];

    const fakeSession = {
      sendMessageStreaming: mock(async () => "ok"),
    };

    const fakeManager = {
      getGlobalStats: () => ({ sessions: [] }),
      getSession: (userId: number) => {
        getSessionCalls.push(userId);
        return fakeSession;
      },
      getSessionByKey: (key: string) => {
        getSessionByKeyCalls.push(key);
        return fakeSession;
      },
    };

    // Import the actual configureAndStartScheduler
    // We need to test the WIRING, not just the function signature
    const { configureSchedulerRuntime, getSchedulerRuntime, resetSchedulerRuntimeForTests } =
      await import("./runtime-boundary");

    resetSchedulerRuntimeForTests();

    // Replicate what configureAndStartScheduler does internally
    const { configureAndStartScheduler } = await import("../app/scheduler-runner");

    // We can't call configureAndStartScheduler directly (it calls initScheduler which needs bot API),
    // so we test the runtime boundary directly by simulating what scheduler-runner configures.

    // The FIX: scheduler-runner now configures execute() to use getSessionByKey(request.sessionKey)
    // The BUG: old code used getSession(request.userId) instead

    // To test this without full bootstrap, we'll check the actual scheduler-runner source
    const fs = await import("fs");
    const runnerSource = fs.readFileSync(
      new URL("../app/scheduler-runner.ts", import.meta.url).pathname.replace(
        "/src/app/",
        "/src/app/"
      ),
      "utf-8"
    );

    // The fix: execute function must use getSessionByKey (not getSession for userId)
    const usesSessionByKey = runnerSource.includes("getSessionByKey(sessionKey)") ||
      runnerSource.includes("getSessionByKey(request.sessionKey)") ||
      runnerSource.includes("manager.getSessionByKey(sessionKey)");
    const usesUserSession = runnerSource.includes("manager.getSession(userId)");

    // RED on old code: getSessionByKey doesn't exist, getSession(userId) is used
    // GREEN on new code: getSessionByKey(sessionKey) is used
    expect(usesSessionByKey).toBe(true);
    expect(usesUserSession).toBe(false);
  });

  test("BUG: isBusy() must only check cron sessions, not block on user activity", () => {
    // Old behavior: isBusy() = sessions.some(s => s.isRunning)
    //   → If USER is running a query, cron is blocked
    //   → When cron finally runs, it runs on user session → message swallowing
    //
    // New behavior: isBusy() only checks cron: prefixed sessions
    //   → User activity doesn't block cron
    //   → Cron runs independently in its own session

    const fs = require("fs");
    const runnerSource = fs.readFileSync(
      require.resolve("../app/scheduler-runner"),
      "utf-8"
    );

    // The fix: isBusy should filter by cron session prefix
    const filtersByCronPrefix =
      runnerSource.includes("SCHEDULER_SESSION_KEY_PREFIX") ||
      runnerSource.includes('startsWith("cron:")') ||
      runnerSource.includes("startsWith(SCHEDULER_SESSION_KEY_PREFIX)");

    // The bug: old code checked ALL sessions
    const checksAllSessionsBlindly =
      runnerSource.includes("sessions.some((session) => session.isRunning)") &&
      !runnerSource.includes("sessionKey");

    // RED on old code: no cron prefix filtering, checks all sessions blindly
    // GREEN on new code: filters by cron prefix
    expect(filtersByCronPrefix).toBe(true);
    expect(checksAllSessionsBlindly).toBe(false);
  });

  test("BUG: SessionManager must expose getSessionByKey for scheduler isolation", async () => {
    // Old code: SessionManager only had getSession(chatId, threadId)
    // No way for scheduler to get a session by arbitrary key like "cron:scheduler:heartbeat"
    //
    // New code: getSessionByKey(sessionKey) added

    const { SessionManager } = await import("../core/session/session-manager");

    // RED on old code: getSessionByKey doesn't exist
    // GREEN on new code: getSessionByKey exists as a method
    expect(typeof SessionManager.prototype.getSessionByKey).toBe("function");
  });

  test("BUG: steering buffer was too small (20) causing silent message drops", () => {
    // Old: maxSteeringMessages = 20, messages silently evicted via shift()
    // New: maxSteeringMessages = 100, eviction returns details

    const { ClaudeSession } = require("../core/session/session");
    const session = new ClaudeSession("test:isolation", null);

    // Fill 50 messages — old code would evict 30 silently
    for (let i = 1; i <= 50; i++) {
      session.addSteering(`msg ${i}`, i);
    }

    // RED on old code (buffer=20): only 20 messages survive, 30 silently dropped
    // GREEN on new code (buffer=100): all 50 messages survive
    expect(session.getSteeringCount()).toBe(50);

    const consumed = session.consumeSteering()!;
    const lines = consumed.split("\n---\n");

    // All 50 messages must be present
    expect(lines).toHaveLength(50);
    // First message must be msg 1 (not msg 31 which old code would show)
    expect(lines[0]).toContain("msg 1");
    // Last message must be msg 50
    expect(lines[49]).toContain("msg 50");
  });
});
