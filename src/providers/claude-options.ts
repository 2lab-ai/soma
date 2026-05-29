/**
 * Model-specific overrides for Claude SDK `Options`.
 *
 * Some Claude models reject or ignore generic options (e.g. the Opus 4.x
 * family returns 400 on `thinking: {type:'enabled', budget_tokens:N}` and
 * instead requires `thinking: {type:'adaptive'}`). Centralising the rewrites
 * here keeps both SDK call sites (`providers/claude-adapter.ts
 * toClaudeOptions()` and `core/session/query-runtime.ts
 * buildQueryRuntimeOptions()`) consistent.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { isOpusFamily } from "../config/model";

/**
 * Applies model-specific transformations to an SDK `Options` object.
 *
 * - **Opus 4.x (4.7, 4.8, …)**: drops `maxThinkingTokens`, sets
 *   `thinking: {type:'adaptive'}` and `effort: 'xhigh'`. The keyword-driven
 *   thinking-token budget mechanism (Sonnet/Haiku) is incompatible with
 *   adaptive thinking on the Opus 4.x family, so the field is stripped to
 *   avoid SDK 400s. The family check (`isOpusFamily`) is the single source
 *   of truth — when a future generation lands, no edit is needed here.
 * - **All other models**: passthrough.
 */
export function applyModelSpecificOverrides<
  T extends Options & { abortController?: AbortController }
>(model: string, opts: T): T {
  if (isOpusFamily(model)) {
    const { maxThinkingTokens: _ignored, ...rest } = opts as T & {
      maxThinkingTokens?: number;
    };
    return {
      ...rest,
      thinking: { type: "adaptive" },
      effort: "xhigh",
    } as unknown as T;
  }
  return opts;
}
