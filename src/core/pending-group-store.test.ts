/**
 * Contract Tests: PendingGroupStore
 * Trace: docs/group-owner-confirm/trace.md, Scenarios 1, 5
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";

const TEST_PERSISTENCE_PATH = "/tmp/soma-pending-groups-test.json";

function cleanupTestFile() {
  try {
    if (existsSync(TEST_PERSISTENCE_PATH)) unlinkSync(TEST_PERSISTENCE_PATH);
  } catch {}
}

// Lazy import to avoid top-level await issues with config
async function createStore() {
  const { PendingGroupStore } = await import("./pending-group-store");
  return new PendingGroupStore(TEST_PERSISTENCE_PATH);
}

describe("PendingGroupStore", () => {
  beforeEach(() => cleanupTestFile());
  afterEach(() => cleanupTestFile());

  // Trace S1, Section 3c: add stores pending confirmation
  test("add stores and get retrieves pending confirmation", async () => {
    const store = await createStore();
    store.add({
      chatId: -1001234567890,
      chatTitle: "Test Group",
      adderId: 12345,
      ownerId: 67890,
      dmMessageId: 100,
      createdAt: Date.now(),
    });

    const pending = store.get(-1001234567890);
    expect(pending).toBeDefined();
    expect(pending!.chatTitle).toBe("Test Group");
    expect(pending!.ownerId).toBe(67890);
  });

  // Trace S2, Section 4: accept removes pending entry
  test("remove deletes pending entry", async () => {
    const store = await createStore();
    store.add({
      chatId: -1001234567890,
      chatTitle: "Test Group",
      adderId: 12345,
      ownerId: 67890,
      dmMessageId: 100,
      createdAt: Date.now(),
    });

    store.remove(-1001234567890);
    expect(store.get(-1001234567890)).toBeUndefined();
  });

  // Trace S5, Section 3a: pending within TTL returns confirmation
  test("get returns confirmation within TTL", async () => {
    const store = await createStore();
    store.add({
      chatId: -1001234567890,
      chatTitle: "Test Group",
      adderId: 12345,
      ownerId: 67890,
      dmMessageId: 100,
      createdAt: Date.now(), // just now — within TTL
    });

    expect(store.get(-1001234567890)).toBeDefined();
  });

  // Trace S5, Section 3a: pending past TTL returns undefined and removes
  test("get returns undefined for expired pending (24h TTL)", async () => {
    const store = await createStore();
    const expired = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
    store.add({
      chatId: -1001234567890,
      chatTitle: "Test Group",
      adderId: 12345,
      ownerId: 67890,
      dmMessageId: 100,
      createdAt: expired,
    });

    expect(store.get(-1001234567890)).toBeUndefined();
  });

  // Trace S1, Section 3c: persistence round-trip
  test("persists and loads across instances", async () => {
    const store1 = await createStore();
    store1.add({
      chatId: -1001234567890,
      chatTitle: "Test Group",
      adderId: 12345,
      ownerId: 67890,
      dmMessageId: 100,
      createdAt: Date.now(),
    });

    const store2 = await createStore();
    const loaded = store2.get(-1001234567890);
    expect(loaded).toBeDefined();
    expect(loaded!.chatTitle).toBe("Test Group");
  });

  // Trace S1, Section 5: already pending is idempotent
  test("add overwrites existing pending for same chatId", async () => {
    const store = await createStore();
    store.add({
      chatId: -1001234567890,
      chatTitle: "Old Title",
      adderId: 12345,
      ownerId: 67890,
      dmMessageId: 100,
      createdAt: Date.now(),
    });
    store.add({
      chatId: -1001234567890,
      chatTitle: "New Title",
      adderId: 12345,
      ownerId: 67890,
      dmMessageId: 200,
      createdAt: Date.now(),
    });

    expect(store.get(-1001234567890)!.chatTitle).toBe("New Title");
    expect(store.get(-1001234567890)!.dmMessageId).toBe(200);
  });
});
