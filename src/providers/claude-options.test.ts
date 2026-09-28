import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __testResetCatalog, __testSeedCatalog } from "../config/model-catalog";
import { applyModelSpecificOverrides, EXTRA_BODY_ENV } from "./claude-options";

beforeEach(() => __testResetCatalog());
afterEach(() => __testResetCatalog());

type Out = {
  maxThinkingTokens?: number;
  thinking?: { type: string };
  effort?: string;
  env?: Record<string, string | undefined>;
};

describe("applyModelSpecificOverrides — no requested effort (legacy call shape)", () => {
  test("Opus 4.7 strips maxThinkingTokens and forces adaptive + xhigh", () => {
    const abortController = new AbortController();
    const out = applyModelSpecificOverrides("claude-opus-4-7", {
      model: "claude-opus-4-7",
      cwd: "/tmp",
      maxThinkingTokens: 50000,
      abortController,
    });

    expect(out.model).toBe("claude-opus-4-7");
    expect(out.cwd).toBe("/tmp");
    expect((out as Out).maxThinkingTokens).toBeUndefined();
    expect((out as Out).thinking).toEqual({ type: "adaptive" });
    expect((out as Out).effort).toBe("xhigh");
    // abortController must be preserved through the rewrite
    expect(out.abortController).toBe(abortController);
  });

  test("non-Opus-4.7 model is passthrough (Sonnet 4.5)", () => {
    const abortController = new AbortController();
    const input = {
      model: "claude-sonnet-4-5-20250929",
      cwd: "/tmp",
      maxThinkingTokens: 50000,
      abortController,
    } as const;
    const out = applyModelSpecificOverrides("claude-sonnet-4-5-20250929", { ...input });

    expect(out.model).toBe("claude-sonnet-4-5-20250929");
    expect((out as Out).maxThinkingTokens).toBe(50000);
    expect((out as Out).thinking).toBeUndefined();
    expect((out as Out).effort).toBeUndefined();
  });

  test("non-Opus-4.7 model is passthrough (Haiku 4.5)", () => {
    const abortController = new AbortController();
    const out = applyModelSpecificOverrides("claude-haiku-4-5-20251001", {
      model: "claude-haiku-4-5-20251001",
      cwd: "/tmp",
      maxThinkingTokens: 0,
      abortController,
    });

    expect(out.model).toBe("claude-haiku-4-5-20251001");
    expect((out as Out).maxThinkingTokens).toBe(0);
    expect((out as Out).thinking).toBeUndefined();
    expect((out as Out).effort).toBeUndefined();
  });

  test("Opus 5 strips maxThinkingTokens and forces adaptive + xhigh", () => {
    const out = applyModelSpecificOverrides("claude-opus-5[1m]", {
      model: "claude-opus-5[1m]",
      cwd: "/tmp",
      maxThinkingTokens: 50000,
    });

    expect((out as Out).maxThinkingTokens).toBeUndefined();
    expect((out as Out).thinking).toEqual({ type: "adaptive" });
    expect((out as Out).effort).toBe("xhigh");
  });

  test("non-Claude catalog model drops the thinking budget without setting thinking/effort", () => {
    const abortController = new AbortController();
    for (const model of ["gpt-5.6-sol", "gpt-5.5", "grok-4.5"]) {
      const out = applyModelSpecificOverrides(model, {
        model,
        cwd: "/tmp",
        maxThinkingTokens: 50000,
        abortController,
      });

      expect(out.model).toBe(model);
      expect(out.cwd).toBe("/tmp");
      expect((out as Out).maxThinkingTokens).toBeUndefined();
      expect((out as Out).thinking).toBeUndefined();
      expect((out as Out).effort).toBeUndefined();
      expect(out.abortController).toBe(abortController);
    }
  });
});

describe("applyModelSpecificOverrides — requested effort is resolved per model", () => {
  test("adaptive Claude model: the requested SDK level is sent as `effort`", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      const out = applyModelSpecificOverrides(
        "claude-opus-5[1m]",
        { model: "claude-opus-5[1m]", cwd: "/tmp", maxThinkingTokens: 50000 },
        level
      );
      expect((out as Out).effort).toBe(level);
      expect((out as Out).thinking).toEqual({ type: "adaptive" });
      expect((out as Out).maxThinkingTokens).toBeUndefined();
    }
  });

  test("adaptive Claude model: `ultra` clamps to the strongest SDK level (max) — no extra-body env", () => {
    const out = applyModelSpecificOverrides(
      "claude-fable-5-1[1m]",
      { model: "claude-fable-5-1[1m]", cwd: "/tmp", maxThinkingTokens: 50000 },
      "ultra"
    );
    expect((out as Out).effort).toBe("max");
    expect((out as Out).env).toBeUndefined();
  });

  test("adaptive Claude model with a catalog row: the row's efforts are the menu", () => {
    __testSeedCatalog([
      {
        id: "claude-opus-5-5[1m]",
        efforts: ["low", "medium", "high", "xhigh"],
        group: "claude",
      },
    ]);
    const out = applyModelSpecificOverrides(
      "claude-opus-5-5[1m]",
      { model: "claude-opus-5-5[1m]", cwd: "/tmp" },
      "max"
    );
    expect((out as Out).effort).toBe("xhigh");
  });

  test("Sonnet 4.5 / Haiku 4.5 ignore the requested effort and keep the keyword budget", () => {
    for (const model of ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"]) {
      const out = applyModelSpecificOverrides(
        model,
        { model, cwd: "/tmp", maxThinkingTokens: 10000 },
        "high"
      );
      expect((out as Out).effort).toBeUndefined();
      expect((out as Out).thinking).toBeUndefined();
      expect((out as Out).maxThinkingTokens).toBe(10000);
    }
  });

  test("Sonnet 5 is adaptive: takes effort, drops the budget", () => {
    const out = applyModelSpecificOverrides(
      "claude-sonnet-5",
      { model: "claude-sonnet-5", cwd: "/tmp", maxThinkingTokens: 10000 },
      "medium"
    );
    expect((out as Out).effort).toBe("medium");
    expect((out as Out).thinking).toEqual({ type: "adaptive" });
    expect((out as Out).maxThinkingTokens).toBeUndefined();
  });

  test("non-Claude model without a catalog row: no effort is sent at all", () => {
    const out = applyModelSpecificOverrides(
      "grok-4.7",
      { model: "grok-4.7", cwd: "/tmp", maxThinkingTokens: 50000 },
      "high"
    );
    expect((out as Out).effort).toBeUndefined();
    expect((out as Out).env).toBeUndefined();
  });

  test("non-Claude model with a catalog row: requested level is clamped onto the row", () => {
    __testSeedCatalog([{ id: "grok-4.7", efforts: ["low", "high"], group: "grok" }]);
    const out = applyModelSpecificOverrides(
      "grok-4.7",
      { model: "grok-4.7", cwd: "/tmp", maxThinkingTokens: 50000 },
      "medium"
    );
    // strongest supported ≤ medium is low
    expect((out as Out).effort).toBe("low");
    expect((out as Out).thinking).toBeUndefined();
  });

  test("codex row that lists `ultra`: ultra travels as CLAUDE_CODE_EXTRA_BODY, not as `effort`", () => {
    __testSeedCatalog([
      {
        id: "gpt-6-astra",
        efforts: ["low", "medium", "high", "xhigh", "ultra"],
        group: "codex",
      },
    ]);
    const out = applyModelSpecificOverrides(
      "gpt-6-astra",
      {
        model: "gpt-6-astra",
        cwd: "/tmp",
        maxThinkingTokens: 50000,
        env: { FOO: "bar" },
      },
      "ultra"
    );
    expect((out as Out).effort).toBeUndefined();
    const env = (out as Out).env ?? {};
    // The explicit env is layered on, not replaced.
    expect(env.FOO).toBe("bar");
    expect(JSON.parse(env[EXTRA_BODY_ENV] ?? "null")).toEqual({
      output_config: { effort: "ultra" },
    });
  });

  test("ultra with no explicit env: the extra-body env is layered on a copy of process.env", () => {
    __testSeedCatalog([
      { id: "gpt-6-astra", efforts: ["high", "ultra"], group: "codex" },
    ]);
    process.env.SOMA_TEST_MARKER = "present";
    try {
      const out = applyModelSpecificOverrides(
        "gpt-6-astra",
        { model: "gpt-6-astra", cwd: "/tmp" },
        "ultra"
      );
      const env = (out as Out).env ?? {};
      expect(env.SOMA_TEST_MARKER).toBe("present");
      expect(env[EXTRA_BODY_ENV]).toContain('"ultra"');
    } finally {
      delete process.env.SOMA_TEST_MARKER;
    }
  });

  test("codex row: a plain SDK level goes through `effort` and leaves env alone", () => {
    __testSeedCatalog([
      {
        id: "gpt-6-astra",
        efforts: ["low", "medium", "high", "xhigh", "ultra"],
        group: "codex",
      },
    ]);
    const out = applyModelSpecificOverrides(
      "gpt-6-astra",
      { model: "gpt-6-astra", cwd: "/tmp" },
      "xhigh"
    );
    expect((out as Out).effort).toBe("xhigh");
    expect((out as Out).env).toBeUndefined();
  });
});
