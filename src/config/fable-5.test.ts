/**
 * Fable 5.1 (claude-fable-5-1[1m]) release wiring for soma (Telegram).
 *
 * Operator rule (2026-09-10): picking "fable" from the `/model` menu must land
 * on the 1M profile, i.e. the literal llmux id `claude-fable-5-1[1m]`. soma has
 * no text aliases — the menu selects by id — so the rule is enforced by the
 * roster itself. Pins:
 *  - `claude-fable-5-1[1m]` is the first AVAILABLE_MODELS entry, labelled
 *    "Fable 5.1 (1M)", and the superseded bare `claude-fable-5` is gone.
 *  - A persisted `claude-fable-5` rolls forward via MODEL_MIGRATIONS, so a
 *    config written before this change follows the same rule on load.
 *  - Fable shares the adaptive-thinking + xhigh-effort contract with Opus 4.x
 *    (adaptive thinking always-on, extended thinking unsupported → the SDK
 *    rejects a `budget_tokens` thinking budget). That contract is exposed as
 *    `usesAdaptiveThinking()`; `isOpusFamily()` stays the literal opus check.
 *  - The whole fable line reports a 1M window from `lookupContextWindowSize`
 *    with no `context-1m-2025-08-07` beta header.
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

const FABLE = "claude-fable-5-1[1m]";

describe("fable-5-1 — release wiring", () => {
  test("AVAILABLE_MODELS leads with claude-fable-5-1[1m]", () => {
    expect(AVAILABLE_MODELS[0]).toBe(FABLE);
  });

  test("the superseded bare claude-fable-5 is no longer offered", () => {
    expect(AVAILABLE_MODELS as readonly string[]).not.toContain("claude-fable-5");
    expect(AVAILABLE_MODELS as readonly string[]).not.toContain("claude-fable-5[1m]");
  });

  test("MODEL_DISPLAY_NAMES carries a Fable 5.1 (1M) label", () => {
    expect(MODEL_DISPLAY_NAMES[FABLE]).toBe("Fable 5.1 (1M)");
  });

  test("DEFAULT_MODEL is unchanged — Fable is opt-in, not the default", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-4-8[1m]");
    expect(isOpusFamily(DEFAULT_MODEL)).toBe(true);
  });
});

describe("fable-5-1 — adaptive-thinking contract", () => {
  test("usesAdaptiveThinking(claude-fable-5-1[1m]) === true", () => {
    expect(usesAdaptiveThinking(FABLE)).toBe(true);
  });

  test("isOpusFamily(claude-fable-5-1[1m]) === false (fable is not opus)", () => {
    expect(isOpusFamily(FABLE)).toBe(false);
  });

  test("usesAdaptiveThinking still covers opus 4.x and excludes sonnet/haiku", () => {
    expect(usesAdaptiveThinking("claude-opus-4-8")).toBe(true);
    expect(usesAdaptiveThinking("claude-opus-4-8[1m]")).toBe(true);
    expect(usesAdaptiveThinking("claude-sonnet-4-5-20250929")).toBe(false);
    expect(usesAdaptiveThinking("claude-haiku-4-5-20251001")).toBe(false);
  });

  test("applyModelSpecificOverrides strips maxThinkingTokens and forces adaptive + xhigh", () => {
    const abortController = new AbortController();
    const out = applyModelSpecificOverrides(FABLE, {
      model: FABLE,
      cwd: "/tmp",
      maxThinkingTokens: 50000,
      abortController,
    });

    expect(out.model).toBe(FABLE);
    expect((out as { maxThinkingTokens?: number }).maxThinkingTokens).toBeUndefined();
    expect((out as { thinking?: { type: string } }).thinking).toEqual({
      type: "adaptive",
    });
    expect((out as { effort?: string }).effort).toBe("xhigh");
  });

  test("normalizeConfig coerces a Fable context reasoning to xhigh", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: FABLE, reasoning: "xhigh" },
      contexts: {
        general: { model: FABLE, reasoning: "high" },
      },
    };
    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(true);
    expect(config.contexts.general?.reasoning).toBe("xhigh");
  });
});

describe("fable-5-1 — persisted claude-fable-5 rolls forward", () => {
  test("normalizeConfig migrates defaults and contexts to claude-fable-5-1[1m]", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-fable-5", reasoning: "xhigh" },
      contexts: {
        general: { model: "claude-fable-5", reasoning: "high" },
        summary: { model: "claude-sonnet-4-5-20250929", reasoning: "minimal" },
      },
    };
    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(true);
    expect(config.defaults.model).toBe(FABLE);
    expect(config.contexts.general?.model).toBe(FABLE);
    // …and the migrated context inherits the adaptive-thinking coercion.
    expect(config.contexts.general?.reasoning).toBe("xhigh");
    // Untouched contexts keep their own model + reasoning.
    expect(config.contexts.summary?.model).toBe("claude-sonnet-4-5-20250929");
    expect(config.contexts.summary?.reasoning).toBe("minimal");
  });

  test("the opus 4.7 → 4.8 non-migration is unchanged (explicit picks stand)", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-4-7", reasoning: "xhigh" },
      contexts: {
        general: { model: "claude-opus-4-7", reasoning: "xhigh" },
      },
    };
    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(false);
    expect(config.defaults.model).toBe("claude-opus-4-7");
  });
});

describe("fable-5-1 — native 1M context (the key contract)", () => {
  test("lookupContextWindowSize is 1M for the fable line with NO beta header", () => {
    expect(lookupContextWindowSize(FABLE, undefined)).toBe(1_000_000);
    expect(lookupContextWindowSize(FABLE, [])).toBe(1_000_000);
    expect(lookupContextWindowSize("claude-fable-5", undefined)).toBe(1_000_000);
  });

  test("opus bare id is still 200k without the 1M beta (unchanged)", () => {
    expect(lookupContextWindowSize("claude-opus-4-8", undefined)).toBe(200_000);
  });
});
