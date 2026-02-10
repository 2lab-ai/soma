import { rateLimiter } from "../../security";

export type TelegramRateLimitFn = (
  userId: number
) => [allowed: boolean, retryAfter?: number];

export interface TelegramRateLimitPolicyInput {
  userId: number;
}

export interface TelegramRateLimitPolicyResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface TelegramRateLimitPolicy {
  evaluate(input: TelegramRateLimitPolicyInput): TelegramRateLimitPolicyResult;
}

export function createTelegramRateLimitPolicy(
  checkRateLimit: TelegramRateLimitFn = rateLimiter.check.bind(rateLimiter)
): TelegramRateLimitPolicy {
  return {
    evaluate(input) {
      const [allowed, retryAfterSeconds] = checkRateLimit(input.userId);
      return { allowed, retryAfterSeconds };
    },
  };
}
