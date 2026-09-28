import { describe, expect, test } from "bun:test";
import { DEFAULT_EFFORT, normalizeConfig, type ModelConfig } from "./model";

describe("normalizeConfig — model migrations", () => {
  test("upgrades legacy claude-opus-4-6 to claude-opus-4-7 in defaults and contexts", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-4-6" as any, effort: "high" },
      contexts: {
        general: { model: "claude-opus-4-6" as any, effort: "high" },
        summary: { model: "claude-sonnet-4-5-20250929", effort: "low" },
        cron: { model: "claude-haiku-4-5-20251001", effort: "low" },
      },
    };

    const { config, changed } = normalizeConfig(input);

    expect(changed).toBe(true);
    expect(config.defaults.model).toBe("claude-opus-4-7");
    expect(config.contexts.general?.model).toBe("claude-opus-4-7");
    // Effort is the user's intent — a model migration does not rewrite it.
    expect(config.contexts.general?.effort).toBe("high");
    expect(config.contexts.summary?.model).toBe("claude-sonnet-4-5-20250929");
    expect(config.contexts.summary?.effort).toBe("low");
    expect(config.contexts.cron?.model).toBe("claude-haiku-4-5-20251001");
    expect(config.contexts.cron?.effort).toBe("low");
  });

  test("no changes when already migrated and every context carries an effort", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-4-7", effort: "xhigh" },
      contexts: {
        general: { model: "claude-opus-4-7", effort: "high" },
        summary: { model: "claude-sonnet-4-5-20250929", effort: "low" },
        cron: { model: "claude-haiku-4-5-20251001", effort: "low" },
      },
    };

    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(false);
    expect(config).toEqual(input);
  });

  test("does not mutate original config object", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-4-6" as any, reasoning: "high" },
      contexts: {
        general: { model: "claude-opus-4-6" as any, reasoning: "high" },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(input));

    normalizeConfig(input);
    expect(input).toEqual(snapshot);
  });
});

describe("normalizeConfig — legacy `reasoning` budget tier → `effort` level", () => {
  test("maps every legacy tier and drops the reasoning key", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-4-7", reasoning: "high" },
      contexts: {
        general: { model: "claude-opus-4-7", reasoning: "xhigh" },
        summary: { model: "claude-sonnet-4-5-20250929", reasoning: "minimal" },
        cron: { model: "claude-haiku-4-5-20251001", reasoning: "none" },
      },
    };

    const { config, changed } = normalizeConfig(input);

    expect(changed).toBe(true);
    expect(config.defaults.effort).toBe("high");
    expect(config.defaults.reasoning).toBeUndefined();
    expect(config.contexts.general?.effort).toBe("xhigh");
    expect(config.contexts.summary?.effort).toBe("low");
    expect(config.contexts.cron?.effort).toBe("low");
    for (const ctx of Object.values(config.contexts)) {
      expect(ctx?.reasoning).toBeUndefined();
    }
  });

  test("`medium` maps to medium (the one tier whose name is also a level)", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-4-7", reasoning: "medium" },
      contexts: { general: { model: "claude-opus-4-7", reasoning: "medium" } },
    };
    const { config } = normalizeConfig(input);
    expect(config.defaults.effort).toBe("medium");
    expect(config.contexts.general?.effort).toBe("medium");
  });

  test("an adaptive-thinking context is NOT coerced to xhigh any more (effort is a real choice)", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-5[1m]", effort: "xhigh" },
      contexts: { general: { model: "claude-opus-5[1m]", effort: "low" } },
    };
    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(false);
    expect(config.contexts.general?.effort).toBe("low");
  });

  test("a valid `effort` wins over a stale `reasoning` sitting next to it", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-4-7", effort: "medium", reasoning: "xhigh" },
      contexts: {},
    };
    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(true);
    expect(config.defaults.effort).toBe("medium");
    expect(config.defaults.reasoning).toBeUndefined();
  });

  test("a hand-edited garbage effort is dropped and defaults fall back to DEFAULT_EFFORT", () => {
    const input = {
      version: 1,
      defaults: { model: "claude-opus-4-7", effort: "turbo" },
      contexts: { general: { model: "claude-opus-4-7", effort: "42" } },
    } as unknown as ModelConfig;
    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(true);
    expect(config.defaults.effort).toBe(DEFAULT_EFFORT);
    expect(config.contexts.general?.effort).toBeUndefined();
  });

  test("a config with neither field gets DEFAULT_EFFORT on defaults only", () => {
    const input = {
      version: 1,
      defaults: { model: "claude-opus-4-7" },
      contexts: { general: { model: "claude-opus-4-7" } },
    } as ModelConfig;
    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(true);
    expect(config.defaults.effort).toBe(DEFAULT_EFFORT);
    // Contexts without a choice inherit defaults at read time, not on disk.
    expect(config.contexts.general?.effort).toBeUndefined();
  });
});
