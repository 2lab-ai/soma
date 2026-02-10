import { describe, expect, test } from "bun:test";
import { NormalizedProviderError, normalizeProviderError } from "./error-normalizer";

describe("normalizeProviderError", () => {
  test("classifies rate-limit errors as retryable", () => {
    const error = normalizeProviderError(
      "anthropic",
      new Error("429 rate limit exceeded")
    );
    expect(error.providerId).toBe("anthropic");
    expect(error.code).toBe("RATE_LIMIT");
    expect(error.retryable).toBe(true);
  });

  test("classifies auth errors as non-retryable", () => {
    const error = normalizeProviderError("codex", new Error("403 unauthorized"));
    expect(error.code).toBe("AUTH");
    expect(error.retryable).toBe(false);
  });

  test("classifies network errors as retryable", () => {
    const error = normalizeProviderError(
      "anthropic",
      new Error("fetch failed: ETIMEDOUT")
    );
    expect(error.code).toBe("NETWORK");
    expect(error.retryable).toBe(true);
  });

  test("preserves already-normalized errors", () => {
    const normalized = new NormalizedProviderError(
      "codex",
      "INVALID_REQUEST",
      "disabled",
      false
    );
    const reused = normalizeProviderError("codex", normalized);
    expect(reused).toBe(normalized);
  });
});
