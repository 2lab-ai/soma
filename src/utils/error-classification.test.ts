import { describe, test, expect } from "bun:test";
import {
  isRateLimitError,
  isSonnetAvailable,
  isAbortError,
  extractErrorDetails,
  formatErrorForUser,
  formatErrorForLog,
} from "./error-classification";
import type { ClaudeUsage } from "../types";

describe("isRateLimitError", () => {
  test("detects 429 error", () => {
    const result = isRateLimitError(new Error("HTTP 429 Too Many Requests"));
    expect(result.isRateLimit).toBe(true);
  });

  test("detects rate_limit pattern", () => {
    const result = isRateLimitError(new Error("rate_limit_exceeded"));
    expect(result.isRateLimit).toBe(true);
  });

  test("detects 'rate limit' with space", () => {
    const result = isRateLimitError(new Error("You've hit a rate limit"));
    expect(result.isRateLimit).toBe(true);
  });

  test("detects overloaded", () => {
    const result = isRateLimitError(new Error("API is overloaded"));
    expect(result.isRateLimit).toBe(true);
  });

  test("detects quota exceeded", () => {
    const result = isRateLimitError(new Error("quota exceeded for model"));
    expect(result.isRateLimit).toBe(true);
  });

  test("detects usage limit", () => {
    const result = isRateLimitError(new Error("usage limit reached"));
    expect(result.isRateLimit).toBe(true);
  });

  test("identifies opus bucket", () => {
    const result = isRateLimitError(new Error("429: opus rate limit exceeded"));
    expect(result.isRateLimit).toBe(true);
    expect(result.bucket).toBe("opus");
  });

  test("identifies sonnet bucket", () => {
    const result = isRateLimitError(new Error("sonnet quota exceeded"));
    expect(result.isRateLimit).toBe(true);
    expect(result.bucket).toBe("sonnet");
  });

  test("unknown bucket when no model specified", () => {
    const result = isRateLimitError(new Error("rate limit exceeded"));
    expect(result.isRateLimit).toBe(true);
    expect(result.bucket).toBe("unknown");
  });

  test("returns false for non-rate-limit errors", () => {
    const result = isRateLimitError(new Error("Connection refused"));
    expect(result.isRateLimit).toBe(false);
    expect(result.bucket).toBeNull();
  });

  test("handles non-Error inputs", () => {
    const result = isRateLimitError("429 error string");
    expect(result.isRateLimit).toBe(true);
  });

  test("handles null/undefined", () => {
    const result = isRateLimitError(null);
    expect(result.isRateLimit).toBe(false);
  });

  test("checks error name for rate limit keywords", () => {
    const err = new Error("some error");
    err.name = "TooManyRequests429";
    const result = isRateLimitError(err);
    expect(result.isRateLimit).toBe(true);
  });
});

describe("isSonnetAvailable", () => {
  test("returns true when sonnet utilization < 80%", () => {
    const usage = {
      seven_day_sonnet: { utilization: 0.5, resets_at: null },
    } as ClaudeUsage;
    expect(isSonnetAvailable(usage)).toBe(true);
  });

  test("returns false when sonnet utilization >= 80%", () => {
    const usage = {
      seven_day_sonnet: { utilization: 0.85, resets_at: null },
    } as ClaudeUsage;
    expect(isSonnetAvailable(usage)).toBe(false);
  });

  test("returns false when exactly 80%", () => {
    const usage = {
      seven_day_sonnet: { utilization: 0.80, resets_at: null },
    } as ClaudeUsage;
    expect(isSonnetAvailable(usage)).toBe(false);
  });

  test("returns false when no sonnet data", () => {
    expect(isSonnetAvailable(null)).toBe(false);
    expect(isSonnetAvailable({} as ClaudeUsage)).toBe(false);
  });
});

describe("isAbortError", () => {
  test("detects AbortError by name", () => {
    const err = new Error("operation failed");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });

  test("detects 'aborted' message", () => {
    expect(isAbortError(new Error("aborted"))).toBe(true);
  });

  test("detects 'cancelled' message", () => {
    expect(isAbortError(new Error("cancelled"))).toBe(true);
  });

  test("detects 'the operation was aborted'", () => {
    expect(isAbortError(new Error("The operation was aborted"))).toBe(true);
  });

  test("returns false for non-abort errors", () => {
    expect(isAbortError(new Error("timeout"))).toBe(false);
  });

  test("returns false for non-Error", () => {
    expect(isAbortError("aborted")).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });

  test("does not match partial abort messages", () => {
    expect(isAbortError(new Error("request was aborted by client"))).toBe(false);
  });
});

describe("extractErrorDetails", () => {
  test("extracts basic error info", () => {
    const err = new Error("test message");
    const details = extractErrorDetails(err);
    expect(details.message).toBe("test message");
    expect(details.name).toBe("Error");
    expect(details.stack).toBeDefined();
  });

  test("extracts exit code from message", () => {
    const details = extractErrorDetails(new Error("Process exited with code 1"));
    expect(details.exitCode).toBe(1);
  });

  test("adds session hint for exit code 1 + session keyword", () => {
    const details = extractErrorDetails(new Error("session exited with code 1"));
    expect(details.hint).toContain("Session expired");
  });

  test("adds permission hint", () => {
    const details = extractErrorDetails(new Error("permission denied exited with code 1"));
    expect(details.hint).toContain("Permission denied");
  });

  test("handles non-Error input", () => {
    const details = extractErrorDetails("raw string error");
    expect(details.message).toBe("raw string error");
    expect(details.name).toBe("Unknown");
  });

  test("adds ENOENT hint", () => {
    const details = extractErrorDetails(new Error("ENOENT: no such file"));
    expect(details.hint).toContain("File not found");
  });
});

describe("formatErrorForUser", () => {
  test("formats basic error", () => {
    const msg = formatErrorForUser(new Error("something broke"));
    expect(msg).toContain("❌");
    expect(msg).toContain("something broke");
  });

  test("includes exit code", () => {
    const msg = formatErrorForUser(new Error("exited with code 1"));
    expect(msg).toContain("code 1");
  });

  test("includes hint", () => {
    const msg = formatErrorForUser(new Error("ENOENT: no such file"));
    expect(msg).toContain("💡");
    expect(msg).toContain("File not found");
  });

  test("truncates long messages", () => {
    const longMsg = "x".repeat(300);
    const msg = formatErrorForUser(new Error(longMsg));
    expect(msg.length).toBeLessThan(300);
  });
});

describe("formatErrorForLog", () => {
  test("includes error name and message", () => {
    const log = formatErrorForLog(new Error("test error"));
    expect(log).toContain("[ERROR]");
    expect(log).toContain("Error");
    expect(log).toContain("test error");
  });

  test("includes exit code when present", () => {
    const log = formatErrorForLog(new Error("exited with code 42"));
    expect(log).toContain("Exit code: 42");
  });

  test("includes stack trace", () => {
    const log = formatErrorForLog(new Error("with stack"));
    expect(log).toContain("Stack:");
  });
});
