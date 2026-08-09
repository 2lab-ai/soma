/**
 * Context-window resolution.
 *
 * `lookupContextWindowSize` only knows the hard-coded claude families, so a
 * catalog-only model (grok/codex, or a claude id it does not pattern-match)
 * reported a 0/null window. The llmux catalog ships `max_context` per model —
 * `resolveContextWindowSize` now takes it as one more Math.max candidate, so
 * behaviour is unchanged when the catalog is empty.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __testResetCatalog, __testSeedCatalog } from "../../config/model-catalog";
import {
  CONTEXT_1M_BETA,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  resolveContextWindowSize,
} from "./session-helpers";

beforeEach(() => {
  __testResetCatalog();
});

afterEach(() => {
  __testResetCatalog();
});

describe("resolveContextWindowSize", () => {
  test("without a catalog the existing behaviour is unchanged", () => {
    expect(resolveContextWindowSize({ model: "claude-sonnet-4-5-20250929" })).toBe(
      DEFAULT_CONTEXT_WINDOW_SIZE
    );
    expect(
      resolveContextWindowSize({
        model: "claude-opus-4-8[1m]",
        betas: [CONTEXT_1M_BETA],
      })
    ).toBe(1_000_000);
    expect(resolveContextWindowSize({ model: "grok-4.5" })).toBeNull();
  });

  test("a catalog max_context supplies the window for non-claude models", () => {
    __testSeedCatalog([{ id: "grok-4.5", max_context: 256_000 }]);
    expect(resolveContextWindowSize({ model: "grok-4.5" })).toBe(256_000);
  });

  test("the largest of sdk / lookup / catalog wins", () => {
    __testSeedCatalog([{ id: "claude-sonnet-5[1m]", max_context: 1_000_000 }]);
    expect(resolveContextWindowSize({ model: "claude-sonnet-5[1m]" })).toBe(1_000_000);
    expect(
      resolveContextWindowSize({ model: "claude-sonnet-5[1m]", sdkWindow: 2_000_000 })
    ).toBe(2_000_000);
  });

  test("a catalog entry with no max_context does not shrink the lookup value", () => {
    __testSeedCatalog([{ id: "claude-sonnet-4-5-20250929" }]);
    expect(resolveContextWindowSize({ model: "claude-sonnet-4-5-20250929" })).toBe(
      DEFAULT_CONTEXT_WINDOW_SIZE
    );
  });
});
