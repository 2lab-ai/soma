/**
 * Presentation helpers for the effort level in the `/model` UI.
 *
 * The `/model` summary and the save confirmation both need the same one-line
 * description of "what will this context actually run", so it lives here
 * rather than being duplicated in callback.ts and usage-commands.ts.
 */
import type { EffortLevel } from "soma-lib";
import {
  getEffortForContext,
  type ConfigContext,
  type ModelConfig,
} from "../config/model";
import { getSupportedEfforts, resolveEffortForModel } from "../config/model-catalog";

/** Sentinel level in `model:save:<ctx>:<id>:<level>` for "no effort choice". */
export const NO_EFFORT_SENTINEL = "-";

/** Button caption for a level (`xhigh` → `X-High`, `ultra` → `Ultra`, …). */
export function effortLabel(level: EffortLevel): string {
  if (level === "xhigh") return "X-High";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/**
 * One-line summary of the effort a context will run with, for the
 * `/model` overview. Models that take no effort parameter say so — their
 * thinking budget is set per message by keyword, not by this menu. When the
 * persisted level is outside the model's menu the clamped value is shown
 * next to it so the user sees what is actually sent.
 */
export function effortSummary(model: string, effort: EffortLevel): string {
  if (getSupportedEfforts(model).length === 0) return "thinking: keyword budget";
  const resolved = resolveEffortForModel(model, effort);
  if (!resolved || resolved === effort) return `effort: ${effort}`;
  return `effort: ${effort} → ${resolved}`;
}

/** Summary for `context` from the live config (model + effort, resolved). */
export function contextEffortSummary(
  config: ModelConfig,
  context: ConfigContext
): string {
  const model = config.contexts[context]?.model || config.defaults.model;
  return effortSummary(model, getEffortForContext(context));
}
