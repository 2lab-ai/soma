/**
 * Session identity, keys, and storage partitions — the generic model is
 * re-exported from the shared `soma-lib` package (domain/session-identity)
 * as of convergence roadmap Step 4b. Every existing import path keeps
 * working; only soma's app-side pieces live here:
 *   - SCHEDULER_TENANT_ID — soma's cron tenant convention
 *   - resolveSendFileChatId — Telegram send-file delivery policy
 */
export type {
  ChannelId,
  SessionIdentity,
  SessionIdentityField,
  SessionIdentityInput,
  SessionIdentityInvariantCode,
  SessionKey,
  SessionKeyContract,
  StoragePartitionKey,
  TenantId,
  ThreadId,
} from "soma-lib";
export {
  SESSION_KEY_FORMAT,
  STORAGE_PARTITION_FORMAT,
  SessionIdentityInvariantError,
  buildSessionKey,
  buildSessionKeyFromInput,
  buildStoragePartitionKey,
  buildStoragePartitionKeyFromInput,
  createSessionIdentity,
  parseSessionKey,
  parseStoragePartitionKey,
  sessionKeyContract,
  toChannelId,
  toTenantId,
  toThreadId,
} from "soma-lib";
import { parseSessionKey } from "soma-lib";

/**
 * Tenant id used for cron/scheduler-originated sessions.
 *
 * Scheduler sessions carry a literal `channelId` ("scheduler") that is not a
 * real chat, so they must be detected explicitly when resolving a delivery
 * target (see {@link resolveSendFileChatId}).
 */
export const SCHEDULER_TENANT_ID = "cron";

/**
 * Resolve the Telegram forum-topic id (`message_thread_id`) for a bot-initiated
 * message in a given chat — e.g. a tool-permission prompt (issue #79).
 *
 * A session key's `threadId` is NOT always a Telegram topic id. Cron sessions
 * store the JOB NAME there (`cron:scheduler:0600`), and the scheduler delivers
 * to the owner's private chat, where topics cannot exist at all. Blindly
 * `Number()`-ing the thread segment attaches `message_thread_id: 600` to a
 * private chat, Telegram rejects the send, and the prompt never arrives.
 *
 * A topic id is therefore derived only when ALL of these hold:
 *   1. there is a target chat id;
 *   2. the chat is a group/supergroup (negative id) — private chats and the
 *      scheduler's owner DM have no topics;
 *   3. the session's `channelId` IS that chat (never cross-chat; "scheduler"
 *      is a label, not a chat, so it can never match);
 *   4. the thread segment is a canonical positive integer ("main" and job
 *      names like "0600" are rejected).
 */
export function resolveTelegramTopicId(
  sessionKey: string,
  queryChatId: number | null | undefined
): number | undefined {
  if (queryChatId === null || queryChatId === undefined || queryChatId >= 0) {
    return undefined;
  }

  let rawThreadId: string;
  try {
    const identity = parseSessionKey(sessionKey);
    if (identity.channelId !== String(queryChatId)) {
      return undefined;
    }
    rawThreadId = String(identity.threadId);
  } catch {
    return undefined;
  }

  const topicId = Number(rawThreadId);
  if (!Number.isSafeInteger(topicId) || topicId <= 0) {
    return undefined;
  }
  // Canonical decimal only: "0600" is a job name, not topic 600.
  if (String(topicId) !== rawThreadId) {
    return undefined;
  }
  return topicId;
}

/**
 * Resolve the Telegram chat id that the `send-file` MCP should target for a
 * given query.
 *
 * The chat id is injected per query into the `send-file` MCP env. There are two
 * kinds of sessions:
 *
 * - **User sessions** — the handler passes the originating chat id as the query
 *   `chatId`, which equals the session's `channelId`. Either source works.
 * - **Cron/scheduler sessions** — the session `channelId` is a literal label
 *   ("scheduler"), NOT a chat. Injecting it makes `send_photo`/`send_document`
 *   fail with Telegram `Bad Request: chat not found`. The scheduler instead
 *   passes the owner's numeric chat id (`ALLOWED_USERS[0]`) as the query
 *   `chatId`.
 *
 * Strategy: always prefer the query `chatId` when present; only fall back to the
 * session `channelId` for non-scheduler sessions. Returns `null` when there is
 * no usable chat id (e.g. a scheduler session with no query chat id), so the
 * caller can skip injection rather than send to an invalid target.
 */
export function resolveSendFileChatId(
  sessionKey: string,
  queryChatId: number | string | null | undefined
): string | null {
  if (
    queryChatId !== null &&
    queryChatId !== undefined &&
    String(queryChatId) !== ""
  ) {
    return String(queryChatId);
  }

  try {
    const identity = parseSessionKey(sessionKey);
    if (identity.tenantId === SCHEDULER_TENANT_ID) {
      // Scheduler channelId ("scheduler") is a label, not a chat — unusable.
      return null;
    }
    return identity.channelId;
  } catch {
    return null;
  }
}
