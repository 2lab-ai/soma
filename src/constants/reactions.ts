/**
 * Telegram reaction emoji constants for message state indication.
 *
 * IMPORTANT: Telegram only supports a limited set of emojis for reactions.
 * See: https://core.telegram.org/api/reactions
 *
 * Unified State Machine (single emoji per message, each transition replaces previous):
 * - Normal:    READ(👀) → PROCESSING(🔥) → COMPLETE(👍)
 * - Steering:  READ(👀) → BUFFERED(👌)   → DELIVERED(🙏) → COMPLETE(👍)
 * - Interrupt:              → INTERRUPTED(👎)
 * - Error:                  → ERROR_MODEL(💩) or ERROR_SOMA(😱)
 */

export const Reactions = {
  // User message states
  READ: "👀", // soma received the message
  PROCESSING: "🔥", // model is processing (streaming response)
  COMPLETE: "👍", // successfully processed

  // Steering states
  STEERING_BUFFERED: "👌", // buffered, waiting to deliver to model (acknowledged)
  STEERING_DELIVERED: "🙏", // delivered to model (via hook or query)

  // Error states
  INTERRUPTED: "👎", // interrupted by user (!)
  ERROR_SOMA: "😱", // soma/bot exception
  ERROR_MODEL: "💩", // model/Claude exception
  CANCELLED: "😢", // cancelled from queue (buffer overflow)
} as const;

export type ReactionType = keyof typeof Reactions;
export type ReactionEmoji = (typeof Reactions)[ReactionType];
