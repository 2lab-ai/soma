import { describe, expect, test } from "bun:test";
import { applyModelSpecificOverrides } from "./claude-options";

describe("applyModelSpecificOverrides", () => {
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
    expect((out as { maxThinkingTokens?: number }).maxThinkingTokens).toBeUndefined();
    expect((out as { thinking?: { type: string } }).thinking).toEqual({
      type: "adaptive",
    });
    expect((out as { effort?: string }).effort).toBe("xhigh");
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
    expect((out as { maxThinkingTokens?: number }).maxThinkingTokens).toBe(50000);
    expect((out as { thinking?: unknown }).thinking).toBeUndefined();
    expect((out as { effort?: unknown }).effort).toBeUndefined();
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
    expect((out as { maxThinkingTokens?: number }).maxThinkingTokens).toBe(0);
    expect((out as { thinking?: unknown }).thinking).toBeUndefined();
    expect((out as { effort?: unknown }).effort).toBeUndefined();
  });

  test("Opus 5 strips maxThinkingTokens and forces adaptive + xhigh", () => {
    const out = applyModelSpecificOverrides("claude-opus-5[1m]", {
      model: "claude-opus-5[1m]",
      cwd: "/tmp",
      maxThinkingTokens: 50000,
    });

    expect((out as { maxThinkingTokens?: number }).maxThinkingTokens).toBeUndefined();
    expect((out as { thinking?: { type: string } }).thinking).toEqual({
      type: "adaptive",
    });
    expect((out as { effort?: string }).effort).toBe("xhigh");
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
      expect((out as { maxThinkingTokens?: number }).maxThinkingTokens).toBeUndefined();
      expect((out as { thinking?: unknown }).thinking).toBeUndefined();
      expect((out as { effort?: unknown }).effort).toBeUndefined();
      expect(out.abortController).toBe(abortController);
    }
  });
});
