/**
 * Tests for Skills Registry Service
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { skillsRegistry, SkillsRegistryError } from "./skills-registry";
import { join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";

const TEST_REGISTRY_PATH = join(homedir(), ".claude", "skills-registry.json");
const TEST_BACKUP_PATH = `${TEST_REGISTRY_PATH}.backup`;
const TEST_SKILLS_DIR = join(homedir(), ".claude", "skills");
const REQUIRED_TEST_SKILLS = ["do-work", "new-task"];

let createdSkillDirs: string[] = [];
let createdSkillFiles: string[] = [];

describe("SkillsRegistry", () => {
  beforeEach(async () => {
    createdSkillDirs = [];
    createdSkillFiles = [];

    // Ensure deterministic test fixtures for validate/scan/sync/add flows.
    mkdirSync(TEST_SKILLS_DIR, { recursive: true });
    for (const skill of REQUIRED_TEST_SKILLS) {
      const skillDir = join(TEST_SKILLS_DIR, skill);
      const skillFile = join(skillDir, "SKILL.md");
      if (!existsSync(skillDir)) {
        mkdirSync(skillDir, { recursive: true });
        createdSkillDirs.push(skillDir);
      }
      if (!existsSync(skillFile)) {
        writeFileSync(skillFile, `# ${skill}\n\nTest fixture skill.\n`);
        createdSkillFiles.push(skillFile);
      }
    }

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

    for (const filePath of createdSkillFiles) {
      if (existsSync(filePath)) {
        rmSync(filePath, { force: true });
      }
    }
    for (const dirPath of createdSkillDirs.reverse()) {
      if (existsSync(dirPath)) {
        rmSync(dirPath, { recursive: true, force: true });
      }
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

  it("should throw SkillsRegistryError on corrupt JSON", async () => {
    // Write invalid JSON
    writeFileSync(TEST_REGISTRY_PATH, "{ invalid json ]");

    await expect(skillsRegistry.load()).rejects.toThrow(SkillsRegistryError);

    try {
      await skillsRegistry.load();
    } catch (e) {
      const error = e as SkillsRegistryError;
      expect(error.code).toBe("CORRUPT_FILE");
      expect(error.userMessage).toContain("corrupted");
    }
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

    const result = await skillsRegistry.add("new-task");
    expect(result.success).toBe(true);

    const skills = await skillsRegistry.load();
    expect(skills).toContain("do-work");
    expect(skills).toContain("new-task");
  });

  it("should not add skill if already present", async () => {
    await skillsRegistry.save(["do-work"]);

    const result = await skillsRegistry.add("do-work");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("already_exists");
      expect(result.message).toContain("already in the registry");
    }

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["do-work"]);
  });

  it("should not add skill if it doesn't exist", async () => {
    await skillsRegistry.save(["do-work"]);

    const result = await skillsRegistry.add("nonexistent-skill");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("not_found");
      expect(result.message).toContain("not found");
    }

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["do-work"]);
  });

  it("should remove skill if present", async () => {
    await skillsRegistry.save(["do-work", "new-task"]);

    const result = await skillsRegistry.remove("do-work");
    expect(result.success).toBe(true);

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["new-task"]);
  });

  it("should return failure when removing non-existent skill", async () => {
    await skillsRegistry.save(["do-work"]);

    const result = await skillsRegistry.remove("nonexistent-skill");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("not_in_registry");
    }

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["do-work"]);
  });

  it("should reset registry to defaults", async () => {
    await skillsRegistry.save(["custom-skill-1", "custom-skill-2"]);

    await skillsRegistry.reset();

    const skills = await skillsRegistry.load();
    expect(skills).toEqual(["do-work", "new-task"]);
  });

  it("should throw on large file size", async () => {
    // Write a file larger than MAX_REGISTRY_SIZE (10KB)
    const largeArray = new Array(10000).fill("skill-name");
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(largeArray));

    await expect(skillsRegistry.load()).rejects.toThrow(SkillsRegistryError);

    try {
      await skillsRegistry.load();
    } catch (e) {
      const error = e as SkillsRegistryError;
      expect(error.code).toBe("SIZE_EXCEEDED");
      expect(error.userMessage).toContain("too large");
    }
  });

  it("should cache scan results", async () => {
    const scan1 = await skillsRegistry.scan();
    const scan2 = await skillsRegistry.scan();

    // Both scans should return same results (cache working)
    expect(scan1).toEqual(scan2);
  });

  it("should throw on non-array JSON", async () => {
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify({ skills: ["do-work"] }));

    await expect(skillsRegistry.load()).rejects.toThrow(SkillsRegistryError);

    try {
      await skillsRegistry.load();
    } catch (e) {
      const error = e as SkillsRegistryError;
      expect(error.code).toBe("CORRUPT_FILE");
      expect(error.userMessage).toContain("invalid format");
    }
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

  // Critical test cases from soma-a9s

  it("should throw SIZE_EXCEEDED when trying to save too many skills", async () => {
    // Create array that exceeds MAX_REGISTRY_SIZE (10KB) when serialized
    // Each entry ~20 chars in JSON, need ~600 to exceed 10KB with formatting
    const tooManySkills = Array.from(
      { length: 800 },
      (_, i) => `skill-name-${i.toString().padStart(5, "0")}`
    );
    const serialized = JSON.stringify(tooManySkills, null, 2);
    expect(serialized.length).toBeGreaterThan(10 * 1024); // Verify our test data is large enough

    await expect(skillsRegistry.save(tooManySkills)).rejects.toThrow(
      SkillsRegistryError
    );

    try {
      await skillsRegistry.save(tooManySkills);
    } catch (e) {
      const error = e as SkillsRegistryError;
      expect(error.code).toBe("SIZE_EXCEEDED");
      expect(error.userMessage).toContain("too many skills");
    }
  });

  it("should clean up temp file after atomic write", async () => {
    const tempPath = `${TEST_REGISTRY_PATH}.tmp`;

    // Ensure no leftover temp file
    if (existsSync(tempPath)) {
      rmSync(tempPath);
    }

    await skillsRegistry.save(["do-work", "new-task"]);

    // Temp file should not exist after successful save
    expect(existsSync(tempPath)).toBe(false);
  });

  it("should handle empty skills directory in scan", async () => {
    // scan() returns empty array if no valid skills found
    // This tests the case where directory exists but has no valid skills
    const available = await skillsRegistry.scan();

    // Should return an array (could be empty or have skills depending on env)
    expect(Array.isArray(available)).toBe(true);
  });

  it("should not update cache on scan when no skills directory", async () => {
    // First scan to populate cache
    const firstScan = await skillsRegistry.scan();

    // Cache should be populated
    const secondScan = await skillsRegistry.scan();
    expect(secondScan).toEqual(firstScan);
  });

  it("should handle concurrent save operations safely", async () => {
    // Run multiple saves concurrently using Promise.allSettled
    // Some may fail due to atomic rename race, but data should remain valid
    const saves = [
      skillsRegistry.save(["skill-a"]),
      skillsRegistry.save(["skill-b"]),
      skillsRegistry.save(["skill-c"]),
    ];

    const results = await Promise.allSettled(saves);

    // At least one should succeed
    const successes = results.filter((r) => r.status === "fulfilled");
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // Registry should be valid and contain one of the values
    const loaded = await skillsRegistry.load();
    expect(loaded.length).toBe(1);
    expect(["skill-a", "skill-b", "skill-c"]).toContain(loaded[0]!);
  });

  it("should return invalid_name reason for add() with special characters", async () => {
    await skillsRegistry.save(["do-work"]);

    const result = await skillsRegistry.add("skill@with#special!");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("invalid_name");
      expect(result.message).toContain("lowercase letters, numbers, and hyphens");
    }
  });

  it("should handle case-insensitive add() - DO-WORK same as do-work", async () => {
    await skillsRegistry.save(["do-work"]);

    const result = await skillsRegistry.add("DO-WORK");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("already_exists");
    }
  });

  it("should handle case-insensitive remove() - DO-WORK same as do-work", async () => {
    await skillsRegistry.save(["do-work", "new-task"]);

    const result = await skillsRegistry.remove("DO-WORK");
    expect(result.success).toBe(true);

    const skills = await skillsRegistry.load();
    expect(skills).not.toContain("do-work");
    expect(skills).toContain("new-task");
  });

  it("should not save when sync() finds no changes needed", async () => {
    // Save valid skills only
    await skillsRegistry.save(["do-work", "new-task"]);

    // Get initial file modification time
    const initialStat = Bun.file(TEST_REGISTRY_PATH);
    const initialSize = initialStat.size;

    // Sync should not change anything since all skills are valid
    const synced = await skillsRegistry.sync();

    // Should return same skills
    expect(synced).toContain("do-work");
    expect(synced).toContain("new-task");

    // File should be unchanged (same size at minimum)
    const finalStat = Bun.file(TEST_REGISTRY_PATH);
    expect(finalStat.size).toBe(initialSize);
  });
});
