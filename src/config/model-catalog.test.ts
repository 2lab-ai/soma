/**
 * llmux model-catalog overlay tests.
 *
 * Contract under test (extend-only): the catalog may only ADD selectable
 * models on top of the static AVAILABLE_MODELS allow-list. llmux being down,
 * returning garbage, or returning an empty list must never shrink the menu.
 *
 * No test here touches the network: every refresh injects its own fetcher and
 * every snapshot write is redirected to a mkdtemp directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AVAILABLE_MODELS } from "./model";
import {
  __testResetCatalog,
  __testSeedCatalog,
  getCatalogMaxContext,
  getCatalogModels,
  getDisplayName,
  getSelectableModels,
  isKnownModel,
  loadSnapshotSync,
  maybeRefreshInBackground,
  refreshCatalog,
  setCatalogFetcher,
  setSnapshotPathForTests,
} from "./model-catalog";

const WIRE_ENTRIES = [
  {
    id: "claude-opus-5[1m]",
    aliases: ["opus5-1m"],
    name: "Opus 5 (1M)",
    efforts: ["low", "medium", "high", "xhigh"],
    max_context: 1_000_000,
    group: "claude",
  },
  {
    id: "gpt-5.6-sol",
    aliases: ["sol"],
    name: "GPT-5.6 Sol",
    efforts: ["medium", "high"],
    max_context: 400_000,
    group: "codex",
  },
  {
    id: "grok-4.5",
    aliases: [],
    name: "Grok 4.5",
    efforts: ["low", "high"],
    max_context: 256_000,
    group: "grok",
  },
];

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "soma-model-catalog-"));
  __testResetCatalog();
  setSnapshotPathForTests(join(tmpDir, "model-catalog.json"));
});

afterEach(() => {
  __testResetCatalog();
  setSnapshotPathForTests(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("normalize", () => {
  test("accepts wire shape and exposes normalized entries", () => {
    __testSeedCatalog(WIRE_ENTRIES);
    const models = getCatalogModels();
    expect(models.map((m) => m.id)).toEqual([
      "claude-opus-5[1m]",
      "gpt-5.6-sol",
      "grok-4.5",
    ]);
    expect(models[0]?.maxContext).toBe(1_000_000);
    expect(models[1]?.group).toBe("codex");
    expect(models[2]?.efforts).toEqual(["low", "high"]);
  });

  test("accepts the snapshot spelling maxContext as well as wire max_context", () => {
    __testSeedCatalog([{ id: "grok-4.5", name: "Grok 4.5", maxContext: 256_000 }]);
    expect(getCatalogMaxContext("grok-4.5")).toBe(256_000);
  });

  test("drops entries without a usable string id and dedupes case-insensitively", () => {
    __testSeedCatalog([
      { id: "grok-4.5", name: "Grok 4.5" },
      { id: "GROK-4.5", name: "dupe" },
      { id: "   ", name: "blank" },
      { id: 42, name: "numeric" },
      null,
      "not-an-object",
      { name: "no id at all" },
    ]);
    expect(getCatalogModels().map((m) => m.id)).toEqual(["grok-4.5"]);
  });

  test("maxContext is null when absent or non-positive", () => {
    __testSeedCatalog([
      { id: "a-model" },
      { id: "b-model", max_context: 0 },
      { id: "c-model", max_context: "big" },
    ]);
    expect(getCatalogMaxContext("a-model")).toBeNull();
    expect(getCatalogMaxContext("b-model")).toBeNull();
    expect(getCatalogMaxContext("c-model")).toBeNull();
  });
});

describe("extend-only selection", () => {
  test("empty catalog still offers every static AVAILABLE_MODELS entry", () => {
    const ids = getSelectableModels().map((m) => m.id);
    expect(ids).toEqual([...AVAILABLE_MODELS]);
  });

  test("catalog entries are appended after the static list, never replacing it", () => {
    __testSeedCatalog(WIRE_ENTRIES);
    const ids = getSelectableModels().map((m) => m.id);
    expect(ids.slice(0, AVAILABLE_MODELS.length)).toEqual([...AVAILABLE_MODELS]);
    expect(ids).toContain("grok-4.5");
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids.length).toBe(AVAILABLE_MODELS.length + WIRE_ENTRIES.length);
  });

  test("a catalog id that duplicates a static id is not listed twice", () => {
    __testSeedCatalog([{ id: AVAILABLE_MODELS[0], name: "from catalog" }]);
    const ids = getSelectableModels().map((m) => m.id);
    expect(ids).toEqual([...AVAILABLE_MODELS]);
  });

  test("every selectable model carries a group label", () => {
    __testSeedCatalog(WIRE_ENTRIES);
    for (const m of getSelectableModels()) {
      expect(m.group.length).toBeGreaterThan(0);
    }
    const grok = getSelectableModels().find((m) => m.id === "grok-4.5");
    expect(grok?.group).toBe("grok");
  });
});

describe("isKnownModel / getDisplayName", () => {
  test("static models are known without any catalog", () => {
    expect(isKnownModel("claude-opus-4-8[1m]")).toBe(true);
    expect(isKnownModel("claude-sonnet-4-5-20250929")).toBe(true);
  });

  test("catalog models become known, unknown ids stay unknown", () => {
    expect(isKnownModel("grok-4.5")).toBe(false);
    __testSeedCatalog(WIRE_ENTRIES);
    expect(isKnownModel("grok-4.5")).toBe(true);
    expect(isKnownModel("GROK-4.5")).toBe(true);
    expect(isKnownModel("no-such-model")).toBe(false);
    expect(isKnownModel("")).toBe(false);
  });

  test("display name falls back curated label → catalog name → raw id", () => {
    __testSeedCatalog(WIRE_ENTRIES);
    expect(getDisplayName("claude-opus-4-8")).toBe("Opus 4.8");
    expect(getDisplayName("grok-4.5")).toBe("Grok 4.5");
    expect(getDisplayName("mystery-model-9")).toBe("mystery-model-9");
  });

  test("the curated label wins over an llmux name for a static roster id", () => {
    // llmux names `claude-opus-4-8[1m]` after its base model ("Claude Opus
    // 4.8"), which is what the bare 4.8 row already says — letting the catalog
    // name win made the two menu rows read the same.
    __testSeedCatalog([
      { id: "claude-opus-4-8[1m]", name: "Claude Opus 4.8", group: "claude" },
      { id: "claude-fable-5", name: "Claude Fable 5", group: "claude" },
    ]);
    expect(getDisplayName("claude-opus-4-8[1m]")).toBe("Opus 4.8 (1M)");
    expect(getDisplayName("claude-fable-5")).toBe("Fable 5 (1M)");

    const labels = getSelectableModels().map((m) => m.displayName);
    expect(labels).toContain("Opus 4.8 (1M)");
    expect(labels).toContain("Opus 4.8");
  });
});

describe("refresh", () => {
  test("injected fetcher populates the catalog and persists a snapshot", async () => {
    setCatalogFetcher(async () => WIRE_ENTRIES);
    const result = await refreshCatalog();
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    expect(isKnownModel("grok-4.5")).toBe(true);

    const snapshotFile = join(tmpDir, "model-catalog.json");
    expect(existsSync(snapshotFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(snapshotFile, "utf-8"));
    expect(parsed.models.map((m: { id: string }) => m.id)).toContain("grok-4.5");
    // atomic write leaves no tmp file behind
    expect(existsSync(`${snapshotFile}.tmp`)).toBe(false);
  });

  test("a failing fetcher keeps the previously known models (never downgrade)", async () => {
    __testSeedCatalog(WIRE_ENTRIES);
    setCatalogFetcher(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await refreshCatalog({ force: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
    expect(isKnownModel("grok-4.5")).toBe(true);
    expect(getSelectableModels().length).toBe(
      AVAILABLE_MODELS.length + WIRE_ENTRIES.length
    );
  });

  test("without a fetcher the refresh is a skipped no-op (never hits the network)", async () => {
    const result = await refreshCatalog();
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
  });

  test("a second attempt inside the cooldown window is skipped", async () => {
    let calls = 0;
    setCatalogFetcher(async () => {
      calls += 1;
      return WIRE_ENTRIES;
    });
    expect((await refreshCatalog()).ok).toBe(true);
    const second = await refreshCatalog();
    expect(second.skipped).toBe(true);
    expect(calls).toBe(1);
  });

  test("force bypasses the normal cooldown", async () => {
    let calls = 0;
    setCatalogFetcher(async () => {
      calls += 1;
      return WIRE_ENTRIES;
    });
    await refreshCatalog();
    const forced = await refreshCatalog({ force: true });
    expect(forced.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("snapshot persistence", () => {
  test("round-trips through disk", async () => {
    setCatalogFetcher(async () => WIRE_ENTRIES);
    await refreshCatalog();

    __testResetCatalog();
    expect(isKnownModel("grok-4.5")).toBe(false);

    loadSnapshotSync();
    expect(isKnownModel("grok-4.5")).toBe(true);
    expect(getCatalogMaxContext("grok-4.5")).toBe(256_000);
  });

  test("a corrupt snapshot is ignored rather than throwing", () => {
    writeFileSync(join(tmpDir, "model-catalog.json"), "{not json", "utf-8");
    expect(() => loadSnapshotSync()).not.toThrow();
    expect(getSelectableModels().map((m) => m.id)).toEqual([...AVAILABLE_MODELS]);
  });

  test("a snapshot without a models array is ignored", () => {
    writeFileSync(join(tmpDir, "model-catalog.json"), '{"models":"nope"}', "utf-8");
    loadSnapshotSync();
    expect(getSelectableModels().map((m) => m.id)).toEqual([...AVAILABLE_MODELS]);
  });
});

describe("auth-mode gate (AUTH_MODE=oauth)", () => {
  // Selection and routing must agree: in oauth mode `buildProviderEnv()`
  // returns undefined, so the SDK talks to Anthropic directly and an
  // llmux-only id (gpt-*, grok-*) has nowhere to route. Offering it in the
  // menu would be a selectable-but-unroutable model.
  const previousAuthMode = process.env.AUTH_MODE;

  afterEach(() => {
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
  });

  test("selection falls back to the static roster even with a populated catalog", () => {
    __testSeedCatalog(WIRE_ENTRIES);
    expect(getSelectableModels().length).toBe(
      AVAILABLE_MODELS.length + WIRE_ENTRIES.length
    );

    process.env.AUTH_MODE = "oauth";
    expect(getSelectableModels().map((m) => m.id)).toEqual([...AVAILABLE_MODELS]);
  });

  test("llmux-only ids are not accepted as known models", () => {
    __testSeedCatalog(WIRE_ENTRIES);
    process.env.AUTH_MODE = "oauth";
    expect(isKnownModel("gpt-5.6-sol")).toBe(false);
    expect(isKnownModel("grok-4.5")).toBe(false);
    // …the static roster stays selectable/valid.
    expect(isKnownModel("claude-opus-4-8[1m]")).toBe(true);
  });

  test("refresh is a skipped no-op and never calls the fetcher", async () => {
    process.env.AUTH_MODE = "oauth";
    let calls = 0;
    setCatalogFetcher(async () => {
      calls += 1;
      return WIRE_ENTRIES;
    });
    const result = await refreshCatalog({ force: true });
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(calls).toBe(0);
    maybeRefreshInBackground();
    expect(calls).toBe(0);
  });

  test("display name and context window stay readable for already-persisted catalog models", () => {
    __testSeedCatalog(WIRE_ENTRIES);
    process.env.AUTH_MODE = "oauth";
    // A config saved while in llmux mode must still RENDER after a flip.
    expect(getDisplayName("grok-4.5")).toBe("Grok 4.5");
    expect(getCatalogMaxContext("grok-4.5")).toBe(256_000);
  });

  test("the mode is evaluated per call, so a flip applies immediately", () => {
    __testSeedCatalog(WIRE_ENTRIES);
    process.env.AUTH_MODE = "oauth";
    expect(isKnownModel("grok-4.5")).toBe(false);
    process.env.AUTH_MODE = "llmux";
    expect(isKnownModel("grok-4.5")).toBe(true);
    delete process.env.AUTH_MODE; // default is llmux
    expect(isKnownModel("grok-4.5")).toBe(true);
  });
});
