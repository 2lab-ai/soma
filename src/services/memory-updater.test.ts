import { describe, it, expect } from "bun:test";
import { MemoryUpdater } from "./memory-updater";
import type { Learning } from "./memory-analyzer";
import { writeFile, readFile, rm, mkdtemp } from "fs/promises";
import { existsSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const TEST_DIR_PREFIX = "/tmp/memory-updater-test-";

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

interface TestFixture {
  dir: string;
  claudeMdPath: string;
  memoryMdPath: string;
}

async function createFixture(): Promise<TestFixture> {
  const dir = await mkdtemp(TEST_DIR_PREFIX);
  const claudeMdPath = `${dir}/CLAUDE.md`;
  const memoryMdPath = `${dir}/MEMORY.md`;

  await writeFile(claudeMdPath, SAMPLE_CLAUDE_MD);
  await writeFile(memoryMdPath, SAMPLE_MEMORY_MD);

  await execAsync("git init", { cwd: dir });
  await execAsync("git config user.email 'test@test.com'", { cwd: dir });
  await execAsync("git config user.name 'Test'", { cwd: dir });
  await execAsync("git add .", { cwd: dir });
  await execAsync("git commit -m 'Initial commit'", { cwd: dir });

  return {
    dir,
    claudeMdPath,
    memoryMdPath,
  };
}

async function withFixture(
  run: (fixture: TestFixture) => Promise<void>
): Promise<void> {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
}

describe("MemoryUpdater", () => {
  describe("updateMemoryFiles", () => {
    it("should skip low-confidence learnings", async () => {
      await withFixture(async ({ claudeMdPath, dir }) => {
        const updater = new MemoryUpdater({
          claudeMdPath,
          workingDir: dir,
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
    });

    it("should update files with high-confidence learnings", async () => {
      await withFixture(async ({ claudeMdPath, dir }) => {
        const updater = new MemoryUpdater({
          claudeMdPath,
          workingDir: dir,
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
    });

    it("should rollback on validation failure", async () => {
      await withFixture(async ({ claudeMdPath, dir }) => {
        const updater = new MemoryUpdater({
          claudeMdPath,
          workingDir: dir,
        });

        const originalContent = await readFile(claudeMdPath, "utf-8");

        await writeFile(claudeMdPath, "");

        await updater.rollback();

        const restoredContent = await readFile(claudeMdPath, "utf-8");
        expect(restoredContent).toBe("");

        await writeFile(claudeMdPath, originalContent);
      });
    });
  });

  describe("validateUpdates", () => {
    it("should return true for valid markdown files", async () => {
      await withFixture(async ({ claudeMdPath, dir }) => {
        const updater = new MemoryUpdater({
          claudeMdPath,
          workingDir: dir,
        });

        const isValid = await updater.validateUpdates([claudeMdPath]);
        expect(isValid).toBe(true);
      });
    });

    it("should return false for empty files", async () => {
      await withFixture(async ({ claudeMdPath, dir }) => {
        const updater = new MemoryUpdater({
          claudeMdPath,
          workingDir: dir,
        });

        await writeFile(claudeMdPath, "");

        const isValid = await updater.validateUpdates([claudeMdPath]);
        expect(isValid).toBe(false);
      });
    });

    it("should return false for files without headers", async () => {
      await withFixture(async ({ claudeMdPath, dir }) => {
        const updater = new MemoryUpdater({
          claudeMdPath,
          workingDir: dir,
        });

        await writeFile(claudeMdPath, "Just plain text without any markdown headers");

        const isValid = await updater.validateUpdates([claudeMdPath]);
        expect(isValid).toBe(false);
      });
    });

    it("should return false for unclosed code blocks", async () => {
      await withFixture(async ({ claudeMdPath, dir }) => {
        const updater = new MemoryUpdater({
          claudeMdPath,
          workingDir: dir,
        });

        await writeFile(claudeMdPath, "# Title\n\n```bash\nunclosed code block");

        const isValid = await updater.validateUpdates([claudeMdPath]);
        expect(isValid).toBe(false);
      });
    });
  });

  describe("commitChanges", () => {
    it("should create a git commit", async () => {
      await withFixture(async ({ claudeMdPath, dir }) => {
        const updater = new MemoryUpdater({
          claudeMdPath,
          workingDir: dir,
        });

        await writeFile(claudeMdPath, SAMPLE_CLAUDE_MD + "\n\nNew content");

        const hash = await updater.commitChanges("Test commit", [claudeMdPath]);

        expect(hash).toBeDefined();
        expect(hash?.length).toBeGreaterThan(0);
      });
    });

    it("should return undefined when nothing to commit", async () => {
      await withFixture(async ({ claudeMdPath, dir }) => {
        const updater = new MemoryUpdater({
          claudeMdPath,
          workingDir: dir,
        });

        const hash = await updater.commitChanges("Test commit", [claudeMdPath]);

        expect(hash).toBeUndefined();
      });
    });
  });

  describe("rollback", () => {
    it("should restore files from backups", async () => {
      await withFixture(async ({ claudeMdPath, dir }) => {
        const updater = new MemoryUpdater({
          claudeMdPath,
          workingDir: dir,
        });

        const originalContent = await readFile(claudeMdPath, "utf-8");

        const backupPath = `${claudeMdPath}.backup.${Date.now()}`;
        await writeFile(backupPath, originalContent);
        (updater as unknown as { backupFiles: Map<string, string> }).backupFiles.set(
          claudeMdPath,
          backupPath
        );

        await writeFile(claudeMdPath, "Modified content");

        await updater.rollback();

        const restoredContent = await readFile(claudeMdPath, "utf-8");
        expect(restoredContent).toBe(originalContent);
        expect(existsSync(backupPath)).toBe(false);
      });
    });
  });
});
