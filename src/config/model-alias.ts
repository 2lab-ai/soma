/**
 * Shorthand → model-id resolution for `/model <model> [effort]`.
 *
 * Operator rule (2026-09-28): "typing the representative name always selects
 * the NEWEST `[1m]` model of that family" — `/model fable` →
 * `claude-fable-5-1[1m]`, `/model opus` → `claude-opus-5-5[1m]`, `/model grok`
 * → `grok-4.7[1m]`, `/model astra` → `gpt-6-astra[1m]`.
 *
 * Why this is not just "look up llmux's alias": llmux publishes its own alias
 * list per row, and it hangs `grok` on the NON-1M `grok-4.7`. Trusting the
 * alias target would hand the operator a 256k window for a shorthand that is
 * supposed to mean 1M. So an alias is a *hint about which family the operator
 * means*, and the row is then chosen as the NEWEST of the family's `[1m]` rows
 * (a family with no `[1m]` row at all, like `claude-haiku`, falls back to its
 * newest row). That also makes the mapping self-maintaining: when llmux starts
 * serving `claude-fable-6[1m]`, `fable` follows it with no code change — and
 * while only the 256k half of a new generation is published, the shorthand
 * stays on the older `[1m]` row rather than downgrading the context window.
 *
 * An exact id is never promoted — typing `claude-opus-5-5` means that row, 256k
 * window included. Promotion applies to shorthands only.
 *
 * Pure module by design: the universe (ids + llmux aliases) is passed in, so
 * this file imports nothing and every rule is testable without env, catalog
 * state or network. The wiring against the live roster is
 * `resolveModelInput()` in `config/model-catalog.ts`.
 */

/** llmux's 1M-context id suffix, lowercased. */
const ONE_M_SUFFIX = "[1m]";

/** A model id decomposed into the three things the resolver compares. */
export interface ParsedModelId {
  /** The id, lowercased, without a trailing `[1m]`. */
  base: string;
  /** True when the id carried the `[1m]` suffix. */
  oneM: boolean;
  /** Non-digit segments joined by `-` (`claude-fable`, `gpt-sol`, `grok`). */
  family: string;
  /** Digit segments in order (`claude-fable-5-1` → `[5, 1]`). */
  version: number[];
}

/** What a single `/model` token resolved to. */
export type ModelAliasResolution =
  | { kind: "exact"; id: string }
  | { kind: "resolved"; id: string; family: string; via: "alias" | "family" }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unknown" };

/** A row of the resolution universe: an id plus the aliases llmux advertises. */
interface UniverseRow {
  id: string;
  aliases: readonly string[];
}

/**
 * Decompose a model id. Segments are split on BOTH `-` and `.` so the dashed
 * (`claude-fable-5-1`) and dotted (`gpt-5.6-sol`, `grok-4.7`) version
 * conventions land in the same shape; a date stamp is just another segment
 * (`claude-sonnet-4-5-20250929` → `[4, 5, 20250929]`), which is what makes it
 * sort above the undated `claude-sonnet-4-5`.
 */
export function parseModelId(id: string): ParsedModelId {
  const lower = String(id ?? "")
    .trim()
    .toLowerCase();
  const oneM = lower.endsWith(ONE_M_SUFFIX);
  const base = oneM ? lower.slice(0, -ONE_M_SUFFIX.length) : lower;

  const segments = base.split(/[-.]/).filter((s) => s.length > 0);
  const version: number[] = [];
  const familyParts: string[] = [];
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) version.push(Number(segment));
    else familyParts.push(segment);
  }

  return { base, oneM, family: familyParts.join("-"), version };
}

/**
 * Element-wise version comparison with a missing segment counting as 0, so
 * `[5] > [4, 5, 20250929]` (generation first) and `[4, 5, 20251001] > [4, 5]`
 * (a dated build beats the undated row of the same generation).
 */
function compareVersion(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The row an operator means by a family name.
 *
 * `[1m]` is a QUALIFIER here, not a tie-breaker: while the family has at least
 * one `[1m]` row, only those rows compete. llmux routinely serves the 256k half
 * of a new generation before its 1M twin, and treating `[1m]` as a mere
 * tie-break let that base row win on version alone — `/model grok` would have
 * silently dropped from `grok-4.7[1m]` to a 256k `grok-5` for as long as the
 * twin was missing, which is the opposite of the operator rule.
 *
 * A family with no `[1m]` row at all (`claude-haiku` today) falls back to
 * comparing every row. Inside the competing set the highest version wins, and
 * the first row in universe order survives a full tie — so the static roster's
 * spelling beats a duplicate catalog row.
 */
function bestOfFamily(rows: UniverseRow[], family: string): UniverseRow | null {
  const members = rows
    .map((row) => ({ row, parsed: parseModelId(row.id) }))
    .filter((member) => member.parsed.family === family);
  if (members.length === 0) return null;

  const oneMMembers = members.filter((member) => member.parsed.oneM);
  const competing = oneMMembers.length > 0 ? oneMMembers : members;

  let best = competing[0]!;
  for (const candidate of competing.slice(1)) {
    if (compareVersion(candidate.parsed.version, best.parsed.version) > 0) {
      best = candidate;
    }
  }
  return best.row;
}

function hasAlias(row: UniverseRow, token: string): boolean {
  return row.aliases.some((alias) => alias.trim().toLowerCase() === token);
}

/**
 * Resolve one `/model` token against `universe` (ids + llmux aliases, in the
 * order the caller offers them).
 *
 * Order of rules:
 *   1. exact id → that id, never promoted;
 *   2. a version-pinned alias (`opus-5`, `gpt-6`) → the `[1m]` twin of the row
 *      the alias sits on, since the operator already pinned the generation;
 *   3. otherwise the token names a family (via an alias or via the family name
 *      itself) — one family resolves, several are reported as ambiguous rather
 *      than guessed at;
 *   4. inside a family, {@link bestOfFamily} picks the newest `[1m]` row (or,
 *      for a family that has none, the newest row).
 */
export function resolveModelAlias(
  token: string,
  universe: ReadonlyArray<UniverseRow>
): ModelAliasResolution {
  const want = String(token ?? "")
    .trim()
    .toLowerCase();
  if (want.length === 0) return { kind: "unknown" };

  const rows = [...universe];

  // 1. Exact id — an explicit choice is honored verbatim.
  for (const row of rows) {
    if (row.id.trim().toLowerCase() === want) return { kind: "exact", id: row.id };
  }

  // 2. Version-pinned alias: the generation is already named, so the only
  //    question left is 1M vs base, and the rule says 1M.
  if (/\d/.test(want)) {
    const aliasRow = rows.find((row) => hasAlias(row, want));
    if (aliasRow) {
      const parsed = parseModelId(aliasRow.id);
      const oneMTwin = rows.find((row) => {
        const other = parseModelId(row.id);
        return other.base === parsed.base && other.oneM;
      });
      const picked = oneMTwin ?? aliasRow;
      return {
        kind: "resolved",
        id: picked.id,
        family: parsed.family,
        via: "alias",
      };
    }
  }

  // 3. Family match — an alias hit names its row's family; a bare family name
  //    (or one segment of it, `fable` out of `claude-fable`) names it directly.
  const families = new Set<string>();
  for (const row of rows) {
    const parsed = parseModelId(row.id);
    const byFamily = parsed.family === want || parsed.family.split("-").includes(want);
    if (hasAlias(row, want) || byFamily) families.add(parsed.family);
  }
  if (families.size === 0) return { kind: "unknown" };

  if (families.size > 1) {
    const candidates = [...families]
      .map((family) => bestOfFamily(rows, family)?.id)
      .filter((id): id is string => typeof id === "string")
      .sort();
    return { kind: "ambiguous", candidates };
  }

  // 4. Exactly one family → its newest (preferring [1m]).
  const family = [...families][0]!;
  const picked = bestOfFamily(rows, family);
  if (!picked) return { kind: "unknown" };
  return {
    kind: "resolved",
    id: picked.id,
    family,
    via: hasAlias(picked, want) ? "alias" : "family",
  };
}
