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
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __testResetCatalog, __testSeedCatalog } from "../../config/model-catalog";
import {
  buildClaudeMdSection,
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

/**
 * CLAUDE.md injection vs. SOMA_SETTING_SOURCES. The bot reads the working
 * directory's CLAUDE.md into its own systemPrompt because `settingSources: []`
 * keeps the CLI from loading it. Once `project` is a setting source the CLI
 * loads CLAUDE.md itself, so the bot's copy would send it twice.
 */
describe("buildClaudeMdSection", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soma-claude-md-"));
    writeFileSync(join(dir, "CLAUDE.md"), "# Project rules\nbe nice\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("injects CLAUDE.md when no setting source loads it", () => {
    const expected =
      "\n\n# Project Instructions (CLAUDE.md)\n# Project rules\nbe nice\n\n";
    expect(buildClaudeMdSection(dir, [])).toBe(expected);
    // Only `project` makes the CLI load CLAUDE.md (sdk.d.ts settingSources).
    expect(buildClaudeMdSection(dir, ["user", "local"])).toBe(expected);
  });

  test("skips the injection when project settings are loaded", () => {
    expect(buildClaudeMdSection(dir, ["project"])).toBe("");
    expect(buildClaudeMdSection(dir, ["user", "project"])).toBe("");
  });

  test("is empty when the working directory has no CLAUDE.md", () => {
    rmSync(join(dir, "CLAUDE.md"));
    expect(buildClaudeMdSection(dir, [])).toBe("");
  });
});
