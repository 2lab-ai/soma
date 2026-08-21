/**
 * Session runtime state machine — re-exported from the shared `soma-lib`
 * package (src/domain/session-state) as of the convergence roadmap Step 4a.
 * The transition algebra moved verbatim; every existing import path keeps
 * working through this file, and this repo's state-machine.test.ts now
 * exercises the shared implementation.
 */
export type {
  ActivityState,
  BeginInterruptResult,
  InterruptConsumptionResult,
  QueryState,
  SessionRuntimeState,
} from "soma-lib";
export {
  beginInterruptTransition,
  clearStopRequestedTransition,
  completeQueryTransition,
  consumeInterruptFlagTransition,
  createInitialSessionRuntimeState,
  endInterruptTransition,
  finalizeQueryTransition,
  incrementGenerationTransition,
  isQueryProcessing,
  isQueryRunning,
  markInterruptFlag,
  requestStopDuringPreparingTransition,
  requestStopDuringRunningTransition,
  startProcessingTransition,
  startQueryTransition,
  stopProcessingTransition,
  transitionActivityState,
  transitionQueryState,
} from "soma-lib";
