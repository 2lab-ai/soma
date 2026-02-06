/**
 * Model Configuration Management
 *
 * Manages dynamic model selection and reasoning token budgets via config.yaml
 */

import { watch, readFileSync, existsSync, writeFileSync } from "fs";
import { parse, stringify } from "yaml";
import { resolve } from "path";

// Model IDs (user-provided)
export const AVAILABLE_MODELS = [
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
] as const;

export type ModelId = (typeof AVAILABLE_MODELS)[number];

// Model aliases for UI display
export const MODEL_ALIASES: Record<string, ModelId> = {
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

// Reverse mapping for display
export const MODEL_DISPLAY_NAMES: Record<ModelId, string> = {
  "claude-sonnet-4-5-20250929": "Sonnet 4.5",
  "claude-opus-4-6": "Opus 4.6",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
};

export const DEFAULT_MODEL: ModelId = "claude-opus-4-6";

// Reasoning levels (user-provided token budgets)
export type ReasoningLevel = "none" | "minimal" | "medium" | "high" | "xhigh";

export const REASONING_TOKENS: Record<ReasoningLevel, number> = {
  none: 0,
  minimal: 4096,
  medium: 16384,
  high: 65536,
  xhigh: 131072,
};

export const DEFAULT_REASONING: ReasoningLevel = "high";

// Config structure
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

// Config path
const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || process.cwd();
const CONFIG_PATH = resolve(WORKING_DIR, "model-config.yaml");

// In-memory cache
let currentConfig: ModelConfig | null = null;

/**
 * Get default config structure
 */
function getDefaultConfig(): ModelConfig {
  return {
    version: 1,
    defaults: {
      model: DEFAULT_MODEL,
      reasoning: DEFAULT_REASONING,
    },
    contexts: {
      general: {
        model: "claude-opus-4-6",
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
 * Load config from disk
 */
function loadConfig(): ModelConfig {
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = parse(content) as ModelConfig;

    // Validate structure
    if (!parsed.version || !parsed.defaults || !parsed.contexts) {
      console.warn("[ModelConfig] Invalid structure, using defaults");
      return getDefaultConfig();
    }

    return parsed;
  } catch (error) {
    // File doesn't exist or parse error - use defaults
    return getDefaultConfig();
  }
}

/**
 * Save config to disk
 */
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

/**
 * Ensure config file exists (lazy creation)
 */
export async function ensureConfigExists(): Promise<void> {
  if (!existsSync(CONFIG_PATH)) {
    const defaultConfig = getDefaultConfig();
    await saveConfig(defaultConfig);
    console.log("[ModelConfig] Created default config at", CONFIG_PATH);
  }
}

/**
 * Get model for specific context
 */
export function getModelForContext(context: ConfigContext): ModelId {
  if (!currentConfig) {
    currentConfig = loadConfig();
  }

  const ctx = currentConfig.contexts[context];
  return ctx?.model ?? currentConfig.defaults.model ?? DEFAULT_MODEL;
}

/**
 * Get reasoning tokens for specific context
 */
export function getReasoningTokens(context: ConfigContext): number {
  if (!currentConfig) {
    currentConfig = loadConfig();
  }

  const ctx = currentConfig.contexts[context];
  const level = ctx?.reasoning ?? currentConfig.defaults.reasoning ?? DEFAULT_REASONING;
  return REASONING_TOKENS[level];
}

/**
 * Update model for specific context
 */
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

/**
 * Get current config (for display)
 */
export function getCurrentConfig(): ModelConfig {
  if (!currentConfig) {
    currentConfig = loadConfig();
  }
  return currentConfig;
}

// Initialize config on module load
currentConfig = loadConfig();

// Watch for config file changes (hot reload)
try {
  watch(CONFIG_PATH, () => {
    console.log("[ModelConfig] File changed, reloading...");
    currentConfig = loadConfig();
  });
} catch (error) {
  // File doesn't exist yet - will be created on first /model command
  console.log("[ModelConfig] Config file not found, will create on first use");
}
