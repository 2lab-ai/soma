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
import { usesAdaptiveThinking } from "../config/model";

/**
 * Applies model-specific transformations to an SDK `Options` object.
 *
 * - **Adaptive-thinking models (Opus 4.x, Fable 5, …)**: drops
 *   `maxThinkingTokens`, sets `thinking: {type:'adaptive'}` and
 *   `effort: 'xhigh'`. The keyword-driven thinking-token budget mechanism
 *   (Sonnet/Haiku) is incompatible with adaptive thinking on these models, so
 *   the field is stripped to avoid SDK 400s. The `usesAdaptiveThinking` check
 *   is the single source of truth — when a future adaptive family lands, no
 *   edit is needed here.
 * - **Non-Claude models (llmux catalog: `gpt-*`, `grok-*`, …)**: drops
 *   `maxThinkingTokens` and sets NEITHER `thinking` NOR `effort`. Those ids are
 *   served through the llmux translation layer, where a Claude-shaped thinking
 *   budget has no meaning — forwarding it just leaks an unsupported field into
 *   the upstream request. Effort for these models is llmux's business.
 * - **All other Claude models (Sonnet/Haiku)**: passthrough — the keyword-driven
 *   thinking-token budget is exactly what they want.
 */
function withoutThinkingBudget<T extends object>(opts: T): Omit<T, "maxThinkingTokens"> {
  const { maxThinkingTokens: _ignored, ...rest } = opts as T & {
    maxThinkingTokens?: number;
  };
  return rest;
}

export function applyModelSpecificOverrides<
  T extends Options & { abortController?: AbortController }
>(model: string, opts: T): T {
  if (usesAdaptiveThinking(model)) {
    return {
      ...withoutThinkingBudget(opts),
      thinking: { type: "adaptive" },
      effort: "xhigh",
    } as unknown as T;
  }
  if (!model.startsWith("claude-")) {
    return withoutThinkingBudget(opts) as unknown as T;
  }
  return opts;
}
