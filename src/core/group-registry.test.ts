/**
 * RED Contract Tests for GroupRegistry
 * Trace: docs/telegram-group-session/trace.md
 *
 * All tests must FAIL (RED) before implementation.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync } from "fs";

const TEST_PERSISTENCE_PATH = "/tmp/soma-groups-test.json";

function cleanupTestFile(): void {
  try {
    if (existsSync(TEST_PERSISTENCE_PATH)) {
      unlinkSync(TEST_PERSISTENCE_PATH);
    }
  } catch {
    // ignore
  }
}

// This import will fail until GroupRegistry is implemented — that's RED.
let GroupRegistry: any;
try {
  GroupRegistry = (await import("./group-registry")).GroupRegistry;
} catch {
  // Module doesn't exist yet — all tests will fail with a clear message
}

function createRegistry(): any {
  if (!GroupRegistry) throw new Error("GroupRegistry not implemented yet");
  return new GroupRegistry(TEST_PERSISTENCE_PATH);
}

describe("GroupRegistry", () => {
  beforeEach(() => cleanupTestFile());
  afterEach(() => cleanupTestFile());

  // ─── Scenario 1, Section 4: register adds chatId to set and persists ──
  describe("register", () => {
    test("Trace S1/S4: register adds chatId to set and persists to disk", () => {
      const registry = createRegistry();

      const result = registry.register(-1001234567890);

      expect(result).toBe(true);
      expect(registry.isRegistered(-1001234567890)).toBe(true);

      expect(existsSync(TEST_PERSISTENCE_PATH)).toBe(true);
      const data = JSON.parse(readFileSync(TEST_PERSISTENCE_PATH, "utf-8"));
      // New format: groups is array of { chatId, ownerId, activatedAt }
      const chatIds = data.groups.map((g: any) => typeof g === "number" ? g : g.chatId);
      expect(chatIds).toContain(-1001234567890);
      expect(data.updatedAt).toBeDefined();
    });

    test("Trace S1: register returns false for already registered group", () => {
      const registry = createRegistry();

      registry.register(-1001234567890);
      const result = registry.register(-1001234567890);

      expect(result).toBe(false);
    });

    test("Trace S2: register not called — unregistered group stays unregistered", () => {
      const registry = createRegistry();

      expect(registry.isRegistered(-9999)).toBe(false);
    });
  });

  // ─── Scenario 3, Section 4: unregister removes chatId and persists ──
  describe("unregister", () => {
    test("Trace S3/S4: unregister removes chatId and persists to disk", () => {
      const registry = createRegistry();

      registry.register(-1001234567890);
      const result = registry.unregister(-1001234567890);

      expect(result).toBe(true);
      expect(registry.isRegistered(-1001234567890)).toBe(false);

      const data = JSON.parse(readFileSync(TEST_PERSISTENCE_PATH, "utf-8"));
      const chatIds = data.groups.map((g: any) => typeof g === "number" ? g : g.chatId);
      expect(chatIds).not.toContain(-1001234567890);
    });

    test("Trace S3/S5: unregister of non-registered group is no-op", () => {
      const registry = createRegistry();

      const result = registry.unregister(-9999);

      expect(result).toBe(false);
    });
  });

  // ─── Scenario 5: Persistence across restarts ──
  describe("persistence", () => {
    test("Trace S5/S3a: loadFromDisk restores persisted groups", () => {
      writeFileSync(
        TEST_PERSISTENCE_PATH,
        JSON.stringify({
          groups: [-1001234567890, -1009876543210],
          updatedAt: new Date().toISOString(),
        })
      );

      const registry = createRegistry();

      expect(registry.isRegistered(-1001234567890)).toBe(true);
      expect(registry.isRegistered(-1009876543210)).toBe(true);
      expect(registry.isRegistered(-9999)).toBe(false);
    });

    test("Trace S5/S5-Row1: loadFromDisk handles missing file gracefully", () => {
      const registry = createRegistry();

      expect(registry.isRegistered(-1001234567890)).toBe(false);
      expect(registry.size).toBe(0);
    });

    test("Trace S5/S5-Row2: loadFromDisk handles corrupted JSON gracefully", () => {
      writeFileSync(TEST_PERSISTENCE_PATH, "NOT VALID JSON{{{");

      const registry = createRegistry();

      expect(registry.size).toBe(0);
    });

    test("Trace S5/S3b: saveToDisk writes correct format", () => {
      const registry = createRegistry();

      registry.register(-1001234567890);
      registry.register(-1009876543210);

      const raw = readFileSync(TEST_PERSISTENCE_PATH, "utf-8");
      const data = JSON.parse(raw);

      expect(data).toHaveProperty("groups");
      expect(data).toHaveProperty("updatedAt");
      expect(Array.isArray(data.groups)).toBe(true);
      expect(data.groups.length).toBe(2);
      const chatIds = data.groups.map((g: any) => typeof g === "number" ? g : g.chatId);
      expect(chatIds).toContain(-1001234567890);
      expect(chatIds).toContain(-1009876543210);
    });

    test("Trace S5: register then restart preserves state (round-trip)", () => {
      const registry1 = createRegistry();
      registry1.register(-1001234567890);
      registry1.register(-1009876543210);

      const registry2 = createRegistry();

      expect(registry2.isRegistered(-1001234567890)).toBe(true);
      expect(registry2.isRegistered(-1009876543210)).toBe(true);
      expect(registry2.size).toBe(2);
    });
  });

  describe("isRegistered", () => {
    test("Trace S4: returns true for registered group", () => {
      const registry = createRegistry();
      registry.register(-1001234567890);
      expect(registry.isRegistered(-1001234567890)).toBe(true);
    });

    test("Trace S4: returns false for unregistered group", () => {
      const registry = createRegistry();
      expect(registry.isRegistered(-1001234567890)).toBe(false);
    });
  });
});
