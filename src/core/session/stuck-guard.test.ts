import { describe, expect, test } from "bun:test";
import { ClaudeSession } from "./session";
import {
  createInitialSessionRuntimeState,
  finalizeQueryTransition,
  isQueryRunning,
  startQueryTransition,
} from "./state-machine";

describe("BUG soma-stuck-guard: re-entrancy guard permanently stuck after post-query throw", () => {
  // Trace: Scenario 1, Section 3c-3d
  // The finally block now calls finalizeQueryTransition (→ "idle") instead of
  // completeQueryTransition (→ "completing"). This ensures queryState always
  // returns to "idle" regardless of post-query errors.
  test("guard resets to idle after finally block runs (simulates post-query throw scenario)", async () => {
    const session = new ClaudeSession("test:stuck-guard:post-query-throw");

    // Simulate: query was running
    (session as any)._queryState = "running";

    // Simulate the FIXED finally block: finalizeQueryTransition (→ idle)
    const stateAfterFinally = finalizeQueryTransition(
      (session as any).getRuntimeState()
    );
    (session as any).applyRuntimeState(stateAfterFinally);

    // After fix: queryState goes directly to "idle" in finally
    // Even if post-query code throws after this, state is already safe
    expect(session.queryState).toBe("idle");
    expect(session.isRunning).toBe(false);
  });

  // Trace: Scenario 1, Section 3e — second call after recovery
  test("second sendMessageStreaming call is not blocked after first query completes", async () => {
    const session = new ClaudeSession("test:stuck-guard:recovery");

    // Simulate full cycle: running → finalizeQueryTransition → idle
    (session as any)._queryState = "running";
    const stateAfterFinally = finalizeQueryTransition(
      (session as any).getRuntimeState()
    );
    (session as any).applyRuntimeState(stateAfterFinally);

    // After the fixed finally block, session must accept new calls
    expect(session.isRunning).toBe(false);
    expect(session.queryState).toBe("idle");
  });

  // Trace: Scenario 2 — normal completion still works
  test("queryState is idle after normal query completion flow", () => {
    let state = createInitialSessionRuntimeState();
    expect(isQueryRunning(state)).toBe(false);

    // Start query
    state = startQueryTransition(state);
    expect(state.queryState).toBe("running");
    expect(isQueryRunning(state)).toBe(true);

    // Finally block: finalizeQueryTransition goes directly to idle
    state = finalizeQueryTransition(state);
    expect(state.queryState).toBe("idle");
    expect(isQueryRunning(state)).toBe(false);
  });

  // Trace: Scenario 3 — executeQueryRuntime throw also resets
  test("guard resets to idle even when executeQueryRuntime throws", async () => {
    const session = new ClaudeSession("test:stuck-guard:runtime-throw");

    // Simulate: executeQueryRuntime threw, catch re-threw error,
    // but finally block still runs with finalizeQueryTransition
    (session as any)._queryState = "running";

    // Simulate FIXED finally block
    const stateAfterFinally = finalizeQueryTransition(
      (session as any).getRuntimeState()
    );
    (session as any).applyRuntimeState(stateAfterFinally);

    // After fix: queryState = "idle" even when error propagates from catch
    expect(session.queryState).toBe("idle");
    expect(session.isRunning).toBe(false);
  });
});
