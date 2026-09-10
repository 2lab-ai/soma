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
  __testSetFetchedAt,
  getCatalogMaxContext,
  getCatalogModels,
  getDisplayName,
  getSelectableModels,
  isKnownModel,
  loadSnapshotSync,
  refreshCatalog,
  refreshCatalogIfStale,
  REFRESH_TTL_MS_FOR_TESTS,
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

describe("shorthand means 1M — alias-driven hiding of a base row", () => {
  // Operator rule (2026-09-10): soma's menu selects by id, so when llmux hangs
  // its shorthand (`astra`, `opus`, `fable`) on the `[1m]` row, offering the
  // base row too makes "pick astra" a coin flip between 272k and 1M. The
  // predicate is llmux's own alias metadata, NOT the id text — live today the
  // aliases sit on the [1m] twin for astra/opus-5/sonnet-5 but on the BASE row
  // for sol/terra, and only the former pair is ambiguous.
  const TWINNED_ENTRIES = [
    // Aliases on the [1m] row → the base is ambiguous and gets hidden.
    {
      id: "gpt-6-astra",
      aliases: [],
      name: "GPT-6 Astra",
      group: "codex",
      max_context: 272_000,
    },
    {
      id: "gpt-6-astra[1m]",
      aliases: ["astra", "gpt-6"],
      name: "GPT-6 Astra (1M)",
      group: "codex",
      max_context: 1_000_000,
    },
    // Aliases on the BASE row → shorthand already means the base; both stay.
    {
      id: "gpt-5.6-sol",
      aliases: ["sol", "gpt-5.6"],
      name: "GPT-5.6 Sol",
      group: "codex",
      max_context: 400_000,
    },
    {
      id: "gpt-5.6-sol[1m]",
      aliases: [],
      name: "GPT-5.6 Sol (1M)",
      group: "codex",
      max_context: 1_000_000,
    },
    {
      id: "grok-4.5",
      aliases: [],
      name: "Grok 4.5",
      group: "grok",
      max_context: 256_000,
    },
  ];

  test("normalizeEntries keeps aliases and defaults them to []", () => {
    __testSeedCatalog([
      { id: "gpt-6-astra[1m]", aliases: ["astra", " GPT-6 ", "", 42] },
      { id: "grok-4.5" },
      { id: "gpt-5.6-sol", aliases: "sol" },
    ]);
    const byId = new Map(getCatalogModels().map((m) => [m.id, m.aliases]));
    expect(byId.get("gpt-6-astra[1m]")).toEqual(["astra", "gpt-6"]);
    expect(byId.get("grok-4.5")).toEqual([]);
    expect(byId.get("gpt-5.6-sol")).toEqual([]);
  });

  test("the astra base is hidden but the sol base (aliases on the base) survives", () => {
    __testSeedCatalog(TWINNED_ENTRIES);
    const ids = getSelectableModels().map((m) => m.id);

    expect(ids.slice(0, AVAILABLE_MODELS.length)).toEqual([...AVAILABLE_MODELS]);
    expect(ids.slice(AVAILABLE_MODELS.length)).toEqual([
      "gpt-6-astra[1m]",
      "gpt-5.6-sol",
      "gpt-5.6-sol[1m]",
      "grok-4.5",
    ]);
    expect(ids).not.toContain("gpt-6-astra");
  });

  test("a [1m] twin with NO aliases hides nothing (the sol/terra shape)", () => {
    // Same ids as the astra case, only the alias metadata moved. If the rule
    // were textual ("a [1m] twin exists"), this base would vanish too.
    __testSeedCatalog([
      { id: "gpt-5.6-terra", aliases: ["terra"], name: "Terra", group: "codex" },
      { id: "gpt-5.6-terra[1m]", aliases: [], name: "Terra (1M)", group: "codex" },
    ]);
    const ids = getSelectableModels().map((m) => m.id);
    expect(ids.slice(AVAILABLE_MODELS.length)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-terra[1m]",
    ]);
  });

  test("only the TWIN's aliases decide — the base's own aliases do not rescue it", () => {
    // Pins the exact predicate: `X[1m]` offered AND `X[1m]` has >=1 alias.
    // No live row carries aliases on both sides today; if one ever does, the
    // 1M row still wins the menu slot and this test says so out loud.
    __testSeedCatalog([
      { id: "gpt-6-astra", aliases: ["astra-272k"], name: "Astra", group: "codex" },
      { id: "gpt-6-astra[1m]", aliases: ["astra"], name: "Astra (1M)", group: "codex" },
    ]);
    const ids = getSelectableModels().map((m) => m.id);
    expect(ids.slice(AVAILABLE_MODELS.length)).toEqual(["gpt-6-astra[1m]"]);
  });

  test("the hidden base id stays a KNOWN model (existing sessions keep resolving)", () => {
    __testSeedCatalog(TWINNED_ENTRIES);
    expect(isKnownModel("gpt-6-astra")).toBe(true);
    expect(isKnownModel("GPT-6-ASTRA")).toBe(true);
    expect(getDisplayName("gpt-6-astra")).toBe("GPT-6 Astra");
    expect(getCatalogMaxContext("gpt-6-astra")).toBe(272_000);
  });

  test("the suffix match is case-insensitive", () => {
    __testSeedCatalog([
      { id: "gpt-6-astra", aliases: [], name: "GPT-6 Astra", group: "codex" },
      {
        id: "GPT-6-Astra[1M]",
        aliases: ["astra"],
        name: "GPT-6 Astra (1M)",
        group: "codex",
      },
    ]);
    const ids = getSelectableModels().map((m) => m.id);
    expect(ids.slice(AVAILABLE_MODELS.length)).toEqual(["GPT-6-Astra[1M]"]);
  });

  test("a [1m] twin that exists ONLY in the static roster carries no alias metadata, so the base stays", () => {
    // `claude-fable-5-1[1m]` is a roster id. With no catalog row describing it
    // there are no aliases to key off, so the rule stays silent rather than
    // guessing from the id text.
    __testSeedCatalog([
      {
        id: "claude-fable-5-1",
        aliases: [],
        name: "Claude Fable 5.1 (272k)",
        group: "claude",
      },
    ]);
    expect(getSelectableModels().map((m) => m.id)).toContain("claude-fable-5-1");
  });

  test("…but a catalog row for that roster twin supplies the aliases and hides the base", () => {
    __testSeedCatalog([
      {
        id: "claude-fable-5-1",
        aliases: [],
        name: "Claude Fable 5.1 (272k)",
        group: "claude",
      },
      {
        id: "claude-fable-5-1[1m]",
        aliases: ["fable", "fable-5-1"],
        name: "Claude Fable 5.1",
        group: "claude",
      },
    ]);
    const ids = getSelectableModels().map((m) => m.id);
    expect(ids).not.toContain("claude-fable-5-1");
    // The roster already lists the [1m] row, so the catalog copy adds no dupe.
    expect(ids).toEqual([...AVAILABLE_MODELS]);
  });

  test("a static roster id is never hidden (extend-only floor)", () => {
    __testSeedCatalog(TWINNED_ENTRIES);
    const ids = getSelectableModels().map((m) => m.id);
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("claude-opus-4-8[1m]");
  });
});

describe("superseded ids never re-enter the menu through the catalog", () => {
  test("a catalog claude-fable-5 row is not selectable but stays a known model", () => {
    // MODEL_MIGRATIONS rewrites `claude-fable-5` → `claude-fable-5-1[1m]` on
    // load, so offering it in the menu hands the user a pick that the next
    // config load silently changes underneath them.
    __testSeedCatalog([
      { id: "claude-fable-5", aliases: [], name: "Claude Fable 5", group: "claude" },
      { id: "grok-4.5", aliases: [], name: "Grok 4.5", group: "grok" },
    ]);
    const ids = getSelectableModels().map((m) => m.id);
    expect(ids).not.toContain("claude-fable-5");
    expect(ids).toContain("grok-4.5");

    // …but a stale keyboard / open session pointing at it still decodes.
    expect(isKnownModel("claude-fable-5")).toBe(true);
    expect(getDisplayName("claude-fable-5")).toBe("Fable 5 (1M)");
  });

  test("the other migration source (claude-opus-4-6) is filtered too", () => {
    __testSeedCatalog([
      { id: "claude-opus-4-6", aliases: [], name: "Claude Opus 4.6", group: "claude" },
    ]);
    expect(getSelectableModels().map((m) => m.id)).toEqual([...AVAILABLE_MODELS]);
    expect(isKnownModel("claude-opus-4-6")).toBe(true);
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
      { id: "claude-fable-5-1[1m]", name: "Claude Fable 5.1", group: "claude" },
    ]);
    expect(getDisplayName("claude-opus-4-8[1m]")).toBe("Opus 4.8 (1M)");
    expect(getDisplayName("claude-fable-5-1[1m]")).toBe("Fable 5.1 (1M)");

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

describe("BUG agi-9m7: refreshCatalogIfStale (awaitable stale-refresh gate)", () => {
  test("BUG agi-9m7: stale catalog awaits the underlying refresh", async () => {
    let calls = 0;
    setCatalogFetcher(async () => {
      calls += 1;
      return WIRE_ENTRIES;
    });
    await refreshCatalogIfStale();
    expect(calls).toBe(1);
    expect(isKnownModel("grok-4.5")).toBe(true);
  });

  test("BUG agi-9m7: a fresh snapshot short-circuits without refetching", async () => {
    // __testSeedCatalog marks fetchedAt = Date.now() → inside TTL.
    __testSeedCatalog(WIRE_ENTRIES);
    let calls = 0;
    setCatalogFetcher(async () => {
      calls += 1;
      return WIRE_ENTRIES;
    });
    await refreshCatalogIfStale();
    expect(calls).toBe(0);
    expect(isKnownModel("grok-4.5")).toBe(true);
  });

  test("BUG agi-9m7: TTL boundary — a snapshot exactly at TTL is treated as stale", async () => {
    __testSeedCatalog(WIRE_ENTRIES);
    let calls = 0;
    setCatalogFetcher(async () => {
      calls += 1;
      return WIRE_ENTRIES;
    });

    // Safe pre-TTL margin (1s) so a few ms of clock drift between this
    // Date.now() and the one inside refreshCatalogIfStale cannot flip the
    // comparison. The exact-at-TTL branch below still pins the strict-`<`
    // contract because it uses `-TTL` (not `-(TTL-1)`).
    __testSetFetchedAt(Date.now() - (REFRESH_TTL_MS_FOR_TESTS - 1_000));
    await refreshCatalogIfStale();
    expect(calls).toBe(0);

    // Exactly TTL old — stale (Date.now() - fetchedAt is NOT `<` TTL).
    __testSetFetchedAt(Date.now() - REFRESH_TTL_MS_FOR_TESTS);
    await refreshCatalogIfStale();
    expect(calls).toBe(1);
  });

  test("BUG agi-9m7: REFRESH_TTL_MS_FOR_TESTS is exactly 10 minutes", () => {
    // Independent literal pin — the boundary test above proves the constant
    // is threaded to the runtime, this one pins its actual value so a silent
    // TTL change (e.g. shortened to 60_000 for debugging) trips a red.
    expect(REFRESH_TTL_MS_FOR_TESTS).toBe(600_000);
  });
});

describe("BUG agi-9m7: empty/malformed refresh never downgrades", () => {
  test("BUG agi-9m7: an empty wire response does NOT replace previously-known entries or bump fetchedAt", async () => {
    // Seed a known-good roster, then rewind fetchedAt PAST the TTL so the
    // snapshot is already stale. If the empty refresh below wrongly bumps
    // fetchedAt to `now`, the subsequent refreshCatalogIfStale will short-circuit
    // (calls === 0) — a green stale-check is the ground-truth proof that
    // fetchedAt was NOT bumped, without the test resetting it itself.
    __testSeedCatalog(WIRE_ENTRIES);
    __testSetFetchedAt(Date.now() - (REFRESH_TTL_MS_FOR_TESTS + 60_000));

    setCatalogFetcher(async () => []); // llmux answered, but with nothing.
    const result = await refreshCatalog({ force: true });

    // The refresh reports non-ok and the previously-known roster survives.
    expect(result.ok).toBe(false);
    expect(isKnownModel("grok-4.5")).toBe(true);
    expect(getCatalogModels().map((m) => m.id)).toEqual(WIRE_ENTRIES.map((e) => e.id));

    // Ground-truth check: the next stale-open MUST refetch (fetchedAt still
    // reads as older than TTL, because the empty refresh did not bump it).
    let calls = 0;
    setCatalogFetcher(async () => {
      calls += 1;
      return WIRE_ENTRIES;
    });
    await refreshCatalogIfStale();
    expect(calls).toBe(1);
  });

  test("BUG agi-9m7: a malformed-success payload that normalizes to empty is treated the same", async () => {
    __testSeedCatalog(WIRE_ENTRIES);
    // Everything gets dropped by normalizeEntries: no usable id.
    setCatalogFetcher(async () => [
      { name: "no id" },
      { id: 42 },
      null,
      "not-an-object",
    ]);
    const result = await refreshCatalog({ force: true });
    expect(result.ok).toBe(false);
    expect(getCatalogModels().map((m) => m.id)).toEqual(WIRE_ENTRIES.map((e) => e.id));
  });

  test("BUG agi-9m7: a cold empty response leaves static roster and is retryable", async () => {
    // No prior entries. An empty answer must not mark the catalog fresh, or
    // the next open would falsely believe llmux has been consulted recently.
    setCatalogFetcher(async () => []);
    const result = await refreshCatalog({ force: true });
    expect(result.ok).toBe(false);
    expect(getSelectableModels().map((m) => m.id)).toEqual([...AVAILABLE_MODELS]);

    // The very next stale-check must refetch (fetchedAt was NOT set).
    let calls = 0;
    setCatalogFetcher(async () => {
      calls += 1;
      return WIRE_ENTRIES;
    });
    await refreshCatalogIfStale();
    expect(calls).toBe(1);
    expect(isKnownModel("grok-4.5")).toBe(true);
  });
});

describe("BUG agi-9m7: legacy invalid snapshot never falsely marks catalog fresh", () => {
  const snapshotFile = () => join(tmpDir, "model-catalog.json");

  test("BUG agi-9m7: a recent VALID snapshot short-circuits the stale gate (fetches 0)", async () => {
    // Baseline: a snapshot with usable rows and a fresh timestamp SHOULD keep
    // refreshCatalogIfStale from calling the fetcher. This pins the
    // "well-formed recent snapshot" contract that the empty-snapshot cases
    // must not accidentally satisfy.
    writeFileSync(
      snapshotFile(),
      JSON.stringify({ fetchedAt: Date.now(), models: WIRE_ENTRIES }),
      "utf-8"
    );
    loadSnapshotSync();
    expect(isKnownModel("grok-4.5")).toBe(true);

    let calls = 0;
    setCatalogFetcher(async () => {
      calls += 1;
      return WIRE_ENTRIES;
    });
    await refreshCatalogIfStale();
    expect(calls).toBe(0);
  });

  test("BUG agi-9m7: a recent EMPTY snapshot must NOT be treated as fresh (fetches 1)", async () => {
    // Legacy on-disk snapshot with an empty models[] but a recent fetchedAt:
    // if loadSnapshotSync trusts it, refreshCatalogIfStale short-circuits and
    // the user sees the static-only roster forever.
    writeFileSync(
      snapshotFile(),
      JSON.stringify({ fetchedAt: Date.now(), models: [] }),
      "utf-8"
    );
    loadSnapshotSync();

    let calls = 0;
    setCatalogFetcher(async () => {
      calls += 1;
      return WIRE_ENTRIES;
    });
    await refreshCatalogIfStale();
    expect(calls).toBe(1);
  });

  test("BUG agi-9m7: a recent ALL-MALFORMED snapshot must NOT be treated as fresh (fetches 1)", async () => {
    // Every entry drops out of normalizeEntries → normalized.length === 0.
    // Same failure mode as the empty snapshot above.
    writeFileSync(
      snapshotFile(),
      JSON.stringify({
        fetchedAt: Date.now(),
        models: [{ name: "no id" }, { id: 42 }, null, "not-an-object"],
      }),
      "utf-8"
    );
    loadSnapshotSync();

    let calls = 0;
    setCatalogFetcher(async () => {
      calls += 1;
      return WIRE_ENTRIES;
    });
    await refreshCatalogIfStale();
    expect(calls).toBe(1);
  });

  test("BUG agi-9m7: a mixed payload with >=1 usable row is still accepted", async () => {
    // Extend-only contract: partial malformation must not strict-reject the
    // whole snapshot. The usable row survives, fetchedAt is trusted.
    writeFileSync(
      snapshotFile(),
      JSON.stringify({
        fetchedAt: Date.now(),
        models: [{ name: "no id" }, { id: "grok-4.5", name: "Grok 4.5" }, null],
      }),
      "utf-8"
    );
    loadSnapshotSync();
    expect(isKnownModel("grok-4.5")).toBe(true);

    let calls = 0;
    setCatalogFetcher(async () => {
      calls += 1;
      return WIRE_ENTRIES;
    });
    await refreshCatalogIfStale();
    expect(calls).toBe(0);
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
    // refreshCatalogIfStale delegates the oauth decision to refreshCatalog,
    // so the same no-op invariant holds without duplicating the branch here.
    await refreshCatalogIfStale();
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
