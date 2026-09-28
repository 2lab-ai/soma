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
import { type EffortLevel, isSdkEffortLevel } from "soma-lib";
import { usesAdaptiveThinking } from "../config/model";
import { resolveEffortForModel } from "../config/model-catalog";

/**
 * Env var the Claude Code CLI merges into every `/v1/messages` body (verbatim
 * JSON). It is how an effort level the CLI's own `--effort` validator does not
 * know (`ultra`, llmux/codex-only) still reaches llmux's `output_config`.
 * CLI 2.1.283 documents it explicitly ("an effort supplied through
 * CLAUDE_CODE_EXTRA_BODY is not clamped").
 */
export const EXTRA_BODY_ENV = "CLAUDE_CODE_EXTRA_BODY";

/**
 * Applies model-specific transformations to an SDK `Options` object.
 *
 * `requestedEffort` is the user's persisted level for the query's context
 * (`getEffortForContext`), unclamped. What is sent is
 * `resolveEffortForModel(model, requestedEffort)`: `null` for models that
 * take no effort parameter, otherwise the level clamped onto the model's
 * catalog menu.
 *
 * - **Adaptive-thinking models (Opus 4.x/5.x, Fable, Sonnet 5)**: drops
 *   `maxThinkingTokens` (the SDK returns 400 on a `budget_tokens` budget),
 *   sets `thinking: {type:'adaptive'}` and `effort` = resolved level, or
 *   `xhigh` when nothing was requested (the pre-2026-09-28 fixed value).
 * - **Non-Claude models (llmux catalog: `gpt-*`, `grok-*`, …)**: drops
 *   `maxThinkingTokens` (a Claude-shaped thinking budget has no meaning
 *   through the llmux translation layer) and sets `effort` only when the
 *   catalog lists levels for the row. `ultra` is not an SDK level — the CLI
 *   rejects `--effort ultra` — so it travels as
 *   `CLAUDE_CODE_EXTRA_BODY={"output_config":{"effort":"ultra"}}` on the
 *   spawned CLI's env instead, and the SDK `effort` option is left unset.
 * - **All other Claude models (Sonnet 4.5 / Haiku 4.5)**: passthrough — the
 *   keyword-driven thinking-token budget is exactly what they want, and
 *   `resolveEffortForModel` returns `null` for them by contract.
 */
function withoutThinkingBudget<T extends object>(
  opts: T
): Omit<T, "maxThinkingTokens"> {
  const { maxThinkingTokens: _ignored, ...rest } = opts as T & {
    maxThinkingTokens?: number;
  };
  return rest;
}

/** Snapshot of the process env as the SDK would inherit it (string values only). */
function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

/**
 * Attach `effort` to `opts`: SDK levels go on the `effort` option; anything
 * else (today: `ultra`) goes into the CLI's extra-body env. When `opts.env`
 * is unset the CLI would inherit `process.env`, so the override is layered on
 * an explicit copy of it rather than replacing the whole environment.
 */
function withEffort<T extends Options>(opts: T, effort: EffortLevel): T {
  if (isSdkEffortLevel(effort)) {
    return { ...opts, effort } as T;
  }
  const { effort: _dropped, ...rest } = opts as T & { effort?: unknown };
  const baseEnv = rest.env ?? inheritedEnv();
  return {
    ...rest,
    env: {
      ...baseEnv,
      [EXTRA_BODY_ENV]: JSON.stringify({ output_config: { effort } }),
    },
  } as unknown as T;
}

export function applyModelSpecificOverrides<
  T extends Options & { abortController?: AbortController },
>(model: string, opts: T, requestedEffort?: EffortLevel | string | null): T {
  const effort = resolveEffortForModel(model, requestedEffort);

  if (usesAdaptiveThinking(model)) {
    const base = {
      ...withoutThinkingBudget(opts),
      thinking: { type: "adaptive" },
    } as unknown as T;
    return withEffort(base, effort ?? "xhigh");
  }
  if (!model.startsWith("claude-")) {
    const base = withoutThinkingBudget(opts) as unknown as T;
    return effort ? withEffort(base, effort) : base;
  }
  return opts;
}
