/**
 * Model Configuration Management
 *
 * Manages dynamic model selection and reasoning token budgets via config.yaml.
 */

import { existsSync, readFileSync, watch, writeFileSync } from "fs";
import { resolve } from "path";
import { parse, stringify } from "yaml";

export const AVAILABLE_MODELS = [
  "claude-fable-5",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-8[1m]",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-haiku-4-5-20251001",
] as const;

export type ModelId = (typeof AVAILABLE_MODELS)[number];

export const MODEL_DISPLAY_NAMES: Record<ModelId, string> = {
  // Fable 5 serves 1M context on the bare id (no `[1m]` suffix, no beta header
  // — see lookupContextWindowSize); the "(1M)" label communicates that window.
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
 * Predicate for the Claude Opus 4.x family. Captures the contract that
 * any opus-4.x model uses adaptive thinking + xhigh effort and ignores
 * the per-context reasoning-token budget at the SDK layer. Single source
 * of truth for the branch logic that was previously inlined as
 * `=== "claude-opus-4-7"` at four call sites (claude-options,
 * normalizeConfig, callback.ts ×2, usage-commands).
 */
export function isOpusFamily(model: string): boolean {
  return model.startsWith("claude-opus-4-");
}

/**
 * Predicate for the "adaptive-thinking" contract: models that always run
 * adaptive thinking + `xhigh` effort and REJECT a `budget_tokens` thinking
 * budget at the SDK layer (400). Opus 4.x AND Fable 5 share this contract
 * (Fable 5: adaptive thinking always-on, extended thinking unsupported).
 *
 * This is the single source of truth for the four call sites that previously
 * keyed off `isOpusFamily` directly (claude-options, normalizeConfig,
 * callback.ts ×2, usage-commands). `isOpusFamily` stays as the literal opus
 * membership check; use THIS one wherever the adaptive-thinking behavior
 * matters so new non-opus families (fable, …) are covered automatically.
 */
export function usesAdaptiveThinking(model: string): boolean {
  return isOpusFamily(model) || model.startsWith("claude-fable-");
}

/**
 * Maps deprecated/legacy model IDs to their replacement.
 * Used by `normalizeConfig` to auto-upgrade persisted yaml on load.
 *
 * 4.7 → 4.8 is NOT migrated here: an explicit Opus 4.7 selection is a
 * user choice and we don't silently roll it forward. Only the default
 * (DEFAULT_MODEL above) follows "latest opus".
 */
const MODEL_MIGRATIONS: Record<string, ModelId> = {
  "claude-opus-4-6": "claude-opus-4-7",
};

export type ReasoningLevel = "none" | "minimal" | "medium" | "high" | "xhigh";

export const REASONING_TOKENS: Record<ReasoningLevel, number> = {
  none: 0,
  minimal: 4096,
  medium: 16384,
  high: 65536,
  xhigh: 131072,
};

export const DEFAULT_REASONING: ReasoningLevel = "high";

export interface ModelConfig {
  version: number;
  defaults: {
    model: ModelId;
    reasoning: ReasoningLevel;
  };
  contexts: {
    general?: {
      model?: ModelId;
      reasoning?: ReasoningLevel;
    };
    summary?: {
      model?: ModelId;
      reasoning?: ReasoningLevel;
    };
    cron?: {
      model?: ModelId;
      reasoning?: ReasoningLevel;
    };
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
      reasoning: DEFAULT_REASONING,
    },
    contexts: {
      general: {
        model: DEFAULT_MODEL,
        reasoning: "high",
      },
      summary: {
        model: "claude-sonnet-4-5-20250929",
        reasoning: "minimal",
      },
      cron: {
        model: "claude-haiku-4-5-20251001",
        reasoning: "none",
      },
    },
  };
}

/**
 * Walks `defaults.model` and every `contexts.*.model`, upgrading any model ID
 * present in `MODEL_MIGRATIONS` to its replacement. For any context that
 * resolves to an adaptive-thinking model (Opus 4.x, Fable 5, …), coerces
 * `reasoning` to `"xhigh"` — those models use adaptive thinking + xhigh effort
 * and ignore the per-context reasoning-token budget at the SDK layer, so we
 * persist a value that matches actual behavior.
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

  const ctxKeys: ConfigContext[] = ["general", "summary", "cron"];
  for (const key of ctxKeys) {
    const ctx = next.contexts[key];
    if (!ctx) continue;
    const updated = { ...ctx };
    let touched = false;
    if (updated.model) {
      const migrated = MODEL_MIGRATIONS[updated.model as string];
      if (migrated) {
        updated.model = migrated;
        touched = true;
      }
    }
    const resolved = updated.model ?? next.defaults.model;
    if (usesAdaptiveThinking(resolved) && updated.reasoning !== "xhigh") {
      updated.reasoning = "xhigh";
      touched = true;
    }
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
  } catch {
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

export async function updateContextModel(
  context: ConfigContext,
  model: ModelId,
  reasoning?: ReasoningLevel
): Promise<void> {
  if (!currentConfig) {
    currentConfig = loadConfig();
  }

  if (!currentConfig.contexts[context]) {
    currentConfig.contexts[context] = {};
  }

  currentConfig.contexts[context]!.model = model;
  if (reasoning) {
    currentConfig.contexts[context]!.reasoning = reasoning;
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
