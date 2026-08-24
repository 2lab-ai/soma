/**
 * Tests: forum-topic resolution for outbound bot-initiated messages
 * (permission prompts, issue #79).
 *
 * The session key's threadId is NOT always a Telegram topic id: cron sessions
 * put the job NAME there ("cron:scheduler:0600"). Parsing that as a number and
 * attaching `message_thread_id: 600` to the owner's PRIVATE chat makes
 * Telegram reject the send, so an approval prompt would never arrive.
 */
import { describe, expect, test } from "bun:test";
import { resolveTelegramTopicId } from "./session-key";

describe("resolveTelegramTopicId", () => {
  test("returns the topic id for a supergroup session posting to its own chat", () => {
    expect(resolveTelegramTopicId("default:-1001234567890:42", -1001234567890)).toBe(
      42
    );
  });

  test("returns undefined for the main thread of a supergroup", () => {
    expect(
      resolveTelegramTopicId("default:-1001234567890:main", -1001234567890)
    ).toBeUndefined();
  });

  test("returns undefined for a private chat (topics cannot exist there)", () => {
    expect(resolveTelegramTopicId("default:12345:main", 12345)).toBeUndefined();
  });

  test("never treats a numeric cron job name as a topic id", () => {
    // `cron:scheduler:0600` = job "0600"; the scheduler delivers to the owner's
    // private chat (ALLOWED_USERS[0]).
    expect(resolveTelegramTopicId("cron:scheduler:0600", 987654)).toBeUndefined();
    expect(resolveTelegramTopicId("cron:scheduler:1200", 987654)).toBeUndefined();
  });

  test("never leaks a topic id into a chat the session is not bound to", () => {
    expect(
      resolveTelegramTopicId("default:-1001234567890:42", -1009999999999)
    ).toBeUndefined();
    expect(resolveTelegramTopicId("default:-1001234567890:42", 12345)).toBeUndefined();
  });

  test("rejects non-canonical and out-of-range thread ids", () => {
    expect(
      resolveTelegramTopicId("default:-1001234567890:0600", -1001234567890)
    ).toBeUndefined();
    expect(
      resolveTelegramTopicId("default:-1001234567890:0", -1001234567890)
    ).toBeUndefined();
    expect(
      resolveTelegramTopicId("default:-1001234567890:12.5", -1001234567890)
    ).toBeUndefined();
  });

  test("returns undefined without a query chat id or for an unparsable key", () => {
    expect(
      resolveTelegramTopicId("default:-1001234567890:42", undefined)
    ).toBeUndefined();
    expect(
      resolveTelegramTopicId("legacy-session-key", -1001234567890)
    ).toBeUndefined();
  });
});
