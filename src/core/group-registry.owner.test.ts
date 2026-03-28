/**
 * Contract Tests: GroupRegistry with ownerId (Migration)
 * Trace: docs/group-owner-confirm/trace.md, Scenario 6
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync } from "fs";
import { GroupRegistry } from "./group-registry";
import { ALLOWED_USERS } from "../config";

const TEST_PERSISTENCE_PATH = "/tmp/soma-groups-owner-test.json";

function cleanupTestFile() {
  try {
    if (existsSync(TEST_PERSISTENCE_PATH)) unlinkSync(TEST_PERSISTENCE_PATH);
  } catch {}
}

function createRegistry() {
  return new GroupRegistry(TEST_PERSISTENCE_PATH);
}

describe("GroupRegistry — Owner Support (Scenario 6)", () => {
  beforeEach(() => cleanupTestFile());
  afterEach(() => cleanupTestFile());

  // Trace S6, Section 3a: register stores chatId with ownerId
  test("register(chatId, ownerId) stores owner association", () => {
    const registry = createRegistry();
    const result = registry.register(-1001234567890, 12345);
    expect(result).toBe(true);
    expect(registry.isRegistered(-1001234567890)).toBe(true);
    expect(registry.getOwner(-1001234567890)).toBe(12345);
  });

  // Trace S6, Section 3a: getOwner returns correct ownerId
  test("getOwner returns ownerId for registered group", () => {
    const registry = createRegistry();
    registry.register(-1001234567890, 12345);
    registry.register(-1009876543210, 67890);
    expect(registry.getOwner(-1001234567890)).toBe(12345);
    expect(registry.getOwner(-1009876543210)).toBe(67890);
  });

  // Trace S6, Section 3a: getOwner returns undefined for unregistered
  test("getOwner returns undefined for unregistered group", () => {
    const registry = createRegistry();
    expect(registry.getOwner(-9999)).toBeUndefined();
  });

  // Trace S6, Section 3a: unregister removes owner mapping
  test("unregister removes ownerId", () => {
    const registry = createRegistry();
    registry.register(-1001234567890, 12345);
    registry.unregister(-1001234567890);
    expect(registry.getOwner(-1001234567890)).toBeUndefined();
  });

  // Trace S6, Section 3b: loads old number[] format with migration
  test("migrates old number[] format to GroupEntry[] with default owner", () => {
    // Write old format
    writeFileSync(
      TEST_PERSISTENCE_PATH,
      JSON.stringify({
        groups: [-1001234567890, -1009876543210],
        updatedAt: "2026-03-27T00:00:00.000Z",
      })
    );

    const registry = createRegistry();
    expect(registry.isRegistered(-1001234567890)).toBe(true);
    expect(registry.isRegistered(-1009876543210)).toBe(true);
    // Migrated groups get ownerId = ALLOWED_USERS[0] (not 0)
    const expectedOwner = ALLOWED_USERS[0] ?? 0;
    expect(registry.getOwner(-1001234567890)).toBe(expectedOwner);
    expect(registry.getOwner(-1009876543210)).toBe(expectedOwner);
    // Verify disk was rewritten in new GroupEntry[] format
    const raw = JSON.parse(readFileSync(TEST_PERSISTENCE_PATH, "utf-8"));
    expect(Array.isArray(raw.groups)).toBe(true);
    expect(raw.groups[0]).toHaveProperty("chatId");
    expect(raw.groups[0]).toHaveProperty("ownerId", expectedOwner);
    expect(raw.groups[0]).toHaveProperty("activatedAt", "migrated");
  });

  // Trace S6, Section 3b: loads new GroupEntry[] format
  test("loads new GroupEntry[] format correctly", () => {
    writeFileSync(
      TEST_PERSISTENCE_PATH,
      JSON.stringify({
        groups: [
          { chatId: -1001234567890, ownerId: 12345, activatedAt: "2026-03-28T00:00:00Z" },
          { chatId: -1009876543210, ownerId: 67890, activatedAt: "2026-03-28T00:00:00Z" },
        ],
        updatedAt: "2026-03-28T00:00:00.000Z",
      })
    );

    const registry = createRegistry();
    expect(registry.isRegistered(-1001234567890)).toBe(true);
    expect(registry.getOwner(-1001234567890)).toBe(12345);
    expect(registry.getOwner(-1009876543210)).toBe(67890);
  });

  // Trace S6, Section 3a-3b: round-trip persistence with ownerId
  test("round-trip persistence preserves ownerId", () => {
    const registry1 = createRegistry();
    registry1.register(-1001234567890, 12345);
    registry1.register(-1009876543210, 67890);

    const registry2 = createRegistry();
    expect(registry2.getOwner(-1001234567890)).toBe(12345);
    expect(registry2.getOwner(-1009876543210)).toBe(67890);
    expect(registry2.size).toBe(2);
  });
});
