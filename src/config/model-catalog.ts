/**
 * llmux model-catalog overlay (`GET /llmux/models`).
 *
 * Runtime store that makes every model the local llmux proxy is willing to
 * serve (opus-5 line, codex `gpt-*`, `grok-*`, …) selectable from the Telegram
 * `/model` menu WITHOUT touching the static `AVAILABLE_MODELS` roster in
 * `model.ts`.
 *
 * **Auth-mode gate.** Everything that makes a model *selectable* (menu roster,
 * id validation, refresh) is live only in llmux mode — in oauth mode the SDK
 * bypasses the proxy, so an llmux-only id would be selectable but unroutable.
 * Pure lookups (`getDisplayName`, `getCatalogMaxContext`) stay ungated so a
 * config saved before a mode flip still renders correctly.
 *
 * **Extend-only contract.** The catalog may only ADD entries on top of the
 * static roster. llmux being down, answering garbage, or answering an empty
 * list falls back to the on-disk snapshot and then to the static roster — the
 * selectable set never shrinks below `AVAILABLE_MODELS`.
 *
 * **"Shorthand means 1M" (operator rule 2026-09-10).** llmux publishes many
 * models as a twin pair — `gpt-6-astra` (272k) and `gpt-6-astra[1m]` (1M) —
 * and hangs its shorthand ALIASES on exactly one of the two. soma has no alias
 * layer: the `/model` menu picks by id, so when the operator's shorthand
 * (`astra`, `opus`, `fable`) resolves to the `[1m]` row, offering the base row
 * as well makes "pick astra" a coin flip between two context windows.
 *
 * The predicate is llmux's own metadata, not the id text: a catalog base row
 * `X` is hidden only when `X[1m]` is also offered AND that `[1m]` row carries
 * at least one alias. Live today that hides `gpt-6-astra`, `claude-opus-5` and
 * `claude-sonnet-5` (aliases live on their `[1m]` twins) while `gpt-5.6-sol`
 * and `gpt-5.6-terra` stay visible (there the aliases sit on the BASE row, so
 * the shorthand already means the base and nothing is ambiguous).
 *
 * Two carve-outs: static roster rows are never hidden (they are the floor, and
 * `claude-opus-4-8` + `claude-opus-4-8[1m]` are both there on purpose), and the
 * hide is menu-only — {@link isKnownModel} still accepts every base id so a
 * session or config already holding one keeps resolving.
 *
 * Superseded ids are also dropped from the menu: a catalog row whose id is a
 * `MODEL_MIGRATIONS` source (`claude-fable-5`) would otherwise re-enter the
 * menu through the catalog and hand the user a selection that `normalizeConfig`
 * immediately rewrites on the next load.
 *
 * Layering: this module imports `model.ts` (roster + labels) and nothing else
 * from the app, so importing it can never drag in the bot runtime. The llmux
 * fetch is a module-level injectable (`setCatalogFetcher`) with an HTTP
 * default; under `bun test` the default is withheld unless a fetcher was
 * injected, so unit tests can never hit the network by accident.
 *
 * Persistence: `${CLAUDE_WORKING_DIR}/data/model-catalog.json`, written
 * atomically (tmp → renameSync, previous file kept as `.bak`) and loaded
 * synchronously at module import so a cold start already knows the last
 * catalog before the first refresh returns.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import {
  type CatalogModel,
  clampEffortToSupported,
  type EffortLevel,
  normalizeCatalogEntries,
  normalizeEffortInput,
  rankSupportedEfforts,
  SDK_EFFORT_LEVELS,
} from "soma-lib";
import { isLlmuxMode } from "./llmux";
import { type ModelAliasResolution, resolveModelAlias } from "./model-alias";
import {
  AVAILABLE_MODELS,
  isMigratedModelId,
  MODEL_DISPLAY_NAMES,
  usesAdaptiveThinking,
} from "./model";

/**
 * Normalized catalog entry — the shared soma-lib row shape (`max_context` →
 * `maxContext`, efforts/aliases lowercased). `aliases` is llmux's shorthand
 * list for the row (`astra`, `fable`, `opus-5`, …) and is the ground truth
 * behind the "shorthand means 1M" rule — llmux, not soma, decides which row
 * an operator's shorthand resolves to.
 */
export type { CatalogModel };

/** One row of the `/model` menu: a model id plus the label to render. */
export interface SelectableModel {
  id: string;
  displayName: string;
  group: string;
}

export type CatalogFetcher = () => Promise<unknown[]>;

export interface RefreshOptions {
  /** Bypass the attempt cooldown (menu-open refresh spam is still deduped in-flight). */
  force?: boolean;
  /** Fetch implementation for this call only (tests / one-off probes). */
  fetchImpl?: CatalogFetcher;
}

export interface RefreshResult {
  ok: boolean;
  /** Entry count after the refresh (unchanged count on failure/skip). */
  count: number;
  /** True when no fetch was attempted (cooldown or no fetcher wired). */
  skipped?: boolean;
  error?: string;
}

interface SnapshotShape {
  fetchedAt: number | null;
  models: CatalogModel[];
}

const SNAPSHOT_FILE_NAME = "model-catalog.json";
const DEFAULT_LLMUX_BASE_URL = "http://localhost:3456";
const DEFAULT_LLMUX_API_KEY = "llmux-local-placeholder";
const FETCH_TIMEOUT_MS = 5_000;
/** Min gap between two fetch attempts (success or failure). */
const REFRESH_COOLDOWN_MS = 60_000;
/** Stale-while-revalidate TTL for {@link refreshCatalogIfStale}. */
const REFRESH_TTL_MS = 10 * 60_000;
/** llmux's 1M-context id suffix, lowercased (see the "shorthand means 1M" rule). */
const ONE_M_SUFFIX = "[1m]";

function snapshotPath(): string {
  if (snapshotPathOverride) return snapshotPathOverride;
  const workingDir = process.env.CLAUDE_WORKING_DIR || process.cwd();
  return resolve(join(workingDir, "data", SNAPSHOT_FILE_NAME));
}

/**
 * Best-effort group for a model the catalog does not know (the static roster
 * has no group of its own). Purely cosmetic — it only drives the menu's
 * section labels.
 */
function inferGroup(id: string): string {
  if (id.startsWith("claude-")) return "claude";
  if (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3"))
    return "codex";
  if (id.startsWith("grok")) return "grok";
  return "other";
}

/**
 * Defensive normalization of the `/llmux/models` payload (shared soma-lib
 * normalizer): entries without a usable string `id` are dropped, ids are
 * deduped case-insensitively, and both the wire (`max_context`) and snapshot
 * (`maxContext`) spellings are accepted. soma's only local policy is the
 * cosmetic group inference for rows llmux does not label.
 */
function normalizeEntries(raw: unknown[]): CatalogModel[] {
  return normalizeCatalogEntries(raw, { fallbackGroup: inferGroup });
}

// ---------------------------------------------------------------- module state

let entries: CatalogModel[] = [];
let byId = new Map<string, CatalogModel>();
let fetchedAt: number | null = null;
let lastAttemptAt = 0;
let inFlight: Promise<RefreshResult> | null = null;
let injectedFetcher: CatalogFetcher | null = null;
let snapshotPathOverride: string | null = null;

function setEntries(next: CatalogModel[]): void {
  entries = next;
  byId = new Map(next.map((m) => [m.id.toLowerCase(), m]));
}

// -------------------------------------------------------------- default fetch

/**
 * `GET {LLMUX_BASE_URL}/llmux/models`. The loopback llmux exempts localhost
 * from auth, but the header is sent anyway so a remote `LLMUX_BASE_URL` works
 * with `LLMUX_API_KEY`.
 */
async function fetchLlmuxModels(): Promise<unknown[]> {
  const baseUrl = process.env.LLMUX_BASE_URL?.trim() || DEFAULT_LLMUX_BASE_URL;
  const apiKey = process.env.LLMUX_API_KEY?.trim() || DEFAULT_LLMUX_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/llmux/models`, {
      method: "GET",
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`llmux /llmux/models returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { models?: unknown };
    return Array.isArray(payload?.models) ? payload.models : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the fetcher for a refresh. Under `bun test` the HTTP default is
 * withheld: a unit test that never injected a fetcher must not reach a real
 * llmux daemon on the developer's machine.
 */
function resolveFetcher(fetchImpl?: CatalogFetcher): CatalogFetcher | null {
  if (fetchImpl) return fetchImpl;
  if (injectedFetcher) return injectedFetcher;
  if (process.env.NODE_ENV === "test") return null;
  return fetchLlmuxModels;
}

/** Inject the llmux fetch implementation (`null` restores the HTTP default). */
export function setCatalogFetcher(fetcher: CatalogFetcher | null): void {
  injectedFetcher = fetcher;
}

// ---------------------------------------------------------------- persistence

/** Load the snapshot from disk. Corrupt/absent files are ignored (never throw). */
export function loadSnapshotSync(): void {
  const file = snapshotPath();
  for (const candidate of [file, `${file}.bak`]) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(
        readFileSync(candidate, "utf-8")
      ) as Partial<SnapshotShape>;
      if (!Array.isArray(parsed?.models)) {
        console.warn(
          `[ModelCatalog] Snapshot has no models array, ignoring: ${candidate}`
        );
        continue;
      }
      const normalized = normalizeEntries(parsed.models);
      if (normalized.length === 0) {
        // A recent-but-empty (or all-malformed) snapshot must not mark the
        // catalog fresh — refreshCatalogIfStale would short-circuit and the
        // static-only roster would be shown forever. Fall through to the
        // `.bak` (or leave entries alone if that is also empty).
        console.warn(
          `[ModelCatalog] Snapshot has no usable entries after normalize, ignoring: ${candidate}`
        );
        continue;
      }
      setEntries(normalized);
      fetchedAt = typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : null;
      return;
    } catch (error) {
      console.warn(
        `[ModelCatalog] Failed to load snapshot ${candidate}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}

/** Atomic snapshot write: tmp → rename, previous file kept as `.bak`. Never throws. */
function saveSnapshot(): void {
  const file = snapshotPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const payload: SnapshotShape = { fetchedAt, models: entries };
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    if (existsSync(file)) copyFileSync(file, `${file}.bak`);
    renameSync(tmp, file);
  } catch (error) {
    console.warn(
      "[ModelCatalog] Failed to save snapshot:",
      error instanceof Error ? error.message : error
    );
  }
}

// -------------------------------------------------------------------- refresh

/**
 * Fetch the catalog from llmux. Success replaces the entries and persists a
 * snapshot; failure WARNs and keeps whatever is already known (never
 * downgrade). In-flight calls are deduped and attempts are rate-limited to one
 * per {@link REFRESH_COOLDOWN_MS} unless `force` is set.
 */
export function refreshCatalog(opts?: RefreshOptions): Promise<RefreshResult> {
  // oauth mode never routes through llmux, so there is nothing to ask.
  if (!isLlmuxMode()) {
    return Promise.resolve({
      ok: false,
      count: entries.length,
      skipped: true,
      error: "auth mode is oauth",
    });
  }
  if (inFlight) return inFlight;

  const fetcher = resolveFetcher(opts?.fetchImpl);
  if (!fetcher) {
    return Promise.resolve({
      ok: false,
      count: entries.length,
      skipped: true,
      error: "no fetcher wired",
    });
  }
  const now = Date.now();
  if (!opts?.force && now - lastAttemptAt < REFRESH_COOLDOWN_MS) {
    return Promise.resolve({
      ok: false,
      count: entries.length,
      skipped: true,
      error: "cooldown",
    });
  }
  const previousAttemptAt = lastAttemptAt;
  lastAttemptAt = now;

  inFlight = (async (): Promise<RefreshResult> => {
    try {
      const models = await fetcher();
      const normalized = normalizeEntries(Array.isArray(models) ? models : []);
      if (normalized.length === 0) {
        // Empty (or all-malformed) response is not a fresh snapshot: keep the
        // previously-known entries and DO NOT bump `fetchedAt`, so the next
        // `refreshCatalogIfStale` refetches instead of trusting the emptiness.
        // Restore `lastAttemptAt` too so the retry isn't wedged behind cooldown.
        lastAttemptAt = previousAttemptAt;
        console.warn(
          `[ModelCatalog] Refresh returned no usable entries (keeping ${entries.length} known models)`
        );
        return {
          ok: false,
          count: entries.length,
          error: "empty or malformed catalog response",
        };
      }
      setEntries(normalized);
      fetchedAt = Date.now();
      saveSnapshot();
      console.log(`[ModelCatalog] Refreshed llmux catalog (${entries.length} models)`);
      return { ok: true, count: entries.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[ModelCatalog] Refresh failed (keeping ${entries.length} known models): ${message}`
      );
      return { ok: false, count: entries.length, error: message };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Awaitable TTL gate over {@link refreshCatalog}. Callers (`/model` menu open)
 * `await` this so a just-fetched roster lands in THIS render, not the next
 * open. The oauth / no-fetcher / cooldown / in-flight / failure branches all
 * live in `refreshCatalog`, so this layer only decides "snapshot too old to
 * trust?" and never rejects.
 */
export async function refreshCatalogIfStale(): Promise<void> {
  if (fetchedAt !== null && Date.now() - fetchedAt < REFRESH_TTL_MS) return;
  await refreshCatalog();
}

// ------------------------------------------------------------------ accessors

export function getCatalogModels(): CatalogModel[] {
  return [...entries];
}

function lookup(id: string): CatalogModel | null {
  if (typeof id !== "string") return null;
  const key = id.trim().toLowerCase();
  if (key.length === 0) return null;
  return byId.get(key) ?? null;
}

/**
 * The `/model` menu roster: the static `AVAILABLE_MODELS` first (in their
 * curated order), then every catalog id the static list does not already
 * carry. This is where the extend-only contract is enforced.
 *
 * In oauth mode the catalog contributes NOTHING: `buildProviderEnv()` returns
 * undefined there, so a query goes straight to Anthropic and an llmux-only id
 * (`gpt-*`, `grok-*`) has no route. Selection and routing must agree, so the
 * menu shrinks back to the static roster rather than offering models that
 * cannot be served.
 */
export function getSelectableModels(): SelectableModel[] {
  const out: SelectableModel[] = [];
  const seen = new Set<string>();
  for (const id of AVAILABLE_MODELS) {
    seen.add(id.toLowerCase());
    out.push({
      id,
      displayName: getDisplayName(id),
      group: lookup(id)?.group ?? inferGroup(id),
    });
  }
  if (!isLlmuxMode()) return out;
  // Every id on offer → the twin test below sees roster rows too. The value is
  // the catalog row carrying the alias metadata (`null` for a roster id llmux
  // does not describe — no metadata, so no hiding decision can be made).
  const offered = new Map<string, CatalogModel | null>();
  for (const id of AVAILABLE_MODELS) offered.set(id.toLowerCase(), lookup(id));
  for (const model of entries) offered.set(model.id.toLowerCase(), model);

  for (const model of entries) {
    const key = model.id.toLowerCase();
    if (seen.has(key)) continue;
    if (isMigratedModelId(model.id)) continue;
    if (shorthandResolvesToOneMTwin(key, offered)) continue;
    seen.add(key);
    out.push({
      id: model.id,
      displayName: getDisplayName(model.id),
      group: model.group,
    });
  }
  return out;
}

/**
 * True when `key` (an already-lowercased id) is a base id whose 1M twin is on
 * offer AND carries llmux aliases — the "shorthand means 1M" rule from the
 * module doc. An id that already ends in `[1m]` is never hidden by its own
 * base, and a twin with no aliases hides nothing: there the shorthand (if any)
 * points at the base row, so both windows stay reachable.
 */
function shorthandResolvesToOneMTwin(
  key: string,
  offered: ReadonlyMap<string, CatalogModel | null>
): boolean {
  if (key.endsWith(ONE_M_SUFFIX)) return false;
  const twin = offered.get(`${key}${ONE_M_SUFFIX}`);
  return twin != null && twin.aliases.length > 0;
}

/**
 * True for the static roster ∪ the current catalog (case-insensitive).
 * In oauth mode only the static roster counts — same reason as
 * {@link getSelectableModels}: an unroutable id must not pass validation
 * (callback decode, persisted `lastUsedModel`).
 *
 * Deliberately WIDER than {@link getSelectableModels}: an id the menu hides
 * (shorthand-twin base, superseded migration source) is still routable, so an
 * already-persisted config, an open session, or a keyboard already sitting in
 * a chat must keep validating.
 */
export function isKnownModel(id: string): boolean {
  if (typeof id !== "string") return false;
  const key = id.trim().toLowerCase();
  if (key.length === 0) return false;
  if ((AVAILABLE_MODELS as readonly string[]).some((m) => m.toLowerCase() === key))
    return true;
  return isLlmuxMode() && byId.has(key);
}

// ------------------------------------------------------------- alias resolving

/**
 * The universe `/model <token>` resolves against: the static roster first (in
 * its curated order, no aliases of its own), then the catalog rows with the
 * aliases llmux advertises. Deliberately the same set as {@link isKnownModel} —
 * a token must never resolve to an id that would then fail validation — which
 * is also why the catalog contributes nothing in oauth mode.
 */
function resolutionUniverse(): Array<{ id: string; aliases: readonly string[] }> {
  const universe: Array<{ id: string; aliases: readonly string[] }> = (
    AVAILABLE_MODELS as readonly string[]
  ).map((id) => ({ id, aliases: [] as readonly string[] }));
  if (!isLlmuxMode()) return universe;
  for (const model of entries) universe.push({ id: model.id, aliases: model.aliases });
  return universe;
}

/**
 * Resolve a `/model` argument (`fable`, `opus-5`, an exact id) against the live
 * roster. Rules live in `config/model-alias.ts`; this is only the wiring.
 */
export function resolveModelInput(token: string): ModelAliasResolution {
  return resolveModelAlias(token, resolutionUniverse());
}

/** Every shorthand the current roster answers to, sorted — for error replies. */
export function getKnownAliases(): string[] {
  const out = new Set<string>();
  for (const row of resolutionUniverse()) {
    for (const alias of row.aliases) {
      const key = alias.trim().toLowerCase();
      if (key.length > 0) out.add(key);
    }
  }
  return [...out].sort();
}

/**
 * Label chain: curated `MODEL_DISPLAY_NAMES` label → catalog name → raw id.
 *
 * The curated label deliberately wins for the static roster. llmux names the
 * suffixed ids after their base model (`claude-opus-4-8[1m]` → "Claude Opus
 * 4.8"), which drops the very distinction that row exists for — the menu would
 * render "Claude Opus 4.8" and "Opus 4.8" as two rows that read the same.
 * Catalog-only ids have no curated label and keep llmux's name.
 */
export function getDisplayName(id: string): string {
  const curated = MODEL_DISPLAY_NAMES[id];
  if (curated) return curated;
  return lookup(id)?.name || id;
}

/** Catalog-declared context window, or `null` when unknown. */
export function getCatalogMaxContext(id: string): number | null {
  return lookup(id)?.maxContext ?? null;
}

// --------------------------------------------------------------------- effort

/**
 * The effort levels the `/model` menu may offer for `id`, canonically ordered.
 *
 * Source of truth is llmux's per-row `efforts` (it knows what each backend
 * accepts — codex tiers add `ultra`, grok stops at `xhigh`). When the catalog
 * has no row or an empty menu, the static contract decides: adaptive-thinking
 * Claude models take the five SDK levels; every other model (Sonnet 4.5,
 * Haiku 4.5, an unknown non-Claude id) offers none — those are driven by the
 * keyword thinking budget instead, and sending `effort` to them is a 400.
 *
 * Non-adaptive Claude models are pinned to "none" even when the catalog lists
 * levels for them: the upstream API rejects `output_config.effort` on Sonnet
 * 4.5 / Haiku 4.5 regardless of what the proxy is willing to forward.
 */
export function getSupportedEfforts(id: string): EffortLevel[] {
  if (id.startsWith("claude-") && !usesAdaptiveThinking(id)) return [];
  const fromCatalog = lookup(id)?.efforts ?? [];
  const ranked = rankSupportedEfforts(fromCatalog);
  if (ranked.length > 0) return ranked;
  return usesAdaptiveThinking(id) ? [...SDK_EFFORT_LEVELS] : [];
}

/** True when `id` takes a named effort level at all (see {@link getSupportedEfforts}). */
export function supportsEffort(id: string): boolean {
  return getSupportedEfforts(id).length > 0;
}

/**
 * The effort to actually send for `id` given the user's persisted choice:
 * `null` when the model takes no effort parameter, otherwise `requested`
 * clamped onto the model's menu (soma-lib `clampEffortToSupported` — the
 * strongest supported level ≤ requested, else the weakest supported one).
 */
export function resolveEffortForModel(
  id: string,
  requested: EffortLevel | string | null | undefined
): EffortLevel | null {
  const supported = getSupportedEfforts(id);
  if (supported.length === 0) return null;
  // A string that names no level (blank, or hand-edited garbage that slipped
  // past normalizeConfig) is "no request" — never forwarded verbatim, since
  // the CLI rejects an unknown `--effort` and the whole query would fail.
  const want = normalizeEffortInput(requested ?? "");
  if (!want) return null;
  return clampEffortToSupported(supported, want) as EffortLevel;
}

// ----------------------------------------------------------------- test hooks

/** TEST ONLY — clear entries, timestamps and the injected fetcher. */
export function __testResetCatalog(): void {
  setEntries([]);
  fetchedAt = null;
  lastAttemptAt = 0;
  inFlight = null;
  injectedFetcher = null;
}

/** TEST ONLY — seed entries from raw wire-shaped objects; marks the catalog fresh. */
export function __testSeedCatalog(raw: unknown[]): void {
  setEntries(normalizeEntries(raw));
  fetchedAt = Date.now();
}

/** TEST ONLY — pin the internal `fetchedAt` (used to exercise the TTL boundary). */
export function __testSetFetchedAt(value: number | null): void {
  fetchedAt = value;
}

/** TEST ONLY — the stale-while-revalidate TTL (10 min), exposed so boundary tests
 *  pin the exact constant without duplicating the literal. */
export const REFRESH_TTL_MS_FOR_TESTS: number = REFRESH_TTL_MS;

/** TEST ONLY — redirect the snapshot file (`null` restores the default path). */
export function setSnapshotPathForTests(filePath: string | null): void {
  snapshotPathOverride = filePath;
}

// Load the last known catalog before any importer reads the roster, so a cold
// start renders the full menu instead of the static roster alone.
loadSnapshotSync();
