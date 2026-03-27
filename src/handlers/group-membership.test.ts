/**
 * Contract Tests for Group Membership Handler
 * Trace: docs/telegram-group-session/trace.md, Scenarios 1-3
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

// ─── isMemberStatus logic (mirrors production code) ──────────────
function isMemberStatus(member: { status: string; is_member?: boolean }): boolean {
  const { status } = member;
  if (status === "member" || status === "administrator" || status === "creator") return true;
  if (status === "restricted") return member.is_member === true;
  return false;
}

const GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);

interface MockMyChatMember {
  chat: { id: number; type: string };
  from: { id: number; username?: string };
  old_chat_member: { status: string; is_member?: boolean; user: { id: number; is_bot: boolean } };
  new_chat_member: { status: string; is_member?: boolean; user: { id: number; is_bot: boolean } };
}

function createJoinEvent(chatId: number, adderId: number, chatType = "supergroup"): MockMyChatMember {
  return {
    chat: { id: chatId, type: chatType },
    from: { id: adderId, username: "testuser" },
    old_chat_member: { status: "left", user: { id: 999, is_bot: true } },
    new_chat_member: { status: "member", user: { id: 999, is_bot: true } },
  };
}

function createLeaveEvent(chatId: number, newStatus = "left", chatType = "supergroup"): MockMyChatMember {
  return {
    chat: { id: chatId, type: chatType },
    from: { id: 0, username: "system" },
    old_chat_member: { status: "member", user: { id: 999, is_bot: true } },
    new_chat_member: { status: newStatus, user: { id: 999, is_bot: true } },
  };
}

function createRestrictedEvent(chatId: number, adderId: number, isMember: boolean): MockMyChatMember {
  return {
    chat: { id: chatId, type: "supergroup" },
    from: { id: adderId, username: "testuser" },
    old_chat_member: { status: "left", user: { id: 999, is_bot: true } },
    new_chat_member: { status: "restricted", is_member: isMember, user: { id: 999, is_bot: true } },
  };
}

/**
 * Simulates handler logic with injected dependencies.
 */
async function simulateHandleGroupMembership(
  event: MockMyChatMember,
  registry: GroupRegistry,
  allowedUsers: number[],
  staticGroups: number[] = []
): Promise<{ replies: string[] }> {
  const replies: string[] = [];
  const chatId = event.chat.id;
  const chatType = event.chat.type;
  const adderId = event.from.id;

  if (!GROUP_CHAT_TYPES.has(chatType)) return { replies };

  const wasMember = isMemberStatus(event.old_chat_member);
  const nowMember = isMemberStatus(event.new_chat_member);

  if (!wasMember && nowMember) {
    if (!allowedUsers.includes(adderId)) return { replies };
    if (staticGroups.includes(chatId)) return { replies }; // skip static groups
    const isNew = registry.register(chatId);
    if (isNew) replies.push("welcome");
  } else if (wasMember && !nowMember) {
    registry.unregister(chatId);
  }

  return { replies };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("handleGroupMembership", () => {
  let registry: GroupRegistry;
  const ALLOWED = [12345, 67890];

  beforeEach(() => {
    cleanupTestFile();
    registry = new GroupRegistry(TEST_PERSISTENCE_PATH);
  });
  afterEach(() => cleanupTestFile());

  describe("Scenario 1 — Bot added by authorized user", () => {
    test("Trace S1: registers group when authorized user adds bot", async () => {
      const event = createJoinEvent(-1001234567890, 12345);
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(registry.isRegistered(-1001234567890)).toBe(true);
    });

    test("Trace S1: sends welcome message", async () => {
      const event = createJoinEvent(-1001234567890, 12345);
      const result = await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(result.replies.length).toBeGreaterThan(0);
    });

    test("Trace S1: works with 'group' chat type (not just supergroup)", async () => {
      const event = createJoinEvent(-1001234567890, 12345, "group");
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(registry.isRegistered(-1001234567890)).toBe(true);
    });
  });

  describe("Scenario 2 — Bot added by unauthorized user", () => {
    test("Trace S2: does not register group", async () => {
      const event = createJoinEvent(-1009999999999, 99999);
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(registry.isRegistered(-1009999999999)).toBe(false);
    });

    test("Trace S2: does not send welcome message", async () => {
      const event = createJoinEvent(-1009999999999, 99999);
      const result = await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(result.replies.length).toBe(0);
    });
  });

  describe("Scenario 3 — Bot removed from group", () => {
    test("Trace S3: unregisters group when bot is removed (left)", async () => {
      registry.register(-1001234567890);
      const event = createLeaveEvent(-1001234567890, "left");
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(registry.isRegistered(-1001234567890)).toBe(false);
    });

    test("Trace S3: unregisters group when bot is kicked", async () => {
      registry.register(-1001234567890);
      const event = createLeaveEvent(-1001234567890, "kicked");
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(registry.isRegistered(-1001234567890)).toBe(false);
    });
  });

  describe("restricted status handling", () => {
    test("restricted with is_member=true registers group", async () => {
      const event = createRestrictedEvent(-1001234567890, 12345, true);
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(registry.isRegistered(-1001234567890)).toBe(true);
    });

    test("restricted with is_member=false does NOT register group", async () => {
      const event = createRestrictedEvent(-1001234567890, 12345, false);
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(registry.isRegistered(-1001234567890)).toBe(false);
    });
  });

  describe("backward compatibility", () => {
    test("skips registration for groups in static ALLOWED_GROUPS", async () => {
      const STATIC = [-1005555555555];
      const event = createJoinEvent(-1005555555555, 12345);
      const result = await simulateHandleGroupMembership(event, registry, ALLOWED, STATIC);
      expect(registry.isRegistered(-1005555555555)).toBe(false);
      expect(result.replies.length).toBe(0);
    });
  });

  describe("Edge cases", () => {
    test("ignores private chat type", async () => {
      const event = createJoinEvent(-100, 12345, "private");
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(registry.isRegistered(-100)).toBe(false);
    });

    test("ignores channel chat type", async () => {
      const event = createJoinEvent(-100, 12345, "channel");
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      expect(registry.isRegistered(-100)).toBe(false);
    });

    test("ignores promotion (member → administrator) — no double register", async () => {
      const event: MockMyChatMember = {
        chat: { id: -1001234567890, type: "supergroup" },
        from: { id: 12345 },
        old_chat_member: { status: "member", user: { id: 999, is_bot: true } },
        new_chat_member: { status: "administrator", user: { id: 999, is_bot: true } },
      };
      await simulateHandleGroupMembership(event, registry, ALLOWED);
      // Both old and new are member statuses → neither join nor leave
      expect(registry.isRegistered(-1001234567890)).toBe(false);
    });
  });
});
