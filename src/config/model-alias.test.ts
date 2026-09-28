/**
 * `/model <shorthand>` resolution — pure unit tests, no env and no catalog
 * state (the universe is passed in).
 *
 * The universe below is the live llmux catalog of 2026-09-28 (ids + the aliases
 * llmux hangs on them) prefixed with soma's static roster, i.e. exactly what
 * `resolveModelInput` assembles in llmux mode. Two rows of it carry the whole
 * point of this module:
 *   - `grok` is an llmux alias of the NON-1M `grok-4.7`, yet the operator rule
 *     is "a bare family name always means the newest [1m]" — so the resolver
 *     must promote past the alias target instead of trusting it.
 *   - `claude-haiku-4-5-20251001` (static) is newer than the catalog's
 *     `claude-haiku-4-5`, which is why version comparison treats a missing
 *     segment as 0 rather than as "shorter wins".
 */
import { describe, expect, test } from "bun:test";
import { parseModelId, resolveModelAlias } from "./model-alias";

interface Row {
  id: string;
  aliases: readonly string[];
}

/** soma's static roster (`AVAILABLE_MODELS`) — never carries aliases. */
const STATIC_ROWS: Row[] = [
  { id: "claude-fable-5-1[1m]", aliases: [] },
  { id: "claude-sonnet-4-5-20250929", aliases: [] },
  { id: "claude-opus-4-8[1m]", aliases: [] },
  { id: "claude-opus-4-8", aliases: [] },
  { id: "claude-opus-4-7", aliases: [] },
  { id: "claude-haiku-4-5-20251001", aliases: [] },
];

/** The live `GET /llmux/models` roster (ids + aliases), verified 2026-09-28. */
const CATALOG_ROWS: Row[] = [
  { id: "claude-fable-5-1[1m]", aliases: ["fable", "fable-5-1"] },
  { id: "claude-fable-5[1m]", aliases: [] },
  { id: "claude-opus-5-5[1m]", aliases: ["opus", "opus-5-5"] },
  { id: "claude-opus-5-5", aliases: [] },
  { id: "claude-opus-5[1m]", aliases: ["opus-5"] },
  { id: "claude-opus-5", aliases: [] },
  { id: "claude-opus-4-8[1m]", aliases: [] },
  { id: "claude-opus-4-6[1m]", aliases: [] },
  { id: "claude-sonnet-5[1m]", aliases: ["sonnet", "sonnet-5"] },
  { id: "claude-sonnet-5", aliases: [] },
  { id: "claude-haiku-4-5", aliases: ["haiku"] },
  { id: "gpt-6-astra[1m]", aliases: ["astra", "gpt-6"] },
  { id: "gpt-6-astra", aliases: [] },
  { id: "gpt-5.6-sol[1m]", aliases: [] },
  { id: "gpt-5.6-sol", aliases: ["sol", "gpt-5.6"] },
  { id: "gpt-5.6-terra[1m]", aliases: [] },
  { id: "gpt-5.6-terra", aliases: ["terra"] },
  { id: "gpt-5.6-luna", aliases: ["luna"] },
  { id: "gpt-5.5", aliases: [] },
  { id: "grok-4.7", aliases: ["grok"] },
  { id: "grok-4.7[1m]", aliases: [] },
  { id: "grok-4.6", aliases: [] },
  { id: "grok-4.5", aliases: [] },
  { id: "or-ox-alpha", aliases: ["or"] },
  { id: "or-free", aliases: [] },
  { id: "or-glm-5.2", aliases: [] },
  { id: "or-nemotron-3-ultra", aliases: [] },
  { id: "or-nemotron-3.5-lightning", aliases: [] },
  { id: "or-dots-3-note", aliases: [] },
  { id: "or-laguna-s-2.1", aliases: [] },
  { id: "or-north-mini-code", aliases: [] },
  { id: "or-gemma-4-31b", aliases: [] },
  { id: "or-gpt-oss-20b", aliases: [] },
];

const LIVE: Row[] = [...STATIC_ROWS, ...CATALOG_ROWS];

/** Resolve and assert the kind in one step (the id is what every case is about). */
function resolved(token: string, universe: Row[] = LIVE): string {
  const result = resolveModelAlias(token, universe);
  if (result.kind !== "resolved") {
    throw new Error(`expected "resolved" for ${token}, got ${JSON.stringify(result)}`);
  }
  return result.id;
}

describe("parseModelId", () => {
  test("splits the 1M suffix, the digit version and the family name", () => {
    expect(parseModelId("claude-fable-5-1[1m]")).toEqual({
      base: "claude-fable-5-1",
      oneM: true,
      family: "claude-fable",
      version: [5, 1],
    });
  });

  test("treats a dotted version like a dashed one", () => {
    expect(parseModelId("gpt-5.6-sol")).toEqual({
      base: "gpt-5.6-sol",
      oneM: false,
      family: "gpt-sol",
      version: [5, 6],
    });
  });

  test("a family with no suffix segment keeps its bare name", () => {
    expect(parseModelId("grok-4.7")).toEqual({
      base: "grok-4.7",
      oneM: false,
      family: "grok",
      version: [4, 7],
    });
  });

  test("a date-stamped id keeps the stamp as the last version segment", () => {
    expect(parseModelId("claude-sonnet-4-5-20250929")).toEqual({
      base: "claude-sonnet-4-5-20250929",
      oneM: false,
      family: "claude-sonnet",
      version: [4, 5, 20250929],
    });
  });

  test("non-digit segments around the version all join the family", () => {
    expect(parseModelId("or-nemotron-3.5-lightning")).toEqual({
      base: "or-nemotron-3.5-lightning",
      oneM: false,
      family: "or-nemotron-lightning",
      version: [3, 5],
    });
  });
});

describe("resolveModelAlias: representative shorthand → newest [1m]", () => {
  test("fable → claude-fable-5-1[1m]", () => {
    expect(resolved("fable")).toBe("claude-fable-5-1[1m]");
  });

  test("opus → claude-opus-5-5[1m]", () => {
    expect(resolved("opus")).toBe("claude-opus-5-5[1m]");
  });

  test("grok → grok-4.7[1m], promoted past llmux's non-1M alias target", () => {
    expect(resolved("grok")).toBe("grok-4.7[1m]");
  });

  test("astra → gpt-6-astra[1m]", () => {
    expect(resolved("astra")).toBe("gpt-6-astra[1m]");
  });

  test("sonnet → claude-sonnet-5[1m]", () => {
    expect(resolved("sonnet")).toBe("claude-sonnet-5[1m]");
  });

  test("sol → gpt-5.6-sol[1m]", () => {
    expect(resolved("sol")).toBe("gpt-5.6-sol[1m]");
  });

  test("haiku → the newest haiku, which has no 1M twin at all", () => {
    expect(resolved("haiku")).toBe("claude-haiku-4-5-20251001");
  });

  test("surrounding space and case are irrelevant", () => {
    expect(resolved("FABLE ")).toBe("claude-fable-5-1[1m]");
  });
});

describe("resolveModelAlias: version-pinned shorthand", () => {
  test("opus-5 pins the generation and still prefers its [1m] twin", () => {
    expect(resolved("opus-5")).toBe("claude-opus-5[1m]");
  });

  test("gpt-6 resolves through the alias to gpt-6-astra[1m]", () => {
    expect(resolved("gpt-6")).toBe("gpt-6-astra[1m]");
  });

  test("fable-5-1 resolves to the row the alias sits on", () => {
    expect(resolved("fable-5-1")).toBe("claude-fable-5-1[1m]");
  });
});

describe("resolveModelAlias: exact ids are never promoted", () => {
  test("an exact base id stays the base id", () => {
    expect(resolveModelAlias("claude-opus-5-5", LIVE)).toEqual({
      kind: "exact",
      id: "claude-opus-5-5",
    });
  });

  test("an exact id matches case-insensitively and answers with the catalog spelling", () => {
    expect(resolveModelAlias("Claude-Opus-5-5[1m]", LIVE)).toEqual({
      kind: "exact",
      id: "claude-opus-5-5[1m]",
    });
  });
});

describe("resolveModelAlias: ambiguous and unknown", () => {
  test("gpt spans several families → ambiguous with one candidate each", () => {
    const result = resolveModelAlias("gpt", LIVE);
    if (result.kind !== "ambiguous")
      throw new Error(`expected ambiguous: ${result.kind}`);
    expect(result.candidates.length).toBeGreaterThanOrEqual(3);
    expect(result.candidates).toContain("gpt-6-astra[1m]");
    expect(result.candidates).toContain("gpt-5.6-sol[1m]");
    // One best row per family, so no family appears twice.
    const families = result.candidates.map((id) => parseModelId(id).family);
    expect(new Set(families).size).toBe(families.length);
    expect([...result.candidates]).toEqual([...result.candidates].sort());
  });

  test("claude spans fable/opus/sonnet/haiku → ambiguous", () => {
    const result = resolveModelAlias("claude", LIVE);
    if (result.kind !== "ambiguous")
      throw new Error(`expected ambiguous: ${result.kind}`);
    expect(result.candidates).toContain("claude-fable-5-1[1m]");
    expect(result.candidates).toContain("claude-opus-5-5[1m]");
    expect(result.candidates.length).toBeGreaterThanOrEqual(4);
  });

  test("a token that names nothing is unknown", () => {
    expect(resolveModelAlias("zzz", LIVE)).toEqual({ kind: "unknown" });
  });

  test("an empty token is unknown", () => {
    expect(resolveModelAlias("", LIVE)).toEqual({ kind: "unknown" });
    expect(resolveModelAlias("   ", LIVE)).toEqual({ kind: "unknown" });
  });
});

describe("resolveModelAlias: follows the catalog forward without a code change", () => {
  test("a newer fable generation wins as soon as llmux serves it", () => {
    const future: Row[] = [...LIVE, { id: "claude-fable-6[1m]", aliases: [] }];
    expect(resolved("fable", future)).toBe("claude-fable-6[1m]");
  });

  test("a newer grok twin pair wins, and the [1m] half of it is picked", () => {
    const future: Row[] = [
      ...LIVE,
      { id: "grok-5", aliases: [] },
      { id: "grok-5[1m]", aliases: [] },
    ];
    expect(resolved("grok", future)).toBe("grok-5[1m]");
  });
});

/**
 * The operator rule is "always the newest **[1m]**", so `[1m]` qualifies a row
 * for consideration — it is not a tie-breaker applied after the version compare.
 * llmux routinely ships the base row of a generation days before its 1M twin, and
 * a shorthand must not silently drop from 1M to 256k during that window.
 */
describe("resolveModelAlias: a newer NON-1M row never displaces the newest [1m]", () => {
  test("grok-5 without its 1M twin leaves grok on grok-4.7[1m]", () => {
    const partial: Row[] = [...LIVE, { id: "grok-5", aliases: [] }];
    expect(resolved("grok", partial)).toBe("grok-4.7[1m]");
  });

  test("a minimal universe shows the same thing without the live noise", () => {
    const minimal: Row[] = [
      { id: "grok-4.7", aliases: ["grok"] },
      { id: "grok-4.7[1m]", aliases: [] },
      { id: "grok-5", aliases: [] },
    ];
    expect(resolved("grok", minimal)).toBe("grok-4.7[1m]");
  });

  test("a dated non-1M sonnet build leaves sonnet on claude-sonnet-5[1m]", () => {
    const partial: Row[] = [...LIVE, { id: "claude-sonnet-5-20260301", aliases: [] }];
    expect(resolved("sonnet", partial)).toBe("claude-sonnet-5[1m]");
  });

  test("once the 1M twin lands, the newer generation takes over", () => {
    const partial: Row[] = [
      ...LIVE,
      { id: "grok-5", aliases: [] },
      { id: "grok-5[1m]", aliases: [] },
    ];
    expect(resolved("grok", partial)).toBe("grok-5[1m]");
  });

  test("a family with no [1m] row at all still resolves by version alone", () => {
    const noOneM: Row[] = [
      { id: "claude-haiku-4-5-20251001", aliases: [] },
      { id: "claude-haiku-4-5", aliases: ["haiku"] },
      { id: "claude-haiku-4-4", aliases: [] },
    ];
    expect(resolved("haiku", noOneM)).toBe("claude-haiku-4-5-20251001");
  });
});

describe("resolveModelAlias: static-only universe (oauth mode)", () => {
  test("opus resolves inside the static roster, with no aliases to help", () => {
    expect(resolved("opus", STATIC_ROWS)).toBe("claude-opus-4-8[1m]");
  });

  test("fable resolves to the only fable the roster carries", () => {
    expect(resolved("fable", STATIC_ROWS)).toBe("claude-fable-5-1[1m]");
  });

  test("an llmux-only shorthand is unknown in oauth mode", () => {
    expect(resolveModelAlias("astra", STATIC_ROWS)).toEqual({ kind: "unknown" });
  });
});
