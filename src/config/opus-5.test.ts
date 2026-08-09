/**
 * Opus 5 family recognition.
 *
 * BUG: `isOpusFamily` matched the literal prefix `claude-opus-4-`, so every
 * llmux-catalog opus-5 id (`claude-opus-5`, `claude-opus-5[1m]`) fell through
 * the adaptive-thinking branch in `applyModelSpecificOverrides` and kept its
 * `maxThinkingTokens` budget → the SDK sent `thinking.budget_tokens` and the
 * API answered 400. The predicate must cover the whole opus line.
 */
import { describe, expect, test } from "bun:test";
import { isOpusFamily, normalizeConfig, usesAdaptiveThinking, type ModelConfig } from "./model";

describe("isOpusFamily covers every opus generation", () => {
  test("opus 5 ids match", () => {
    expect(isOpusFamily("claude-opus-5")).toBe(true);
    expect(isOpusFamily("claude-opus-5[1m]")).toBe(true);
  });

  test("opus 4.x ids still match", () => {
    expect(isOpusFamily("claude-opus-4-8")).toBe(true);
    expect(isOpusFamily("claude-opus-4-8[1m]")).toBe(true);
    expect(isOpusFamily("claude-opus-4-6[1m]")).toBe(true);
  });

  test("non-opus models do not match", () => {
    expect(isOpusFamily("claude-sonnet-5[1m]")).toBe(false);
    expect(isOpusFamily("claude-haiku-4-5")).toBe(false);
    expect(isOpusFamily("gpt-5.6-sol")).toBe(false);
    expect(isOpusFamily("grok-4.5")).toBe(false);
    expect(isOpusFamily("")).toBe(false);
  });

  test("opus 5 therefore uses adaptive thinking", () => {
    expect(usesAdaptiveThinking("claude-opus-5[1m]")).toBe(true);
    expect(usesAdaptiveThinking("claude-fable-5[1m]")).toBe(true);
    expect(usesAdaptiveThinking("gpt-5.6-sol")).toBe(false);
  });
});

describe("normalizeConfig tolerates catalog model ids", () => {
  test("an llmux-only model id is preserved, not rejected or rewritten", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "grok-4.5", reasoning: "high" },
      contexts: {
        general: { model: "gpt-5.6-sol", reasoning: "high" },
      },
    };
    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(false);
    expect(config.defaults.model).toBe("grok-4.5");
    expect(config.contexts.general?.model).toBe("gpt-5.6-sol");
    expect(config.contexts.general?.reasoning).toBe("high");
  });

  test("a catalog opus-5 context is coerced to xhigh (adaptive thinking)", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-5[1m]", reasoning: "high" },
      contexts: {
        general: { model: "claude-opus-5[1m]", reasoning: "high" },
      },
    };
    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(true);
    expect(config.contexts.general?.reasoning).toBe("xhigh");
  });
});
