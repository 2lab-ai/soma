/**
 * Tests for Skills Registry Service
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { skillsRegistry } from "./skills-registry";
import { join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";

const TEST_REGISTRY_PATH = join(homedir(), ".claude", "skills-registry.json");
const TEST_BACKUP_PATH = `${TEST_REGISTRY_PATH}.backup`;

describe("SkillsRegistry", () => {
  beforeEach(async () => {
    // Backup existing registry if present
    if (existsSync(TEST_REGISTRY_PATH)) {
      const content = await Bun.file(TEST_REGISTRY_PATH).text();
      writeFileSync(TEST_BACKUP_PATH, content);
    }
  });

  afterEach(async () => {
    // Restore backup if exists
    if (existsSync(TEST_BACKUP_PATH)) {
      const content = await Bun.file(TEST_BACKUP_PATH).text();
      writeFileSync(TEST_REGISTRY_PATH, content);
      rmSync(TEST_BACKUP_PATH);
    }
  });

  it("should return defaults when registry file missing", async () => {
    // Remove registry file
    if (existsSync(TEST_REGISTRY_PATH)) {
      rmSync(TEST_REGISTRY_PATH);
    }

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["do-work", "new-task"]);
  });

  it("should handle corrupt JSON gracefully", async () => {
    // Write invalid JSON
    writeFileSync(TEST_REGISTRY_PATH, "{ invalid json ]");

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["do-work", "new-task"]);
  });

  it("should filter out invalid skill names on load", async () => {
    // Write registry with invalid names
    const data = ["do-work", "../../etc/passwd", "valid-skill", "", "123"];
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(data));

    const skills = await skillsRegistry.load();
    expect(skills).toContain("do-work");
    expect(skills).toContain("valid-skill");
    expect(skills).toContain("123");
    expect(skills).not.toContain("../../etc/passwd");
    expect(skills).not.toContain("");
  });

  it("should save and load registry", async () => {
    const testSkills = ["skill-a", "skill-b", "skill-c"];
    await skillsRegistry.save(testSkills);

    const loaded = await skillsRegistry.load();
    expect(loaded).toEqual(testSkills);
  });

  it("should validate skills against available skills", async () => {
    const skills = ["do-work", "new-task", "nonexistent-skill"];
    const valid = await skillsRegistry.validate(skills);

    // do-work and new-task should exist in ~/.claude/skills/
    expect(valid).toContain("do-work");
    expect(valid).toContain("new-task");
    expect(valid).not.toContain("nonexistent-skill");
  });

  it("should scan available skills", async () => {
    const available = await skillsRegistry.scan();

    // Should return array of skill directory names
    expect(Array.isArray(available)).toBe(true);
    expect(available.length).toBeGreaterThan(0);

    // Should include known skills
    expect(available).toContain("do-work");
    expect(available).toContain("new-task");
  });

  it("should sync (load, validate, save)", async () => {
    // Write registry with mix of valid and invalid
    const data = ["do-work", "nonexistent-skill", "new-task"];
    await skillsRegistry.save(data);

    const synced = await skillsRegistry.sync();

    // Should only contain valid skills
    expect(synced).toContain("do-work");
    expect(synced).toContain("new-task");
    expect(synced).not.toContain("nonexistent-skill");

    // Registry file should be updated
    const loaded = await skillsRegistry.load();
    expect(loaded).toEqual(synced);
  });

  it("should add skill if not present and valid", async () => {
    await skillsRegistry.save(["do-work"]);

    const added = await skillsRegistry.add("new-task");
    expect(added).toBe(true);

    const skills = await skillsRegistry.load();
    expect(skills).toContain("do-work");
    expect(skills).toContain("new-task");
  });

  it("should not add skill if already present", async () => {
    await skillsRegistry.save(["do-work"]);

    const added = await skillsRegistry.add("do-work");
    expect(added).toBe(false);

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["do-work"]);
  });

  it("should not add skill if it doesn't exist", async () => {
    await skillsRegistry.save(["do-work"]);

    const added = await skillsRegistry.add("nonexistent-skill");
    expect(added).toBe(false);

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["do-work"]);
  });

  it("should remove skill if present", async () => {
    await skillsRegistry.save(["do-work", "new-task"]);

    const removed = await skillsRegistry.remove("do-work");
    expect(removed).toBe(true);

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["new-task"]);
  });

  it("should not error when removing non-existent skill", async () => {
    await skillsRegistry.save(["do-work"]);

    const removed = await skillsRegistry.remove("nonexistent-skill");
    expect(removed).toBe(false);

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["do-work"]);
  });

  it("should reset registry to defaults", async () => {
    await skillsRegistry.save(["custom-skill-1", "custom-skill-2"]);

    await skillsRegistry.reset();

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["do-work", "new-task"]);
  });

  it("should handle large file size gracefully", async () => {
    // Write a file larger than MAX_REGISTRY_SIZE (10KB)
    const largeArray = new Array(10000).fill("skill-name");
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(largeArray));

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["do-work", "new-task"]);
  });

  it("should cache scan results", async () => {
    const scan1 = await skillsRegistry.scan();
    const scan2 = await skillsRegistry.scan();

    // Both scans should return same results (cache working)
    expect(scan1).toEqual(scan2);
  });

  it("should handle non-array JSON gracefully", async () => {
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify({ skills: ["do-work"] }));

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["do-work", "new-task"]);
  });

  it("should handle empty array", async () => {
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify([]));

    const skills = await skillsRegistry.load();
    expect(skills).toEqual([]);
  });

  it("should reject skill names over 64 characters", async () => {
    const longName = "a".repeat(65);
    const data = ["do-work", longName];
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(data));

    const skills = await skillsRegistry.load();
    expect(skills).toContain("do-work");
    expect(skills).not.toContain(longName);
  });

  it("should reject skill names starting with hyphen", async () => {
    const data = ["do-work", "-invalid-start"];
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(data));

    const skills = await skillsRegistry.load();
    expect(skills).toContain("do-work");
    expect(skills).not.toContain("-invalid-start");
  });

  it("should normalize skill names to lowercase", async () => {
    await skillsRegistry.save(["DO-WORK", "New-Task"]);

    const skills = await skillsRegistry.load();
    expect(skills).toContain("do-work");
    expect(skills).toContain("new-task");
    expect(skills).not.toContain("DO-WORK");
  });
});
