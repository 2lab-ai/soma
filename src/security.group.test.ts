/**
 * Contract Tests for Security — Group Session Integration
 * Trace: docs/telegram-group-session/trace.md, Scenarios 4 & 6
 *
 * Tests shouldRespondInChat and isAuthorizedForChat with dynamic GroupRegistry.
 * Uses env-var-injected config to avoid process.exit() in test env.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { GroupRegistry } from "./core/group-registry";

const TEST_PERSISTENCE_PATH = "/tmp/soma-groups-security-test.json";

function cleanupTestFile(): void {
  try {
    if (existsSync(TEST_PERSISTENCE_PATH)) unlinkSync(TEST_PERSISTENCE_PATH);
  } catch {
    // ignore
  }
}

/**
 * Inline implementation of shouldRespondInChat logic for unit testing.
 * Mirrors src/security.ts:shouldRespondInChat without importing config module.
 */
function shouldRespondInChat(
  registry: GroupRegistry,
  staticGroups: number[],
  chatId: number,
  chatType: string | undefined,
  messageText: string | undefined,
  botUsername: string,
  isReplyToBot: boolean
): boolean {
  if (chatType === "private") return true;
  if (chatType === "group" || chatType === "supergroup") {
    // Static groups always use legacy mention-based behavior
    if (staticGroups.includes(chatId)) {
      if (messageText && messageText.includes(`@${botUsername}`)) return true;
      if (isReplyToBot) return true;
      return false;
    }
    if (registry.isRegistered(chatId)) return true;
    // Fall back to legacy: mention or reply
    if (messageText && messageText.includes(`@${botUsername}`)) return true;
    if (isReplyToBot) return true;
    return false;
  }
  return false;
}

/**
 * Inline implementation of isAuthorizedForChat with dynamic registry.
 * Mirrors src/security.ts:isAuthorizedForChat logic.
 */
function isAuthorizedForChat(
  registry: GroupRegistry,
  staticGroups: number[],
  allowedUsers: number[],
  userId: number | undefined,
  chatId: number | undefined,
  chatType: string | undefined
): boolean {
  if (!userId || !chatId || !chatType) return false;
  if (chatType === "private") return allowedUsers.includes(userId);
  if (chatType === "group" || chatType === "supergroup") {
    const groupAllowed = staticGroups.includes(chatId) || registry.isRegistered(chatId);
    if (!groupAllowed) return false;
    return allowedUsers.includes(userId);
  }
  return false;
}

describe("Security — Group Registry Integration", () => {
  let registry: GroupRegistry;
  const ALLOWED = [12345, 67890];
  const STATIC_GROUPS = [-1005555555555];

  beforeEach(() => {
    cleanupTestFile();
    registry = new GroupRegistry(TEST_PERSISTENCE_PATH);
  });
  afterEach(() => cleanupTestFile());

  // ─── Scenario 4: isAuthorizedForChat with dynamic registry ──

  describe("isAuthorizedForChat — dynamic groups", () => {
    test("Trace S4: allows dynamically registered group with allowed user", () => {
      registry.register(-1001234567890);

      expect(
        isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, 12345, -1001234567890, "supergroup")
      ).toBe(true);
    });

    test("Trace S4: rejects dynamically registered group with disallowed user", () => {
      registry.register(-1001234567890);

      expect(
        isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, 99999, -1001234567890, "supergroup")
      ).toBe(false);
    });

    test("Trace S4: rejects unregistered group (neither static nor dynamic)", () => {
      expect(
        isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, 12345, -9999999999, "supergroup")
      ).toBe(false);
    });

    test("Trace S6: static group is authorized without dynamic registration", () => {
      expect(
        isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, 12345, -1005555555555, "supergroup")
      ).toBe(true);
    });

    test("Trace S6: dynamic and static groups coexist (OR logic)", () => {
      registry.register(-1001111111111);

      expect(
        isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, 12345, -1001111111111, "supergroup")
      ).toBe(true);
      expect(
        isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, 12345, -1005555555555, "supergroup")
      ).toBe(true);
    });

    test("handles undefined userId/chatId/chatType", () => {
      expect(isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, undefined, -100, "group")).toBe(false);
      expect(isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, 12345, undefined, "group")).toBe(false);
      expect(isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, 12345, -100, undefined)).toBe(false);
    });
  });

  // ─── Scenario 4: shouldRespondInChat with dynamic registry ──

  describe("shouldRespondInChat — dynamic groups", () => {
    test("Trace S4: registered group responds without mention (DM-like)", () => {
      registry.register(-1001234567890);

      expect(
        shouldRespondInChat(registry, STATIC_GROUPS, -1001234567890, "supergroup", "hello world", "testbot", false)
      ).toBe(true);
    });

    test("Trace S4: unregistered group with mention responds (fallback)", () => {
      expect(
        shouldRespondInChat(registry, STATIC_GROUPS, -9999, "supergroup", "hello @testbot world", "testbot", false)
      ).toBe(true);
    });

    test("Trace S4: unregistered group with reply to bot responds (fallback)", () => {
      expect(
        shouldRespondInChat(registry, STATIC_GROUPS, -9999, "supergroup", "hello", "testbot", true)
      ).toBe(true);
    });

    test("Trace S4: unregistered group without mention does NOT respond", () => {
      expect(
        shouldRespondInChat(registry, STATIC_GROUPS, -9999, "supergroup", "hello world", "testbot", false)
      ).toBe(false);
    });

    test("Trace S6: static group without mention does NOT respond (legacy behavior)", () => {
      // Static groups use legacy mention-based logic, even if dynamically registered
      expect(
        shouldRespondInChat(registry, STATIC_GROUPS, -1005555555555, "supergroup", "hello", "testbot", false)
      ).toBe(false);
    });

    test("Trace S6: static group with dynamic entry still uses legacy behavior", () => {
      // Even if a static group has a stale dynamic registry entry, static takes precedence
      registry.register(-1005555555555);
      expect(
        shouldRespondInChat(registry, STATIC_GROUPS, -1005555555555, "supergroup", "hello", "testbot", false)
      ).toBe(false);
    });

    test("private chat always responds", () => {
      expect(
        shouldRespondInChat(registry, STATIC_GROUPS, 12345, "private", "hello", "testbot", false)
      ).toBe(true);
    });

    test("channel never responds", () => {
      registry.register(-100);
      expect(
        shouldRespondInChat(registry, STATIC_GROUPS, -100, "channel", "hello", "testbot", false)
      ).toBe(false);
    });
  });
});
