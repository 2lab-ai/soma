/**
 * Model Configuration Management
 *
 * Manages dynamic model selection and reasoning token budgets via config.yaml.
 */

import { existsSync, readFileSync, watch, writeFileSync } from "fs";
import { resolve } from "path";
import { parse, stringify } from "yaml";

export const AVAILABLE_MODELS = [
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
] as const;

export type ModelId = (typeof AVAILABLE_MODELS)[number];

export const MODEL_DISPLAY_NAMES: Record<ModelId, string> = {
  "claude-sonnet-4-5-20250929": "Sonnet 4.5",
  "claude-opus-4-6": "Opus 4.6",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
};

export const DEFAULT_MODEL: ModelId = "claude-opus-4-6";

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

function loadConfig(): ModelConfig {
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = parse(content) as ModelConfig;
    if (!parsed.version || !parsed.defaults || !parsed.contexts) {
      console.warn("[ModelConfig] Invalid structure, using defaults");
      return getDefaultConfig();
    }
    return parsed;
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
