/**
 * Security module for Claude Telegram Bot.
 *
 * Rate limiting, path validation, command safety.
 */

import { resolve, normalize } from "path";
import { realpathSync } from "fs";
import type { RateLimitBucket } from "./types";
import {
  ALLOWED_GROUPS,
  ALLOWED_PATHS,
  ALLOWED_USERS,
  BLOCKED_PATTERNS,
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_REQUESTS,
  RATE_LIMIT_WINDOW,
  RESPOND_WITHOUT_MENTION,
  TEMP_PATHS,
} from "./config";

// ============== Rate Limiter ==============

class RateLimiter {
  private buckets = new Map<number, RateLimitBucket>();
  private maxTokens: number;
  private refillRate: number; // tokens per second

  constructor() {
    this.maxTokens = RATE_LIMIT_REQUESTS;
    this.refillRate = RATE_LIMIT_REQUESTS / RATE_LIMIT_WINDOW;
  }

  check(userId: number): [allowed: boolean, retryAfter?: number] {
    if (!RATE_LIMIT_ENABLED) {
      return [true];
    }

    const now = Date.now();
    let bucket = this.buckets.get(userId);

    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastUpdate: now };
      this.buckets.set(userId, bucket);
    }

    // Refill tokens based on time elapsed
    const elapsed = (now - bucket.lastUpdate) / 1000;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillRate);
    bucket.lastUpdate = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return [true];
    }

    // Calculate time until next token
    const retryAfter = (1 - bucket.tokens) / this.refillRate;
    return [false, retryAfter];
  }

  getStatus(userId: number): {
    tokens: number;
    max: number;
    refillRate: number;
  } {
    const bucket = this.buckets.get(userId);
    return {
      tokens: bucket?.tokens ?? this.maxTokens,
      max: this.maxTokens,
      refillRate: this.refillRate,
    };
  }
}

export const rateLimiter = new RateLimiter();

// ============== Path Validation ==============

export function isPathAllowed(path: string): boolean {
  try {
    // Expand ~ and resolve to absolute path
    const expanded = path.replace(/^~/, process.env.HOME || "");
    const normalized = normalize(expanded);

    // Try to resolve symlinks (may fail if path doesn't exist yet)
    let resolved: string;
    try {
      resolved = realpathSync(normalized);
    } catch {
      resolved = resolve(normalized);
    }

    // Always allow temp paths (for bot's own files)
    for (const tempPath of TEMP_PATHS) {
      if (resolved.startsWith(tempPath)) {
        return true;
      }
    }

    // Check against allowed paths using proper containment
    for (const allowed of ALLOWED_PATHS) {
      const allowedResolved = resolve(allowed);
      if (resolved === allowedResolved || resolved.startsWith(allowedResolved + "/")) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

// ============== Command Safety ==============

export function checkCommandSafety(command: string): [safe: boolean, reason: string] {
  const lowerCommand = command.toLowerCase();

  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (lowerCommand.includes(pattern.toLowerCase())) {
      return [false, `Blocked pattern: ${pattern}`];
    }
  }

  // Special handling for rm commands - validate paths
  if (lowerCommand.includes("rm ")) {
    try {
      // Simple parsing: extract arguments after rm
      const rmMatch = command.match(/rm\s+(.+)/i);
      if (rmMatch) {
        const args = rmMatch[1]!.split(/\s+/);
        for (const arg of args) {
          // Skip flags
          if (arg.startsWith("-") || arg.length <= 1) continue;

          // Check if path is allowed
          if (!isPathAllowed(arg)) {
            return [false, `rm target outside allowed paths: ${arg}`];
          }
        }
      }
    } catch {
      // If parsing fails, be cautious
      return [false, "Could not parse rm command for safety check"];
    }
  }

  return [true, ""];
}

export type ChatType = "private" | "group" | "supergroup" | "channel";

/**
 * Check if a user is authorized to use the bot in a specific chat.
 *
 * Rules:
 * - Private chat: user must be in ALLOWED_USERS
 * - Group/Supergroup: group must be in ALLOWED_GROUPS AND user must be in ALLOWED_USERS
 * - Channel: not supported
 */
export function isAuthorizedForChat(
  userId: number | undefined,
  chatId: number | undefined,
  chatType: ChatType | undefined
): boolean {
  if (!userId || !chatId || !chatType) return false;

  // Private chat: user must be allowed
  if (chatType === "private") {
    return ALLOWED_USERS.includes(userId);
  }

  // Group/Supergroup: group must be allowed AND user must be allowed
  if (chatType === "group" || chatType === "supergroup") {
    if (!ALLOWED_GROUPS.includes(chatId)) return false;
    return ALLOWED_USERS.includes(userId);
  }

  // Channels not supported
  return false;
}

/**
 * Check if the bot should respond to a message.
 *
 * Rules:
 * - Private chat: always respond (if authorized)
 * - Group/Supergroup: respond if @mentioned OR replying to bot OR RESPOND_WITHOUT_MENTION is true
 *
 * @param chatType - The type of chat
 * @param messageText - The message text (including caption for photos)
 * @param botUsername - The bot's username (without @)
 * @param isReplyToBot - Whether the message is a reply to one of the bot's messages
 */
export function shouldRespond(
  chatType: ChatType | undefined,
  messageText: string | undefined,
  botUsername: string,
  isReplyToBot: boolean
): boolean {
  // Always respond in private chats
  if (chatType === "private") {
    return true;
  }

  // Groups/Supergroups: check mention or reply
  if (chatType === "group" || chatType === "supergroup") {
    // Always respond to @mentions
    if (messageText && messageText.includes(`@${botUsername}`)) {
      return true;
    }

    // Always respond to replies to bot's messages
    if (isReplyToBot) {
      return true;
    }

    // Otherwise, check if RESPOND_WITHOUT_MENTION is enabled
    return RESPOND_WITHOUT_MENTION;
  }

  // Channels: never respond
  return false;
}
