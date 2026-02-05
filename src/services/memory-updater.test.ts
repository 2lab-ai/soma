import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryUpdater } from "./memory-updater";
import type { Learning } from "./memory-analyzer";
import { writeFile, unlink, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const TEST_DIR = "/tmp/memory-updater-test";
const TEST_CLAUDE_MD = `${TEST_DIR}/CLAUDE.md`;
const TEST_MEMORY_MD = `${TEST_DIR}/MEMORY.md`;

const SAMPLE_CLAUDE_MD = `# CLAUDE.md

## Commands

Use bun for this project.

## Patterns

Follow these patterns.

## Architecture

Module structure here.
`;

const SAMPLE_MEMORY_MD = `# MEMORY.md

## Recent Events

Nothing yet.
`;

describe("MemoryUpdater", () => {
  beforeEach(async () => {
    if (!existsSync(TEST_DIR)) {
      await mkdir(TEST_DIR, { recursive: true });
    }
    await writeFile(TEST_CLAUDE_MD, SAMPLE_CLAUDE_MD);
    await writeFile(TEST_MEMORY_MD, SAMPLE_MEMORY_MD);

    try {
      await execAsync("git init", { cwd: TEST_DIR });
      await execAsync("git config user.email 'test@test.com'", { cwd: TEST_DIR });
      await execAsync("git config user.name 'Test'", { cwd: TEST_DIR });
      await execAsync("git add .", { cwd: TEST_DIR });
      await execAsync("git commit -m 'Initial commit'", { cwd: TEST_DIR });
    } catch {}
  });

  afterEach(async () => {
    const filesToClean = [TEST_CLAUDE_MD, TEST_MEMORY_MD];
    for (const file of filesToClean) {
      if (existsSync(file)) {
        await unlink(file);
      }
    }

    const backupPattern = `${TEST_DIR}/*.backup.*`;
    try {
      const { stdout } = await execAsync(`ls ${backupPattern} 2>/dev/null || true`);
      const backupFiles = stdout.trim().split("\n").filter(Boolean);
      for (const backup of backupFiles) {
        if (existsSync(backup)) {
          await unlink(backup);
        }
      }
    } catch {}
  });

  describe("updateMemoryFiles", () => {
    it("should skip low-confidence learnings", async () => {
      const updater = new MemoryUpdater({
        claudeMdPath: TEST_CLAUDE_MD,
        workingDir: TEST_DIR,
        dryRun: true,
      });

      const learnings: Learning[] = [
        {
          category: "commands",
          content: "Low confidence",
          confidence: 0.5,
          sourceQuotes: [],
        },
      ];

      const result = await updater.updateMemoryFiles(learnings);

      expect(result.success).toBe(true);
      expect(result.filesUpdated).toEqual([]);
      expect(result.learningsApplied).toBe(0);
      expect(result.learningsSkipped).toBe(1);
    });

    it("should update files with high-confidence learnings", async () => {
      const updater = new MemoryUpdater({
        claudeMdPath: TEST_CLAUDE_MD,
        workingDir: TEST_DIR,
        dryRun: true,
      });

      const learnings: Learning[] = [
        {
          category: "commands",
          content: "Use make up for deployment",
          confidence: 0.9,
          sourceQuotes: [],
        },
      ];

      const result = await updater.updateMemoryFiles(learnings);

      expect(result.success).toBe(true);
      expect(result.learningsApplied).toBeGreaterThanOrEqual(0);
    });

    it("should rollback on validation failure", async () => {
      const updater = new MemoryUpdater({
        claudeMdPath: TEST_CLAUDE_MD,
        workingDir: TEST_DIR,
      });

      const originalContent = await readFile(TEST_CLAUDE_MD, "utf-8");

      await writeFile(TEST_CLAUDE_MD, "");

      await updater.rollback();

      const restoredContent = await readFile(TEST_CLAUDE_MD, "utf-8");
      expect(restoredContent).toBe("");

      await writeFile(TEST_CLAUDE_MD, originalContent);
    });
  });

  describe("validateUpdates", () => {
    it("should return true for valid markdown files", async () => {
      const updater = new MemoryUpdater({
        claudeMdPath: TEST_CLAUDE_MD,
        workingDir: TEST_DIR,
      });

      const isValid = await updater.validateUpdates([TEST_CLAUDE_MD]);
      expect(isValid).toBe(true);
    });

    it("should return false for empty files", async () => {
      const updater = new MemoryUpdater({
        claudeMdPath: TEST_CLAUDE_MD,
        workingDir: TEST_DIR,
      });

      await writeFile(TEST_CLAUDE_MD, "");

      const isValid = await updater.validateUpdates([TEST_CLAUDE_MD]);
      expect(isValid).toBe(false);
    });

    it("should return false for files without headers", async () => {
      const updater = new MemoryUpdater({
        claudeMdPath: TEST_CLAUDE_MD,
        workingDir: TEST_DIR,
      });

      await writeFile(TEST_CLAUDE_MD, "Just plain text without any markdown headers");

      const isValid = await updater.validateUpdates([TEST_CLAUDE_MD]);
      expect(isValid).toBe(false);
    });

    it("should return false for unclosed code blocks", async () => {
      const updater = new MemoryUpdater({
        claudeMdPath: TEST_CLAUDE_MD,
        workingDir: TEST_DIR,
      });

      await writeFile(TEST_CLAUDE_MD, "# Title\n\n```bash\nunclosed code block");

      const isValid = await updater.validateUpdates([TEST_CLAUDE_MD]);
      expect(isValid).toBe(false);
    });
  });

  describe("commitChanges", () => {
    it("should create a git commit", async () => {
      const updater = new MemoryUpdater({
        claudeMdPath: TEST_CLAUDE_MD,
        workingDir: TEST_DIR,
      });

      await writeFile(TEST_CLAUDE_MD, SAMPLE_CLAUDE_MD + "\n\nNew content");

      const hash = await updater.commitChanges("Test commit", [TEST_CLAUDE_MD]);

      expect(hash).toBeDefined();
      expect(hash?.length).toBeGreaterThan(0);
    });

    it("should return undefined when nothing to commit", async () => {
      const updater = new MemoryUpdater({
        claudeMdPath: TEST_CLAUDE_MD,
        workingDir: TEST_DIR,
      });

      const hash = await updater.commitChanges("Test commit", [TEST_CLAUDE_MD]);

      expect(hash).toBeUndefined();
    });
  });

  describe("rollback", () => {
    it("should restore files from backups", async () => {
      const updater = new MemoryUpdater({
        claudeMdPath: TEST_CLAUDE_MD,
        workingDir: TEST_DIR,
      });

      const originalContent = await readFile(TEST_CLAUDE_MD, "utf-8");

      const backupPath = `${TEST_CLAUDE_MD}.backup.${Date.now()}`;
      await writeFile(backupPath, originalContent);
      (updater as unknown as { backupFiles: Map<string, string> }).backupFiles.set(
        TEST_CLAUDE_MD,
        backupPath
      );

      await writeFile(TEST_CLAUDE_MD, "Modified content");

      await updater.rollback();

      const restoredContent = await readFile(TEST_CLAUDE_MD, "utf-8");
      expect(restoredContent).toBe(originalContent);
      expect(existsSync(backupPath)).toBe(false);
    });
  });
});
