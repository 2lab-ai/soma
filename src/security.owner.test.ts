/**
 * Contract Tests: Owner-Only Authorization in Dynamic Groups
 * Trace: docs/group-owner-confirm/trace.md, Scenario 4
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { GroupRegistry } from "./core/group-registry";

const TEST_PERSISTENCE_PATH = "/tmp/soma-groups-security-owner-test.json";

function cleanupTestFile() {
  try {
    if (existsSync(TEST_PERSISTENCE_PATH)) unlinkSync(TEST_PERSISTENCE_PATH);
  } catch {}
}

/**
 * Inline implementation of isAuthorizedForChat with owner-only check.
 * Matches production logic from Trace S4, Section 3a.
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

  // Private chat: any allowed user
  if (chatType === "private") return allowedUsers.includes(userId);

  // Group/Supergroup
  if (chatType === "group" || chatType === "supergroup") {
    // Static groups: any ALLOWED_USER (backward compat)
    if (staticGroups.includes(chatId)) {
      return allowedUsers.includes(userId);
    }
    // Dynamic groups: owner only
    if (registry.isRegistered(chatId)) {
      const owner = registry.getOwner(chatId);
      return userId === owner;
    }
    return false;
  }

  return false;
}

describe("Security — Owner-Only Authorization (Scenario 4)", () => {
  let registry: GroupRegistry;
  const OWNER_ID = 12345;
  const OTHER_ALLOWED_USER = 67890;
  const ALLOWED = [OWNER_ID, OTHER_ALLOWED_USER];
  const STATIC_GROUPS = [-1005555555555];

  beforeEach(() => {
    cleanupTestFile();
    registry = new GroupRegistry(TEST_PERSISTENCE_PATH);
  });
  afterEach(() => cleanupTestFile());

  // Trace S4, Section 3a: owner message in dynamic group is authorized
  test("owner is authorized in dynamic group", () => {
    registry.register(-1001234567890, OWNER_ID);
    expect(
      isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, OWNER_ID, -1001234567890, "supergroup")
    ).toBe(true);
  });

  // Trace S4, Section 5: non-owner message in dynamic group is rejected
  test("non-owner ALLOWED_USER is rejected in dynamic group", () => {
    registry.register(-1001234567890, OWNER_ID);
    expect(
      isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, OTHER_ALLOWED_USER, -1001234567890, "supergroup")
    ).toBe(false);
  });

  // Trace S4, Section 3a: static group still allows all ALLOWED_USERS
  test("static group allows all ALLOWED_USERS (backward compat)", () => {
    expect(
      isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, OWNER_ID, -1005555555555, "supergroup")
    ).toBe(true);
    expect(
      isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, OTHER_ALLOWED_USER, -1005555555555, "supergroup")
    ).toBe(true);
  });

  // Trace S4, Section 3a: private chat unchanged
  test("private chat allows any ALLOWED_USER", () => {
    expect(
      isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, OWNER_ID, OWNER_ID, "private")
    ).toBe(true);
    expect(
      isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, OTHER_ALLOWED_USER, OTHER_ALLOWED_USER, "private")
    ).toBe(true);
  });

  // Unregistered group rejects everyone
  test("unregistered dynamic group rejects everyone", () => {
    expect(
      isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, OWNER_ID, -9999, "supergroup")
    ).toBe(false);
  });

  // Channel rejects
  test("channel always rejected", () => {
    registry.register(-100, OWNER_ID);
    expect(
      isAuthorizedForChat(registry, STATIC_GROUPS, ALLOWED, OWNER_ID, -100, "channel")
    ).toBe(false);
  });
});
