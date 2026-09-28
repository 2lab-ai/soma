/**
 * Model Configuration Management
 *
 * Manages dynamic model selection and per-context reasoning effort via
 * model-config.yaml. Effort is a named level (shared vocabulary in soma-lib
 * `domain/model-effort`), not a thinking-token budget — the token budget the
 * file used to persist (`reasoning: minimal|medium|…`) is migrated on load.
 */

import { existsSync, readFileSync, watch, writeFileSync } from "fs";
import { resolve } from "path";
import { type EffortLevel, isEffortLevel } from "soma-lib";
import { parse, stringify } from "yaml";

/**
 * Static fallback roster. This list is the floor of what the `/model` menu
 * offers — the llmux catalog (`config/model-catalog.ts`) only ever EXTENDS it,
 * so a dead llmux still leaves every model here selectable.
 */
export const AVAILABLE_MODELS: readonly string[] = [
  "claude-fable-5-1[1m]",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-8[1m]",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-haiku-4-5-20251001",
] as const;

/**
 * A model id. Deliberately `string`, not a literal union over
 * `AVAILABLE_MODELS`: ids now also come from the llmux catalog at runtime, so
 * the compiler cannot enumerate them. Validation is a runtime concern —
 * `isKnownModel()` in `config/model-catalog.ts`.
 */
export type ModelId = string;

/** Curated labels for the static roster. Catalog models bring their own name. */
export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  // llmux serves the fable line under the literal `[1m]` id (the SDK strips the
  // suffix before the API call); the shorthand aliases llmux advertises
  // (`fable`, `fable-5-1`) point at that same row, which is why the roster
  // carries the suffixed id and not the bare one.
  "claude-fable-5-1[1m]": "Fable 5.1 (1M)",
  // Kept as a label fallback only: `claude-fable-5` is no longer selectable
  // (MODEL_MIGRATIONS rolls it forward), but a catalog row or an in-flight
  // session may still need to render it.
  "claude-fable-5": "Fable 5 (1M)",
  "claude-sonnet-4-5-20250929": "Sonnet 4.5",
  "claude-opus-4-8[1m]": "Opus 4.8 (1M)",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-7": "Opus 4.7",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
};

// DEFAULT_MODEL follows "latest opus + 1M". When a new opus generation lands,
// add it to AVAILABLE_MODELS + MODEL_DISPLAY_NAMES and flip this constant.
// The `[1m]` suffix is stripped by claude-agent-sdk before the API call and
// signalled to the server via the `context-1m-2025-08-07` beta header; the
// suffix-bearing id stays the user-facing convention so the Telegram model
// menu can offer 1M as a distinct selectable variant.
export const DEFAULT_MODEL: ModelId = "claude-opus-4-8[1m]";

/**
 * Predicate for the Claude Opus family. Captures the contract that any opus
 * model uses adaptive thinking + xhigh effort and ignores the per-context
 * reasoning-token budget at the SDK layer. Single source of truth for the
 * branch logic that was previously inlined as `=== "claude-opus-4-7"` at four
 * call sites (claude-options, normalizeConfig, callback.ts ×2, usage-commands).
 *
 * The prefix is the whole opus line (`claude-opus-`), not `claude-opus-4-`:
 * the llmux catalog serves `claude-opus-5` / `claude-opus-5[1m]`, and under
 * the narrower prefix those fell through to the non-adaptive branch, kept
 * their `maxThinkingTokens`, and the API answered 400 on `budget_tokens`.
 */
export function isOpusFamily(model: string): boolean {
  return model.startsWith("claude-opus-");
}

/**
 * Predicate for the "adaptive-thinking" contract: models that run adaptive
 * thinking, take a named `effort` level, and REJECT a `budget_tokens`
 * thinking budget at the SDK layer (400). Opus 4.x/5.x, the whole fable line
 * and the Sonnet 5 line share this contract. The prefixes cover both the bare
 * ids and the suffixed `…[1m]` ids the roster/catalog carry.
 *
 * `claude-sonnet-5…` is matched with a negative lookahead so the non-adaptive
 * `claude-sonnet-4-5-…` (thinking budget, no effort parameter) stays out.
 *
 * This is the single source of truth for the call sites that previously
 * keyed off `isOpusFamily` directly (claude-options, callback.ts,
 * usage-commands). `isOpusFamily` stays as the literal opus membership check;
 * use THIS one wherever the adaptive-thinking behavior matters so new
 * families are covered automatically.
 */
export function usesAdaptiveThinking(model: string): boolean {
  return (
    isOpusFamily(model) ||
    model.startsWith("claude-fable-") ||
    /^claude-sonnet-5(?!\d)/.test(model)
  );
}

/**
 * Maps deprecated/legacy model IDs to their replacement.
 * Used by `normalizeConfig` to auto-upgrade persisted yaml on load.
 *
 * 4.7 → 4.8 is NOT migrated here: an explicit Opus 4.7 selection is a
 * user choice and we don't silently roll it forward. Only the default
 * (DEFAULT_MODEL above) follows "latest opus".
 *
 * `claude-fable-5` → `claude-fable-5-1[1m]` IS migrated, unlike opus 4.7:
 * the operator asked for it explicitly (2026-09-10, "fable → fable-5-1[1m]"),
 * so picking fable always means the 1M profile — including for configs
 * persisted before the roster changed.
 */
const MODEL_MIGRATIONS: Record<string, ModelId> = {
  "claude-opus-4-6": "claude-opus-4-7",
  "claude-fable-5": "claude-fable-5-1[1m]",
};

/**
 * True when `id` is a superseded model id that {@link normalizeConfig} rolls
 * forward. The `/model` menu uses this to drop such an id when the llmux
 * catalog still serves it: selecting it would hand the user a choice the next
 * config load silently rewrites. Validation (`isKnownModel`) deliberately does
 * NOT use it — a stale keyboard or an open session holding the old id must
 * still decode.
 *
 * Compared case-insensitively, matching how catalog ids are deduped.
 */
export function isMigratedModelId(id: string): boolean {
  if (typeof id !== "string") return false;
  const key = id.trim().toLowerCase();
  return Object.keys(MODEL_MIGRATIONS).some((m) => m.toLowerCase() === key);
}

export type { EffortLevel } from "soma-lib";

/**
 * Effort applied when a context has none persisted. `xhigh` is what the
 * adaptive-thinking models were hard-wired to before effort became a
 * selection (2026-09-28), so an untouched config keeps its behavior.
 */
export const DEFAULT_EFFORT: EffortLevel = "xhigh";

/**
 * Legacy `reasoning` (thinking-token budget tier, persisted by configs written
 * before 2026-09-28) → effort level. Budgets and levels are different axes,
 * so this is an intent mapping, not a token conversion: `none`/`minimal`
 * meant "spend little", `xhigh` meant "spend a lot".
 */
const LEGACY_REASONING_TO_EFFORT: Record<string, EffortLevel> = {
  none: "low",
  minimal: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

export interface ContextModelConfig {
  model?: ModelId;
  effort?: EffortLevel;
  /** Pre-2026-09-28 field; read once by {@link normalizeConfig}, never written. */
  reasoning?: string;
}

export interface ModelConfig {
  version: number;
  defaults: {
    model: ModelId;
    effort?: EffortLevel;
    /** Pre-2026-09-28 field; read once by {@link normalizeConfig}, never written. */
    reasoning?: string;
  };
  contexts: {
    general?: ContextModelConfig;
    summary?: ContextModelConfig;
    cron?: ContextModelConfig;
  };
}

export type ConfigContext = "general" | "summary" | "cron";

const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || process.cwd();
const CONFIG_PATH = resolve(WORKING_DIR, "model-config.yaml");

let currentConfig: ModelConfig | null = null;

function getDefaultConfig(): ModelConfig {
  return {
    version: 1,
    defaults: {
      model: DEFAULT_MODEL,
      effort: DEFAULT_EFFORT,
    },
    contexts: {
      general: {
        model: DEFAULT_MODEL,
        effort: "xhigh",
      },
      summary: {
        model: "claude-sonnet-4-5-20250929",
        effort: "low",
      },
      cron: {
        model: "claude-haiku-4-5-20251001",
        effort: "low",
      },
    },
  };
}

/**
 * Migrate one `{effort?, reasoning?}` pair in place. A valid `effort` wins;
 * otherwise a legacy `reasoning` tier maps to a level; the `reasoning` key is
 * dropped either way. Returns true when anything changed.
 */
function migrateEffortField(target: {
  effort?: EffortLevel;
  reasoning?: string;
}): boolean {
  let touched = false;
  if (target.effort !== undefined && !isEffortLevel(target.effort)) {
    // Hand-edited garbage — drop it so the default applies.
    delete target.effort;
    touched = true;
  }
  if (target.reasoning !== undefined) {
    if (target.effort === undefined) {
      const mapped = LEGACY_REASONING_TO_EFFORT[String(target.reasoning).toLowerCase()];
      if (mapped) target.effort = mapped;
    }
    delete target.reasoning;
    touched = true;
  }
  return touched;
}

/**
 * Walks `defaults.model` and every `contexts.*.model`, upgrading any model ID
 * present in `MODEL_MIGRATIONS` to its replacement, and converts the legacy
 * per-context `reasoning` budget tier into an `effort` level.
 *
 * Effort is NOT clamped to the model here: which levels a model supports is
 * catalog state (llmux) that changes at runtime, so the clamp happens where
 * the query is built (`resolveEffortForModel`). The persisted value is the
 * user's intent.
 *
 * Returns `changed: true` if any field was modified so callers can persist.
 */
export function normalizeConfig(config: ModelConfig): {
  config: ModelConfig;
  changed: boolean;
} {
  let changed = false;
  const next: ModelConfig = {
    ...config,
    defaults: { ...config.defaults },
    contexts: { ...config.contexts },
  };

  const migratedDefault = MODEL_MIGRATIONS[next.defaults.model as string];
  if (migratedDefault) {
    next.defaults.model = migratedDefault;
    changed = true;
  }
  if (migrateEffortField(next.defaults)) changed = true;
  if (next.defaults.effort === undefined) {
    next.defaults.effort = DEFAULT_EFFORT;
    changed = true;
  }

  const ctxKeys: ConfigContext[] = ["general", "summary", "cron"];
  for (const key of ctxKeys) {
    const ctx = next.contexts[key];
    if (!ctx) continue;
    const updated: ContextModelConfig = { ...ctx };
    let touched = false;
    if (updated.model) {
      const migrated = MODEL_MIGRATIONS[updated.model as string];
      if (migrated) {
        updated.model = migrated;
        touched = true;
      }
    }
    if (migrateEffortField(updated)) touched = true;
    if (touched) {
      next.contexts[key] = updated;
      changed = true;
    }
  }

  return { config: next, changed };
}

function loadConfig(): ModelConfig {
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = parse(content) as ModelConfig;
    if (!parsed.version || !parsed.defaults || !parsed.contexts) {
      console.warn("[ModelConfig] Invalid structure, using defaults");
      return getDefaultConfig();
    }
    const { config: normalized, changed } = normalizeConfig(parsed);
    if (changed) {
      console.log("[ModelConfig] Normalized legacy config, persisting...");
      // Fire-and-forget; saveConfig writes synchronously under the hood.
      void saveConfig(normalized);
    }
    return normalized;
  } catch (error) {
    // Never fall back silently: a bot running on defaults because its config
    // file is unreadable must be visible in the log (2026-09-28 p9 NUL tail).
    console.error(
      `[ModelConfig] Failed to load ${CONFIG_PATH}, using defaults:`,
      error instanceof Error ? error.message : error
    );
    return getDefaultConfig();
  }
}

export async function saveConfig(config: ModelConfig): Promise<void> {
  try {
    const content = stringify(config);
    writeFileSync(CONFIG_PATH, content, "utf-8");
    currentConfig = config;
    console.log("[ModelConfig] Saved to", CONFIG_PATH);
  } catch (error) {
    console.error("[ModelConfig] Failed to save:", error);
    throw error;
  }
}

export async function ensureConfigExists(): Promise<void> {
  if (!existsSync(CONFIG_PATH)) {
    const defaultConfig = getDefaultConfig();
    await saveConfig(defaultConfig);
    console.log("[ModelConfig] Created default config at", CONFIG_PATH);
  }
}

export function getModelForContext(context: ConfigContext): ModelId {
  if (!currentConfig) {
    currentConfig = loadConfig();
  }

  const ctx = currentConfig.contexts[context];
  return ctx?.model ?? currentConfig.defaults.model ?? DEFAULT_MODEL;
}

/**
 * The effort level persisted for `context` (falling back to `defaults`).
 * This is the user's intent, unclamped — pass it through
 * `resolveEffortForModel` (config/model-catalog) before handing it to the SDK.
 */
export function getEffortForContext(context: ConfigContext): EffortLevel {
  if (!currentConfig) {
    currentConfig = loadConfig();
  }
  const ctx = currentConfig.contexts[context];
  return ctx?.effort ?? currentConfig.defaults.effort ?? DEFAULT_EFFORT;
}

export async function updateContextModel(
  context: ConfigContext,
  model: ModelId,
  effort?: EffortLevel
): Promise<void> {
  if (!currentConfig) {
    currentConfig = loadConfig();
  }

  if (!currentConfig.contexts[context]) {
    currentConfig.contexts[context] = {};
  }

  currentConfig.contexts[context]!.model = model;
  if (effort) {
    currentConfig.contexts[context]!.effort = effort;
  }

  await saveConfig(currentConfig);
}

export function getCurrentConfig(): ModelConfig {
  if (!currentConfig) {
    currentConfig = loadConfig();
  }
  return currentConfig;
}

currentConfig = loadConfig();

try {
  watch(CONFIG_PATH, () => {
    console.log("[ModelConfig] File changed, reloading...");
    currentConfig = loadConfig();
  });
} catch {
  console.log("[ModelConfig] Config file not found, will create on first use");
}
