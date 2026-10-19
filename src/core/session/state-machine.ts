/**
 * Session runtime state machine — re-exported from the shared `soma-lib`
 * package (src/domain/session-state) as of the convergence roadmap Step 4a.
 * The transition algebra moved verbatim; every existing import path keeps
 * working through this file. The transitions are tested in soma-lib's own
 * suite (src/domain/session-state/session-state.test.ts); the wiring is
 * exercised through ClaudeSession (src/session.test.ts,
 * src/handlers/commands/stop-command.contract.test.ts).
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
