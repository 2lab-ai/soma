/**
 * Group authorization and response rules, tested against production
 * `isAuthorizedForChat` / `shouldRespondInChat` from ./security.
 * Trace: docs/telegram-group-session/trace.md (Scenarios 4 & 6),
 *        docs/group-owner-confirm/trace.md (Scenario 4).
 *
 * This file used to test inline copies of both functions, and the former
 * security.owner.test.ts (merged here) tested a third copy. The group copy had
 * drifted: it let any ALLOWED_USER through in a dynamic group, while
 * production has been owner-only since 95587bc (#3).
 *
 * The production `groupRegistry` singleton persists to the live bot's
 * /tmp/soma-groups.json, so its lookups are routed to a scratch registry here
 * and nothing is ever registered on the singleton itself.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { ALLOWED_GROUPS, ALLOWED_USERS, RESPOND_WITHOUT_MENTION } from "./config";
import { GroupRegistry, groupRegistry } from "./core/group-registry";
import { isAuthorizedForChat, shouldRespondInChat } from "./security";

const TEST_PERSISTENCE_PATH = "/tmp/soma-groups-security-test.json";

const OWNER_ID = 12345;
const OTHER_ALLOWED_USER = 67890;
const STRANGER = 99991;
const STATIC_GROUP = -1005555555555;
const DYNAMIC_GROUP = -1001234567890;
const UNKNOWN_GROUP = -9999999999;

function cleanupTestFile(): void {
  try {
    if (existsSync(TEST_PERSISTENCE_PATH)) unlinkSync(TEST_PERSISTENCE_PATH);
  } catch {
    // ignore
  }
}

let registry: GroupRegistry;
let restoreSpies: Array<() => void> = [];

beforeAll(() => {
  for (const id of [OWNER_ID, OTHER_ALLOWED_USER]) {
    if (!ALLOWED_USERS.includes(id)) ALLOWED_USERS.push(id);
  }
  if (!ALLOWED_GROUPS.includes(STATIC_GROUP)) ALLOWED_GROUPS.push(STATIC_GROUP);
});

afterAll(() => {
  for (const id of [OWNER_ID, OTHER_ALLOWED_USER]) {
    const idx = ALLOWED_USERS.indexOf(id);
    if (idx !== -1) ALLOWED_USERS.splice(idx, 1);
  }
  const gIdx = ALLOWED_GROUPS.indexOf(STATIC_GROUP);
  if (gIdx !== -1) ALLOWED_GROUPS.splice(gIdx, 1);
});

beforeEach(() => {
  cleanupTestFile();
  registry = new GroupRegistry(TEST_PERSISTENCE_PATH);
  const isRegistered = spyOn(groupRegistry, "isRegistered").mockImplementation(
    (chatId: number) => registry.isRegistered(chatId)
  );
  const getOwner = spyOn(groupRegistry, "getOwner").mockImplementation(
    (chatId: number) => registry.getOwner(chatId)
  );
  restoreSpies = [() => isRegistered.mockRestore(), () => getOwner.mockRestore()];
});

afterEach(() => {
  for (const restore of restoreSpies) restore();
  restoreSpies = [];
  cleanupTestFile();
});

// ─── isAuthorizedForChat ─────────────────────────────────────

describe("isAuthorizedForChat — dynamic groups are owner-only", () => {
  test("Trace S4 3a: the owner is authorized in their dynamic group", () => {
    registry.register(DYNAMIC_GROUP, OWNER_ID);
    expect(isAuthorizedForChat(OWNER_ID, DYNAMIC_GROUP, "supergroup")).toBe(true);
    expect(isAuthorizedForChat(OWNER_ID, DYNAMIC_GROUP, "group")).toBe(true);
  });

  test("Trace S4 5: another ALLOWED_USER is rejected in a dynamic group", () => {
    registry.register(DYNAMIC_GROUP, OWNER_ID);
    expect(isAuthorizedForChat(OTHER_ALLOWED_USER, DYNAMIC_GROUP, "supergroup")).toBe(
      false
    );
  });

  test("Trace S4: a user outside ALLOWED_USERS is rejected in a dynamic group", () => {
    registry.register(DYNAMIC_GROUP, OWNER_ID);
    expect(isAuthorizedForChat(STRANGER, DYNAMIC_GROUP, "supergroup")).toBe(false);
  });

  // Replaces the drifted "allows dynamically registered group with allowed
  // user" case, which registered the group without an owner and expected an
  // ALLOWED_USER to pass. That was the pre-#3 rule. In production an entry
  // without an owner (ownerId 0) authorizes nobody.
  test("a dynamic entry without an owner authorizes no one", () => {
    registry.register(DYNAMIC_GROUP);
    expect(isAuthorizedForChat(OWNER_ID, DYNAMIC_GROUP, "supergroup")).toBe(false);
    expect(isAuthorizedForChat(OTHER_ALLOWED_USER, DYNAMIC_GROUP, "supergroup")).toBe(
      false
    );
  });

  test("Trace S4: an unregistered group (neither static nor dynamic) rejects everyone", () => {
    expect(isAuthorizedForChat(OWNER_ID, UNKNOWN_GROUP, "supergroup")).toBe(false);
  });

  test("a channel is rejected even when registered", () => {
    registry.register(-100, OWNER_ID);
    expect(isAuthorizedForChat(OWNER_ID, -100, "channel")).toBe(false);
  });

  test("handles undefined userId/chatId/chatType", () => {
    registry.register(DYNAMIC_GROUP, OWNER_ID);
    expect(isAuthorizedForChat(undefined, DYNAMIC_GROUP, "group")).toBe(false);
    expect(isAuthorizedForChat(OWNER_ID, undefined, "group")).toBe(false);
    expect(isAuthorizedForChat(OWNER_ID, DYNAMIC_GROUP, undefined)).toBe(false);
  });
});

describe("isAuthorizedForChat — static groups and private chats", () => {
  test("Trace S6: a static group allows every ALLOWED_USER without registration", () => {
    expect(isAuthorizedForChat(OWNER_ID, STATIC_GROUP, "supergroup")).toBe(true);
    expect(isAuthorizedForChat(OTHER_ALLOWED_USER, STATIC_GROUP, "supergroup")).toBe(
      true
    );
  });

  test("Trace S6: the static rule wins over a stale dynamic entry for the same chat", () => {
    registry.register(STATIC_GROUP, OWNER_ID);
    expect(isAuthorizedForChat(OTHER_ALLOWED_USER, STATIC_GROUP, "supergroup")).toBe(
      true
    );
  });

  test("Trace S6: dynamic and static groups coexist", () => {
    registry.register(-1001111111111, OWNER_ID);
    expect(isAuthorizedForChat(OWNER_ID, -1001111111111, "supergroup")).toBe(true);
    expect(isAuthorizedForChat(OWNER_ID, STATIC_GROUP, "supergroup")).toBe(true);
  });

  test("a private chat allows any ALLOWED_USER", () => {
    expect(isAuthorizedForChat(OWNER_ID, OWNER_ID, "private")).toBe(true);
    expect(isAuthorizedForChat(OTHER_ALLOWED_USER, OTHER_ALLOWED_USER, "private")).toBe(
      true
    );
    expect(isAuthorizedForChat(STRANGER, STRANGER, "private")).toBe(false);
  });
});

// ─── shouldRespondInChat ─────────────────────────────────────
// Without a mention or a reply, a non-dynamic group falls back to
// RESPOND_WITHOUT_MENTION (false unless set in .env).

describe("shouldRespondInChat", () => {
  test("Trace S4: a registered dynamic group responds without a mention (DM-like)", () => {
    registry.register(DYNAMIC_GROUP, OWNER_ID);
    expect(
      shouldRespondInChat(DYNAMIC_GROUP, "supergroup", "hello world", "testbot", false)
    ).toBe(true);
  });

  test("Trace S4: an unregistered group responds to a mention", () => {
    expect(
      shouldRespondInChat(
        UNKNOWN_GROUP,
        "supergroup",
        "hello @testbot world",
        "testbot",
        false
      )
    ).toBe(true);
  });

  test("Trace S4: an unregistered group responds to a reply to the bot", () => {
    expect(
      shouldRespondInChat(UNKNOWN_GROUP, "supergroup", "hello", "testbot", true)
    ).toBe(true);
  });

  test("Trace S4: an unregistered group without a mention follows RESPOND_WITHOUT_MENTION", () => {
    expect(
      shouldRespondInChat(UNKNOWN_GROUP, "supergroup", "hello world", "testbot", false)
    ).toBe(RESPOND_WITHOUT_MENTION);
  });

  test("Trace S6: a static group without a mention keeps the legacy rule", () => {
    expect(
      shouldRespondInChat(STATIC_GROUP, "supergroup", "hello", "testbot", false)
    ).toBe(RESPOND_WITHOUT_MENTION);
    expect(
      shouldRespondInChat(STATIC_GROUP, "supergroup", "hi @testbot", "testbot", false)
    ).toBe(true);
  });

  test("Trace S6: a static group with a stale dynamic entry still uses the legacy rule", () => {
    registry.register(STATIC_GROUP, OWNER_ID);
    expect(
      shouldRespondInChat(STATIC_GROUP, "supergroup", "hello", "testbot", false)
    ).toBe(RESPOND_WITHOUT_MENTION);
  });

  test("a private chat always responds", () => {
    expect(shouldRespondInChat(OWNER_ID, "private", "hello", "testbot", false)).toBe(
      true
    );
  });

  test("a channel never responds, even when registered", () => {
    registry.register(-100, OWNER_ID);
    expect(
      shouldRespondInChat(-100, "channel", "hello @testbot", "testbot", false)
    ).toBe(false);
  });
});
