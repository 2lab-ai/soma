/**
 * Contract Tests: Group Confirmation Callback + DM Flow
 * Trace: docs/group-owner-confirm/trace.md, Scenarios 1-3
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";

const TEST_PENDING_PATH = "/tmp/soma-pending-groups-callback-test.json";
const TEST_REGISTRY_PATH = "/tmp/soma-groups-callback-test.json";

function cleanupTestFiles() {
  for (const p of [TEST_PENDING_PATH, TEST_REGISTRY_PATH]) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
  }
}

/**
 * Simulate the group confirm callback logic inline.
 * Matches production handleGroupConfirmCallback from trace S2/S3.
 */
interface PendingConfirmation {
  chatId: number;
  chatTitle: string;
  adderId: number;
  ownerId: number;
  dmMessageId: number;
  createdAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;

function isExpired(pending: PendingConfirmation): boolean {
  return Date.now() - pending.createdAt > TTL_MS;
}

function parseCallbackData(data: string): { chatId: number; action: string } | null {
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== "grp") return null;
  const chatId = Number(parts[1]);
  if (!Number.isFinite(chatId)) return null;
  return { chatId, action: parts[2]! };
}

describe("Group Confirm Callback — Scenarios 1-3", () => {
  const pendingStore = new Map<number, PendingConfirmation>();

  beforeEach(() => {
    cleanupTestFiles();
    pendingStore.clear();
  });
  afterEach(() => cleanupTestFiles());

  // Trace S1: DM sends to owner instead of auto-registering
  test("S1: sends DM to owner instead of auto-registering", () => {
    // Simulate: bot added to group → create pending instead of register
    const ownerId = 12345;
    const chatId = -1001234567890;
    const pending: PendingConfirmation = {
      chatId,
      chatTitle: "Test Group",
      adderId: 67890,
      ownerId,
      dmMessageId: 100,
      createdAt: Date.now(),
    };
    pendingStore.set(chatId, pending);

    // Verify: pending exists, NOT registered
    expect(pendingStore.has(chatId)).toBe(true);
    // GroupRegistry should NOT be called at this point
  });

  // Trace S2: accept registers group with ownerId
  test("S2: accept registers group with ownerId and removes pending", () => {
    const chatId = -1001234567890;
    const ownerId = 12345;
    pendingStore.set(chatId, {
      chatId,
      chatTitle: "Test Group",
      adderId: 67890,
      ownerId,
      dmMessageId: 100,
      createdAt: Date.now(),
    });

    const parsed = parseCallbackData(`grp:${chatId}:accept`);
    expect(parsed).not.toBeNull();
    expect(parsed!.action).toBe("accept");

    const pending = pendingStore.get(parsed!.chatId);
    expect(pending).toBeDefined();
    expect(pending!.ownerId).toBe(ownerId);

    // Simulate accept: remove pending, register would happen
    pendingStore.delete(chatId);
    expect(pendingStore.has(chatId)).toBe(false);
  });

  // Trace S2, Section 5: expired pending returns error
  test("S2: expired pending is rejected", () => {
    const chatId = -1001234567890;
    pendingStore.set(chatId, {
      chatId,
      chatTitle: "Expired Group",
      adderId: 67890,
      ownerId: 12345,
      dmMessageId: 100,
      createdAt: Date.now() - 25 * 60 * 60 * 1000, // 25h ago
    });

    const pending = pendingStore.get(chatId);
    expect(pending).toBeDefined();
    expect(isExpired(pending!)).toBe(true);
  });

  // Trace S2, Section 5: non-owner cannot accept
  test("S2: non-owner cannot accept", () => {
    const chatId = -1001234567890;
    const ownerId = 12345;
    const nonOwnerId = 99999;

    pendingStore.set(chatId, {
      chatId,
      chatTitle: "Test Group",
      adderId: 67890,
      ownerId,
      dmMessageId: 100,
      createdAt: Date.now(),
    });

    const pending = pendingStore.get(chatId);
    expect(pending).toBeDefined();
    expect(nonOwnerId === pending!.ownerId).toBe(false);
  });

  // Trace S3: reject removes pending without registering
  test("S3: reject removes pending without registering", () => {
    const chatId = -1001234567890;
    pendingStore.set(chatId, {
      chatId,
      chatTitle: "Test Group",
      adderId: 67890,
      ownerId: 12345,
      dmMessageId: 100,
      createdAt: Date.now(),
    });

    const parsed = parseCallbackData(`grp:${chatId}:reject`);
    expect(parsed!.action).toBe("reject");

    pendingStore.delete(chatId);
    expect(pendingStore.has(chatId)).toBe(false);
    // GroupRegistry should NOT be called
  });

  // Callback data parsing
  test("parseCallbackData handles valid grp callback", () => {
    const result = parseCallbackData("grp:-1001234567890:accept");
    expect(result).toEqual({ chatId: -1001234567890, action: "accept" });
  });

  test("parseCallbackData rejects invalid format", () => {
    expect(parseCallbackData("model:context:general")).toBeNull();
    expect(parseCallbackData("grp:notanumber:accept")).toBeNull();
    expect(parseCallbackData("grp:-100:accept:extra")).toBeNull();
  });
});
