/**
 * Model Specifications — Source of Truth
 *
 * Per-model context window sizes, max output tokens, and capabilities.
 * Based on Anthropic official docs (2026-03-19).
 *
 * Reference: https://github.com/2lab-ai/soma-work/issues/43
 * - Opus 4.6 / Sonnet 4.6: 1M context window (GA, no beta header needed)
 * - Sonnet 4.5 / Sonnet 4: 1M with beta header 'context-1m-2025-08-07'
 * - Others: 200K default
 */

export interface ModelSpec {
  contextWindow: number;
  maxOutput: number;
  /** Whether this model needs the 'context-1m-2025-08-07' beta for 1M */
  needs1MBeta: boolean;
}

/**
 * Authoritative model specs. Context window in tokens.
 * Key = model ID substring that appears in the full API model ID.
 */
const MODEL_SPECS: Record<string, ModelSpec> = {
  "claude-opus-4-6": {
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    needs1MBeta: false, // GA since 2026-03-13
  },
  "claude-sonnet-4-6": {
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    needs1MBeta: false, // GA since 2026-03-13
  },
  "claude-haiku-4-5": {
    contextWindow: 200_000,
    maxOutput: 64_000,
    needs1MBeta: false,
  },
  "claude-sonnet-4-5": {
    contextWindow: 200_000, // 1M available with beta
    maxOutput: 64_000,
    needs1MBeta: true,
  },
  "claude-opus-4-5": {
    contextWindow: 200_000,
    maxOutput: 64_000,
    needs1MBeta: false,
  },
  "claude-opus-4-1": {
    contextWindow: 200_000,
    maxOutput: 32_000,
    needs1MBeta: false,
  },
  "claude-sonnet-4-0": {
    contextWindow: 200_000, // 1M available with beta
    maxOutput: 64_000,
    needs1MBeta: true,
  },
  "claude-opus-4-0": {
    contextWindow: 200_000,
    maxOutput: 32_000,
    needs1MBeta: false,
  },
};

/** Default fallback if model is unknown */
const DEFAULT_SPEC: ModelSpec = {
  contextWindow: 200_000,
  maxOutput: 64_000,
  needs1MBeta: false,
};

/**
 * Lookup model spec by model ID.
 * Matches by prefix to handle versioned IDs like "claude-opus-4-6-20260101".
 */
export function getModelSpec(modelId: string): ModelSpec {
  // Exact match first
  if (MODEL_SPECS[modelId]) return MODEL_SPECS[modelId];

  // Prefix match (e.g., "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5")
  for (const [key, spec] of Object.entries(MODEL_SPECS)) {
    if (modelId.startsWith(key)) return spec;
  }

  return DEFAULT_SPEC;
}

/**
 * Get the context window size for a model.
 */
export function getModelContextWindow(modelId: string): number {
  return getModelSpec(modelId).contextWindow;
}

/** SDK beta type — must match @anthropic-ai/claude-agent-sdk SdkBeta */
type SdkBeta = "context-1m-2025-08-07";

/**
 * Get beta headers needed for a model.
 * Returns array of beta strings to pass to SDK.
 */
export function getModelBetas(modelId: string): SdkBeta[] {
  const betas: SdkBeta[] = [];

  // Always include context-1m beta for compatibility.
  // - Opus 4.6/Sonnet 4.6: GA, beta is ignored but harmless
  // - Sonnet 4.5/4: Required for 1M activation
  betas.push("context-1m-2025-08-07");

  return betas;
}
