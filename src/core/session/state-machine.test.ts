import { describe, expect, test } from "bun:test";
import {
  beginInterruptTransition,
  clearStopRequestedTransition,
  completeQueryTransition,
  consumeInterruptFlagTransition,
  createInitialSessionRuntimeState,
  finalizeQueryTransition,
  incrementGenerationTransition,
  isQueryProcessing,
  isQueryRunning,
  markInterruptFlag,
  requestStopDuringPreparingTransition,
  requestStopDuringRunningTransition,
  startProcessingTransition,
  startQueryTransition,
  transitionActivityState,
} from "./state-machine";

describe("session state-machine transitions", () => {
  test("moves query through preparing -> running -> completing -> idle", () => {
    let state = createInitialSessionRuntimeState();
    state = startProcessingTransition(state);
    expect(state.queryState).toBe("preparing");
    expect(isQueryProcessing(state)).toBe(true);

    state = startQueryTransition(state);
    expect(state.queryState).toBe("running");
    expect(state.stopRequested).toBe(false);
    expect(isQueryRunning(state)).toBe(true);

    state = completeQueryTransition(state);
    expect(state.queryState).toBe("completing");

    state = finalizeQueryTransition(state);
    expect(state.queryState).toBe("idle");
    expect(isQueryRunning(state)).toBe(false);
  });

  test("marks stop request when stopping running and preparing queries", () => {
    let state = createInitialSessionRuntimeState();
    state = startQueryTransition(startProcessingTransition(state));
    state = requestStopDuringRunningTransition(state);
    expect(state.stopRequested).toBe(true);
    expect(state.queryState).toBe("aborting");

    state = clearStopRequestedTransition(state);
    expect(state.stopRequested).toBe(false);

    state = requestStopDuringPreparingTransition(startProcessingTransition(state));
    expect(state.stopRequested).toBe(true);
    expect(state.queryState).toBe("preparing");
  });

  test("consumes interrupt flag and clears stop request when interrupted", () => {
    let state = createInitialSessionRuntimeState();
    state = requestStopDuringPreparingTransition(state);
    state = markInterruptFlag(state);

    const consumed = consumeInterruptFlagTransition(state);
    expect(consumed.wasInterrupted).toBe(true);
    expect(consumed.nextState.wasInterruptedByNewMessage).toBe(false);
    expect(consumed.nextState.stopRequested).toBe(false);
  });

  test("interrupt start is idempotent", () => {
    const state = createInitialSessionRuntimeState();
    const first = beginInterruptTransition(state);
    expect(first.started).toBe(true);
    expect(first.nextState.isInterrupting).toBe(true);

    const second = beginInterruptTransition(first.nextState);
    expect(second.started).toBe(false);
    expect(second.nextState.isInterrupting).toBe(true);
  });

  test("increments generation and keeps activity transitions pure", () => {
    let state = createInitialSessionRuntimeState();
    state = transitionActivityState(state, "working");
    expect(state.activityState).toBe("working");

    state = incrementGenerationTransition(state);
    state = incrementGenerationTransition(state);
    expect(state.generation).toBe(2);
  });
});
