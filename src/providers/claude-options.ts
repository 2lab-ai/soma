/**
 * Model-specific overrides for Claude SDK `Options`.
 *
 * Some Claude models reject or ignore generic options (e.g. Opus 4.7 returns
 * 400 on `thinking: {type:'enabled', budget_tokens:N}` and instead requires
 * `thinking: {type:'adaptive'}`). Centralising the rewrites here keeps both
 * SDK call sites (`providers/claude-adapter.ts toClaudeOptions()` and
 * `core/session/query-runtime.ts buildQueryRuntimeOptions()`) consistent.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * Applies model-specific transformations to an SDK `Options` object.
 *
 * - **Opus 4.7**: drops `maxThinkingTokens`, sets
 *   `thinking: {type:'adaptive'}` and `effort: 'xhigh'`. The keyword-driven
 *   thinking-token budget mechanism (Sonnet/Haiku) is incompatible with Opus
 *   4.7's adaptive thinking, so the field is stripped to avoid SDK 400s.
 * - **All other models**: passthrough.
 */
export function applyModelSpecificOverrides<
  T extends Options & { abortController?: AbortController }
>(model: string, opts: T): T {
  if (model === "claude-opus-4-7") {
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
