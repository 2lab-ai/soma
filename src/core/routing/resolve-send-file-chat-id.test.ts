import { describe, expect, test } from "bun:test";
import { buildSchedulerRoute } from "../../scheduler/route";
import { resolveSendFileChatId } from "./session-key";

describe("resolveSendFileChatId", () => {
  test("prefers the numeric query chatId (user session)", () => {
    expect(resolveSendFileChatId("default:12345:main", 12345)).toBe("12345");
  });

  test("prefers the query chatId even when it differs from channelId", () => {
    // The scheduler passes the owner id as the query chatId; it wins.
    expect(resolveSendFileChatId("cron:scheduler:daily-es-send", 58705735)).toBe(
      "58705735"
    );
  });

  test("falls back to channelId for a user session without a query chatId", () => {
    expect(resolveSendFileChatId("default:98765:main", undefined)).toBe("98765");
    expect(resolveSendFileChatId("default:98765:main", null)).toBe("98765");
  });

  test("returns null for a scheduler session with no query chatId (never injects 'scheduler')", () => {
    const { sessionKey } = buildSchedulerRoute("daily-es-send");
    expect(resolveSendFileChatId(sessionKey, undefined)).toBeNull();
    expect(resolveSendFileChatId(sessionKey, undefined)).not.toBe("scheduler");
  });

  test("real scheduler route never yields the literal 'scheduler' as a chat id", () => {
    const { sessionKey } = buildSchedulerRoute("shopping-list-check");
    // With the owner id supplied (production path) we get the owner chat.
    expect(resolveSendFileChatId(sessionKey, 58705735)).toBe("58705735");
  });

  test("returns null when the session key cannot be parsed", () => {
    expect(resolveSendFileChatId("not-a-valid-key", undefined)).toBeNull();
  });

  test("ignores an empty-string query chatId and falls back", () => {
    expect(resolveSendFileChatId("default:55555:main", "")).toBe("55555");
  });
});
