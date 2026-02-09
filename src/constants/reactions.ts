/**
 * Telegram reaction emoji constants for message state indication.
 *
 * IMPORTANT: Telegram only supports a limited set of emojis for reactions.
 * See: https://core.telegram.org/api/reactions
 *
 * State transitions:
 * - User message: READ → PROCESSING → COMPLETE (or error state)
 * - Steering: READ → STEERING_BUFFERED → STEERING_DELIVERED → COMPLETE
 */

export const Reactions = {
  // User message states
  READ: "👀",           // soma received the message
  PROCESSING: "🤔",     // model is processing (thinking)
  COMPLETE: "👍",       // successfully processed

  // Steering states
  STEERING_BUFFERED: "👌",   // buffered, waiting to deliver to model (acknowledged)
  STEERING_DELIVERED: "🙏",  // delivered to model (via hook or query)

  // Error states
  INTERRUPTED: "👎",    // interrupted by user (!)
  ERROR_SOMA: "😱",     // soma/bot exception
  ERROR_MODEL: "💩",    // model/Claude exception
  CANCELLED: "😢",      // cancelled from queue (buffer overflow)

  // Legacy (to be removed)
  EVICTED: "🤔",        // steering buffer overflow (deprecated → use CANCELLED)
  FAIL: "👎",           // generic failure (deprecated → use specific errors)
} as const;

export type ReactionType = keyof typeof Reactions;
export type ReactionEmoji = (typeof Reactions)[ReactionType];
