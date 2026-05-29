/**
 * opus-4.8 release wiring for soma (Telegram).
 *
 * Telegram-side counterpart to soma-work PR #997. Pins:
 *  - claude-opus-4-8 is registered in AVAILABLE_MODELS and labelled.
 *  - DEFAULT_MODEL points at claude-opus-4-8 (Opus 4.7 stays selectable).
 *  - The "opus family" adaptive-thinking + xhigh-effort contract that was
 *    previously gated by `=== "claude-opus-4-7"` now covers 4.8 too. The
 *    contract is exposed as `isOpusFamily()` so a future generation (4.9)
 *    is a single edit there + AVAILABLE_MODELS / MODEL_DISPLAY_NAMES.
 *  - normalizeConfig coerces reasoning → "xhigh" for any opus-family
 *    context, including 4.8.
 *
 * No `[1m]` suffix wiring: soma signals 1M context via the SDK init-event
 * `betas: ["context-1m-2025-08-07"]` flag (see core/session/session-helpers.ts),
 * not via a model-id suffix. That decision is intentionally NOT changed here
 * — adopting the suffix would touch the persisted yaml + session payload +
 * lookupContextWindowSize call sites and belongs in its own PR.
 */
import { describe, expect, test } from "bun:test";
import { applyModelSpecificOverrides } from "../providers/claude-options";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  isOpusFamily,
  MODEL_DISPLAY_NAMES,
  type ModelConfig,
  normalizeConfig,
} from "./model";

describe("opus-4.8 — release wiring", () => {
  test("AVAILABLE_MODELS includes claude-opus-4-8", () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain("claude-opus-4-8");
  });

  test("DEFAULT_MODEL is claude-opus-4-8 (latest opus)", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-4-8");
  });

  test("MODEL_DISPLAY_NAMES carries an Opus 4.8 label", () => {
    expect(MODEL_DISPLAY_NAMES["claude-opus-4-8"]).toBe("Opus 4.8");
  });

  test("historical Opus 4.7 stays selectable (no silent removal)", () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain("claude-opus-4-7");
    expect(MODEL_DISPLAY_NAMES["claude-opus-4-7"]).toBe("Opus 4.7");
  });
});

describe("opus-4.8 — isOpusFamily covers 4.7 and 4.8", () => {
  test("4.7 is opus family", () => {
    expect(isOpusFamily("claude-opus-4-7")).toBe(true);
  });

  test("4.8 is opus family", () => {
    expect(isOpusFamily("claude-opus-4-8")).toBe(true);
  });

  test("sonnet / haiku / unrelated ids are not opus family", () => {
    expect(isOpusFamily("claude-sonnet-4-5-20250929")).toBe(false);
    expect(isOpusFamily("claude-haiku-4-5-20251001")).toBe(false);
    expect(isOpusFamily("gpt-99-turbo")).toBe(false);
    expect(isOpusFamily("")).toBe(false);
  });
});

describe("opus-4.8 — applyModelSpecificOverrides extends the 4.7 contract", () => {
  test("Opus 4.8 strips maxThinkingTokens and forces adaptive + xhigh", () => {
    const abortController = new AbortController();
    const out = applyModelSpecificOverrides("claude-opus-4-8", {
      model: "claude-opus-4-8",
      cwd: "/tmp",
      maxThinkingTokens: 50000,
      abortController,
    });

    expect(out.model).toBe("claude-opus-4-8");
    expect((out as { maxThinkingTokens?: number }).maxThinkingTokens).toBeUndefined();
    expect((out as { thinking?: { type: string } }).thinking).toEqual({
      type: "adaptive",
    });
    expect((out as { effort?: string }).effort).toBe("xhigh");
  });
});

describe("opus-4.8 — normalizeConfig coerces 4.8 reasoning to xhigh", () => {
  test("general context on Opus 4.8 with high reasoning is bumped to xhigh", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-4-8", reasoning: "xhigh" },
      contexts: {
        general: { model: "claude-opus-4-8", reasoning: "high" },
      },
    };
    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(true);
    expect(config.contexts.general?.reasoning).toBe("xhigh");
  });

  test("Opus 4.7 with xhigh is unchanged (regression)", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-4-7", reasoning: "xhigh" },
      contexts: {
        general: { model: "claude-opus-4-7", reasoning: "xhigh" },
      },
    };
    const { changed } = normalizeConfig(input);
    expect(changed).toBe(false);
  });
});
