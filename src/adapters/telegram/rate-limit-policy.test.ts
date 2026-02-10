import { describe, expect, test } from "bun:test";
import { createTelegramRateLimitPolicy } from "./rate-limit-policy";

describe("createTelegramRateLimitPolicy", () => {
  test("maps tuple-based rate limit response to named fields", () => {
    const calls: number[] = [];
    const policy = createTelegramRateLimitPolicy((userId) => {
      calls.push(userId);
      return userId === 1 ? [true] : [false, 1.75];
    });

    expect(policy.evaluate({ userId: 1 })).toEqual({
      allowed: true,
      retryAfterSeconds: undefined,
    });
    expect(policy.evaluate({ userId: 2 })).toEqual({
      allowed: false,
      retryAfterSeconds: 1.75,
    });
    expect(calls).toEqual([1, 2]);
  });
});
