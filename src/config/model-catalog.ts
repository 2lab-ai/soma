/**
 * llmux model-catalog overlay (`GET /llmux/models`).
 *
 * Runtime store that makes every model the local llmux proxy is willing to
 * serve (opus-5 line, codex `gpt-*`, `grok-*`, …) selectable from the Telegram
 * `/model` menu WITHOUT touching the static `AVAILABLE_MODELS` roster in
 * `model.ts`.
 *
 * **Extend-only contract.** The catalog may only ADD entries on top of the
 * static roster. llmux being down, answering garbage, or answering an empty
 * list falls back to the on-disk snapshot and then to the static roster — the
 * selectable set never shrinks below `AVAILABLE_MODELS`.
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

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { AVAILABLE_MODELS, MODEL_DISPLAY_NAMES } from "./model";

/** Normalized catalog entry (`max_context` → `maxContext`, efforts lowercased). */
export interface CatalogModel {
  id: string;
  name: string;
  group: string;
  efforts: string[];
  maxContext: number | null;
}

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
/** Stale-while-revalidate TTL for {@link maybeRefreshInBackground}. */
const REFRESH_TTL_MS = 10 * 60_000;

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
  if (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3")) return "codex";
  if (id.startsWith("grok")) return "grok";
  return "other";
}

/**
 * Defensive normalization of the `/llmux/models` payload: entries without a
 * usable string `id` are dropped, ids are deduped case-insensitively, and both
 * the wire (`max_context`) and snapshot (`maxContext`) spellings are accepted.
 */
function normalizeEntries(raw: unknown[]): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (id.length === 0) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const efforts = Array.isArray(e.efforts)
      ? e.efforts
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => x.trim().toLowerCase())
      : [];
    const rawWindow = e.max_context ?? e.maxContext;
    const maxContext =
      typeof rawWindow === "number" && Number.isFinite(rawWindow) && rawWindow > 0
        ? rawWindow
        : null;
    const group = typeof e.group === "string" && e.group.trim().length > 0
      ? e.group.trim().toLowerCase()
      : inferGroup(id);

    out.push({
      id,
      name: typeof e.name === "string" && e.name.trim().length > 0 ? e.name.trim() : id,
      group,
      efforts,
      maxContext,
    });
  }
  return out;
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
      const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as Partial<SnapshotShape>;
      if (!Array.isArray(parsed?.models)) {
        console.warn(`[ModelCatalog] Snapshot has no models array, ignoring: ${candidate}`);
        continue;
      }
      setEntries(normalizeEntries(parsed.models));
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
    return Promise.resolve({ ok: false, count: entries.length, skipped: true, error: "cooldown" });
  }
  lastAttemptAt = now;

  inFlight = (async (): Promise<RefreshResult> => {
    try {
      const models = await fetcher();
      setEntries(normalizeEntries(Array.isArray(models) ? models : []));
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
 * Fire-and-forget refresh when the catalog is stale (> 10 min). Callers (the
 * `/model` menu) must never block or fail on catalog freshness, so every error
 * is swallowed.
 */
export function maybeRefreshInBackground(): void {
  if (fetchedAt !== null && Date.now() - fetchedAt < REFRESH_TTL_MS) return;
  void refreshCatalog().catch(() => {
    /* refreshCatalog never rejects; defensive */
  });
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
 */
export function getSelectableModels(): SelectableModel[] {
  const out: SelectableModel[] = [];
  const seen = new Set<string>();
  for (const id of AVAILABLE_MODELS) {
    seen.add(id.toLowerCase());
    out.push({ id, displayName: getDisplayName(id), group: lookup(id)?.group ?? inferGroup(id) });
  }
  for (const model of entries) {
    const key = model.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: model.id, displayName: getDisplayName(model.id), group: model.group });
  }
  return out;
}

/** True for the static roster ∪ the current catalog (case-insensitive). */
export function isKnownModel(id: string): boolean {
  if (typeof id !== "string") return false;
  const key = id.trim().toLowerCase();
  if (key.length === 0) return false;
  if ((AVAILABLE_MODELS as readonly string[]).some((m) => m.toLowerCase() === key)) return true;
  return byId.has(key);
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

/** TEST ONLY — redirect the snapshot file (`null` restores the default path). */
export function setSnapshotPathForTests(filePath: string | null): void {
  snapshotPathOverride = filePath;
}

// Load the last known catalog before any importer reads the roster, so a cold
// start renders the full menu instead of the static roster alone.
loadSnapshotSync();
