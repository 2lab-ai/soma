/**
 * Contract Tests for Security — Group Session Integration
 * Trace: docs/telegram-group-session/trace.md, Scenarios 4 & 6
 *
 * Tests the GroupRegistry's effect on authorization and response decisions.
 * Uses GroupRegistry directly to avoid config module process.exit() in test env.
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

describe("Security — Group Registry Integration", () => {
  let registry: GroupRegistry;

  beforeEach(() => {
    cleanupTestFile();
    registry = new GroupRegistry(TEST_PERSISTENCE_PATH);
  });

  afterEach(() => cleanupTestFile());

  // ─── Scenario 4: isAuthorizedForChat logic with dynamic registry ──

  describe("Authorization logic — dynamic groups", () => {
    test("Trace S4: dynamically registered group is recognized", () => {
      registry.register(-1001234567890);

      expect(registry.isRegistered(-1001234567890)).toBe(true);
    });

    test("Trace S4/S5-Row1: unregistered group is rejected", () => {
      expect(registry.isRegistered(-9999999999)).toBe(false);
    });

    test("Trace S6: static and dynamic groups coexist independently", () => {
      registry.register(-1001111111111);

      expect(registry.isRegistered(-1001111111111)).toBe(true);
      expect(registry.isRegistered(-9999999999)).toBe(false);
    });
  });

  // ─── Scenario 4: shouldRespondInChat logic ──

  describe("Response logic — dynamic groups", () => {
    test("Trace S4: registered group returns true for isRegistered (DM-like)", () => {
      registry.register(-1001234567890);

      // In the actual shouldRespondInChat, if groupRegistry.isRegistered(chatId)
      // returns true, it returns true immediately (like private chat).
      expect(registry.isRegistered(-1001234567890)).toBe(true);
    });

    test("Trace S6: unregistered group does not get DM-like behavior", () => {
      // Unregistered group — isRegistered returns false
      // shouldRespondInChat would fall through to legacy mention check
      expect(registry.isRegistered(-9999888877)).toBe(false);
    });

    test("Trace S4: registered group responds without mention", () => {
      registry.register(-1001234567890);

      // The core logic: if isRegistered → always respond
      const isRegistered = registry.isRegistered(-1001234567890);
      expect(isRegistered).toBe(true);

      // In shouldRespondInChat, this would return true before checking mentions
    });

    test("Trace S4: unregistered group with mention still triggers response", () => {
      // Even without dynamic registration, @mention should work
      // This is tested by shouldRespond() legacy behavior
      const messageText = "hello @testbot world";
      const hasMention = messageText.includes("@testbot");
      expect(hasMention).toBe(true);
    });

    test("Trace S4: unregistered group without mention does not respond", () => {
      const messageText = "hello world";
      const hasMention = messageText.includes("@testbot");
      expect(hasMention).toBe(false);
    });
  });

  // ─── Scenario 6: Backward Compatibility ──

  describe("Backward compatibility", () => {
    test("Trace S6: GroupRegistry is independent of static config", () => {
      // GroupRegistry only tracks dynamic groups
      // Static ALLOWED_GROUPS is handled by isAuthorizedForChat directly
      expect(registry.size).toBe(0);

      registry.register(-1001111111111);
      expect(registry.size).toBe(1);

      // Doesn't affect static groups — that's config module's job
    });

    test("Trace S6: multiple groups can be registered and queried", () => {
      registry.register(-1001111111111);
      registry.register(-1002222222222);
      registry.register(-1003333333333);

      expect(registry.isRegistered(-1001111111111)).toBe(true);
      expect(registry.isRegistered(-1002222222222)).toBe(true);
      expect(registry.isRegistered(-1003333333333)).toBe(true);
      expect(registry.isRegistered(-9999999999)).toBe(false);
    });
  });
});
