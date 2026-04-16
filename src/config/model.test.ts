import { describe, expect, test } from "bun:test";
import { normalizeConfig, type ModelConfig } from "./model";

describe("normalizeConfig", () => {
  test("upgrades legacy claude-opus-4-6 to claude-opus-4-7 and persists xhigh", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: {
        model: "claude-opus-4-6" as any,
        reasoning: "high",
      },
      contexts: {
        general: {
          model: "claude-opus-4-6" as any,
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

    const { config, changed } = normalizeConfig(input);

    expect(changed).toBe(true);
    expect(config.defaults.model).toBe("claude-opus-4-7");
    expect(config.contexts.general?.model).toBe("claude-opus-4-7");
    // Opus 4.7 contexts should have reasoning coerced to xhigh
    expect(config.contexts.general?.reasoning).toBe("xhigh");
    // Sonnet/Haiku contexts untouched
    expect(config.contexts.summary?.model).toBe("claude-sonnet-4-5-20250929");
    expect(config.contexts.summary?.reasoning).toBe("minimal");
    expect(config.contexts.cron?.model).toBe("claude-haiku-4-5-20251001");
    expect(config.contexts.cron?.reasoning).toBe("none");
  });

  test("no changes when already on claude-opus-4-7 with xhigh", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-4-7", reasoning: "xhigh" },
      contexts: {
        general: { model: "claude-opus-4-7", reasoning: "xhigh" },
        summary: { model: "claude-sonnet-4-5-20250929", reasoning: "minimal" },
        cron: { model: "claude-haiku-4-5-20251001", reasoning: "none" },
      },
    };

    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(false);
    expect(config).toEqual(input);
  });

  test("coerces reasoning when Opus 4.7 context has stale reasoning level", () => {
    const input: ModelConfig = {
      version: 1,
      defaults: { model: "claude-opus-4-7", reasoning: "xhigh" },
      contexts: {
        general: { model: "claude-opus-4-7", reasoning: "high" },
      },
    };

    const { config, changed } = normalizeConfig(input);
    expect(changed).toBe(true);
    expect(config.contexts.general?.reasoning).toBe("xhigh");
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
