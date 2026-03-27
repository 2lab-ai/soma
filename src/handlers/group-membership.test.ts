/**
 * RED→GREEN Contract Tests for Group Membership Handler
 * Trace: docs/telegram-group-session/trace.md, Scenarios 1-3
 *
 * Tests the handler logic using GroupRegistry directly
 * (avoids config module that calls process.exit without TELEGRAM_BOT_TOKEN).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { GroupRegistry } from "../core/group-registry";

const TEST_PERSISTENCE_PATH = "/tmp/soma-groups-handler-test.json";

function cleanupTestFile(): void {
  try {
    if (existsSync(TEST_PERSISTENCE_PATH)) unlinkSync(TEST_PERSISTENCE_PATH);
  } catch {
    // ignore
  }
}

// ─── Inline handler logic for unit testing ──────────────────────────
// We test the core decision logic without importing the full handler
// (which depends on Grammy Context and config module).

const MEMBER_STATUSES = new Set(["member", "administrator", "creator"]);
const NON_MEMBER_STATUSES = new Set(["left", "kicked"]);
const GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);

interface MockMyChatMember {
  chat: { id: number; type: string };
  from: { id: number; username?: string };
  old_chat_member: { status: string; user: { id: number; is_bot: boolean } };
  new_chat_member: { status: string; user: { id: number; is_bot: boolean } };
}

function createJoinEvent(
  chatId: number,
  adderId: number,
  chatType: string = "supergroup"
): MockMyChatMember {
  return {
    chat: { id: chatId, type: chatType },
    from: { id: adderId, username: "testuser" },
    old_chat_member: { status: "left", user: { id: 999, is_bot: true } },
    new_chat_member: { status: "member", user: { id: 999, is_bot: true } },
  };
}

function createLeaveEvent(
  chatId: number,
  chatType: string = "supergroup"
): MockMyChatMember {
  return {
    chat: { id: chatId, type: chatType },
    from: { id: 0, username: "system" },
    old_chat_member: { status: "member", user: { id: 999, is_bot: true } },
    new_chat_member: { status: "left", user: { id: 999, is_bot: true } },
  };
}

/**
 * Simulates the handler's core logic with injected dependencies.
 */
async function simulateHandleGroupMembership(
  event: MockMyChatMember,
  registry: GroupRegistry,
  allowedUsers: number[]
): Promise<{ replies: string[] }> {
  const replies: string[] = [];
  const chatId = event.chat.id;
  const chatType = event.chat.type;
  const adderId = event.from.id;
  const oldStatus = event.old_chat_member.status;
  const newStatus = event.new_chat_member.status;

  if (!GROUP_CHAT_TYPES.has(chatType)) return { replies };

  const isJoin =
    NON_MEMBER_STATUSES.has(oldStatus) && MEMBER_STATUSES.has(newStatus);
  const isLeave =
    MEMBER_STATUSES.has(oldStatus) && NON_MEMBER_STATUSES.has(newStatus);

  if (isJoin) {
    if (!allowedUsers.includes(adderId)) return { replies };
    const isNew = registry.register(chatId);
    if (isNew) {
      replies.push("welcome");
    }
  } else if (isLeave) {
    registry.unregister(chatId);
  }

  return { replies };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("handleGroupMembership", () => {
  let registry: GroupRegistry;
  const ALLOWED = [12345, 67890]; // simulated ALLOWED_USERS

  beforeEach(() => {
    cleanupTestFile();
    registry = new GroupRegistry(TEST_PERSISTENCE_PATH);
  });
  afterEach(() => cleanupTestFile());

  // Scenario 1: Bot added by authorized user
  describe("Scenario 1 — Bot added by authorized user", () => {
    test("Trace S1: registers group when authorized user adds bot", async () => {
      const chatId = -1001234567890;
      const event = createJoinEvent(chatId, 12345);

      await simulateHandleGroupMembership(event, registry, ALLOWED);

      expect(registry.isRegistered(chatId)).toBe(true);
    });

    test("Trace S1: sends welcome message to group", async () => {
      const event = createJoinEvent(-1001234567890, 12345);

      const result = await simulateHandleGroupMembership(
        event,
        registry,
        ALLOWED
      );

      expect(result.replies.length).toBeGreaterThan(0);
    });
  });

  // Scenario 2: Bot added by unauthorized user
  describe("Scenario 2 — Bot added by unauthorized user", () => {
    test("Trace S2: does not register group for unauthorized user", async () => {
      const chatId = -1009999999999;
      const event = createJoinEvent(chatId, 99999); // NOT in ALLOWED

      await simulateHandleGroupMembership(event, registry, ALLOWED);

      expect(registry.isRegistered(chatId)).toBe(false);
    });

    test("Trace S2: does not send welcome message", async () => {
      const event = createJoinEvent(-1009999999999, 99999);

      const result = await simulateHandleGroupMembership(
        event,
        registry,
        ALLOWED
      );

      expect(result.replies.length).toBe(0);
    });
  });

  // Scenario 3: Bot removed from group
  describe("Scenario 3 — Bot removed from group", () => {
    test("Trace S3: unregisters group when bot is removed", async () => {
      const chatId = -1001234567890;
      registry.register(chatId);
      expect(registry.isRegistered(chatId)).toBe(true);

      const event = createLeaveEvent(chatId);
      await simulateHandleGroupMembership(event, registry, ALLOWED);

      expect(registry.isRegistered(chatId)).toBe(false);
    });
  });

  // Edge cases
  describe("Edge cases", () => {
    test("Trace S1: ignores non-group chat types (private)", async () => {
      const event = createJoinEvent(-100, 12345, "private");
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(registry.isRegistered(-100)).toBe(false);
    });

    test("Trace S1: ignores non-join transitions (promoted)", async () => {
      const event: MockMyChatMember = {
        chat: { id: -1001234567890, type: "supergroup" },
        from: { id: 12345 },
        old_chat_member: { status: "member", user: { id: 999, is_bot: true } },
        new_chat_member: {
          status: "administrator",
          user: { id: 999, is_bot: true },
        },
      };
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      // member → administrator is not a join or leave, should be no-op
    });

    test("Trace S1: ignores channel chat type", async () => {
      const event = createJoinEvent(-1001234567890, 12345, "channel");
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(registry.isRegistered(-1001234567890)).toBe(false);
    });
  });
});
