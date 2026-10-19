/**
 * opus-4.8[1m] release wiring for soma (drift 2 of the opus-4.8 PR series).
 *
 * Pins:
 *  - `claude-opus-4-8[1m]` is a user-selectable AVAILABLE_MODELS entry.
 *  - `DEFAULT_MODEL` flips to `"claude-opus-4-8[1m]"` (1M context default).
 *  - `MODEL_DISPLAY_NAMES` renders an `Opus 4.8 (1M)` label.
 *  - `isOpusFamily()` still recognises the suffixed id (adaptive-thinking +
 *    xhigh-effort contract carries through; pinned in opus-5.test.ts). The
 *    SDK strips `[1m]` before hitting the API and injects the
 *    `context-1m-2025-08-07` beta header,
 *    so soma's runtime detection (`session-helpers.lookupContextWindowSize`
 *    via the init-event `betas` field) keeps working unchanged.
 *  - Bare `claude-opus-4-8` stays in the roster — users who explicitly
 *    chose it (or 4.7) don't get silently overridden (pinned in opus-4-8.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { AVAILABLE_MODELS, DEFAULT_MODEL, MODEL_DISPLAY_NAMES } from "./model";

describe("opus-4.8[1m] — roster + default", () => {
  test("AVAILABLE_MODELS includes claude-opus-4-8[1m]", () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain(
      "claude-opus-4-8[1m]"
    );
  });

  test("DEFAULT_MODEL is claude-opus-4-8[1m]", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-4-8[1m]");
  });

  test("MODEL_DISPLAY_NAMES renders Opus 4.8 (1M)", () => {
    expect(MODEL_DISPLAY_NAMES["claude-opus-4-8[1m]"]).toBe("Opus 4.8 (1M)");
  });
});
