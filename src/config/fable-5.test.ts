/**
 * Fable 5 (claude-fable-5) release wiring for soma (Telegram).
 *
 * Telegram-side counterpart to the soma-work Fable 5 PR. Pins:
 *  - claude-fable-5 is registered in AVAILABLE_MODELS and labelled "Fable 5 (1M)".
 *  - There is NO `claude-fable-5[1m]` variant: Fable 5 serves a 1M context
 *    window natively on the bare id (no `[1m]` suffix, no
 *    `context-1m-2025-08-07` beta header), unlike opus where 1M is a beta
 *    opt-in. `lookupContextWindowSize` must return 1M for the bare id.
 *  - Fable 5 shares the adaptive-thinking + xhigh-effort contract with Opus
 *    4.x (adaptive thinking always-on, extended thinking unsupported → the SDK
 *    rejects a `budget_tokens` thinking budget). That contract is exposed as
 *    `usesAdaptiveThinking()`; `isOpusFamily()` stays the literal opus check.
 *  - DEFAULT_MODEL is unchanged (Fable is opt-in, not the default).
 */
import { describe, expect, test } from "bun:test";
import { applyModelSpecificOverrides } from "../providers/claude-options";
import { lookupContextWindowSize } from "../core/session/session-helpers";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  isOpusFamily,
  MODEL_DISPLAY_NAMES,
  type ModelConfig,
  normalizeConfig,
  usesAdaptiveThinking,
} from "./model";

describe("fable-5 — release wiring", () => {
  test("AVAILABLE_MODELS includes the bare claude-fable-5", () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain("claude-fable-5");
  });

  test("there is NO claude-fable-5[1m] variant (native-1M on the bare id)", () => {
    expect(AVAILABLE_MODELS as readonly string[]).not.toContain("claude-fable-5[1m]");
  });

  test("MODEL_DISPLAY_NAMES carries a Fable 5 (1M) label", () => {
    expect(MODEL_DISPLAY_NAMES["claude-fable-5"]).toBe("Fable 5 (1M)");
  });

  test("DEFAULT_MODEL is unchanged — Fable is opt-in, not the default", () => {
    expect(DEFAULT_MODEL).not.toBe("claude-fable-5");
    expect(isOpusFamily(DEFAULT_MODEL)).toBe(true);
  });
});

describe("fable-5 — adaptive-thinking contract", () => {
  test("usesAdaptiveThinking(claude-fable-5) === true", () => {
    expect(usesAdaptiveThinking("claude-fable-5")).toBe(true);
  });

  test("isOpusFamily(claude-fable-5) === false (fable is not opus)", () => {
    expect(isOpusFamily("claude-fable-5")).toBe(false);
  });

  test("usesAdaptiveThinking still covers opus 4.x and excludes sonnet/haiku", () => {
    expect(usesAdaptiveThinking("claude-opus-4-8")).toBe(true);
    expect(usesAdaptiveThinking("claude-opus-4-8[1m]")).toBe(true);
    expect(usesAdaptiveThinking("claude-sonnet-4-5-20250929")).toBe(false);
    expect(usesAdaptiveThinking("claude-haiku-4-5-20251001")).toBe(false);
  });

  test("applyModelSpecificOverrides strips maxThinkingTokens and forces adaptive + xhigh", () => {
    const abortController = new AbortController();
    const out = applyModelSpecificOverrides("claude-fable-5", {
      model: "claude-fable-5",
      cwd: "/tmp",
      maxThinkingTokens: 50000,
      abortController,
    });

    expect(out.model).toBe("claude-fable-5");
    expect((out as { maxThinkingTokens?: number }).maxThinkingTokens).toBeUndefined();
    expect((out as { thinking?: { type: string } }).thinking).toEqual({
      type: "adaptive",
    });
    expect((out as { effort?: string }).effort).toBe("xhigh");
  });

  test("normalizeConfig coerces a Fable 5 context reasoning to xhigh", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-fable-5", reasoning: "xhigh" },
      contexts: {
        general: { model: "claude-fable-5", reasoning: "high" },
      },
    };
    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(true);
    expect(config.contexts.general?.reasoning).toBe("xhigh");
  });
});

describe("fable-5 — native 1M context (the key contract)", () => {
  test("lookupContextWindowSize is 1M on the bare id with NO beta header", () => {
    expect(lookupContextWindowSize("claude-fable-5", undefined)).toBe(1_000_000);
    expect(lookupContextWindowSize("claude-fable-5", [])).toBe(1_000_000);
  });

  test("opus bare id is still 200k without the 1M beta (unchanged)", () => {
    expect(lookupContextWindowSize("claude-opus-4-8", undefined)).toBe(200_000);
  });
});
