import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ClaudeMdUpdater, type Section } from "./claude-md-updater";
import type { Learning } from "./memory-analyzer";
import { writeFile, unlink, mkdir } from "fs/promises";
import { existsSync } from "fs";

const TEST_DIR = "/tmp/claude-md-updater-test";
const TEST_FILE = `${TEST_DIR}/CLAUDE.md`;

const SAMPLE_CLAUDE_MD = `# CLAUDE.md

This is a test file.

## Task Management

Use bd for task tracking.

## Commands

\`\`\`bash
bun run test
\`\`\`

## Patterns

<!-- AUTO_UPDATE: NO -->

Protected patterns section.

## Architecture

Module structure here.

## Security

Security guidelines.
`;

describe("ClaudeMdUpdater", () => {
  beforeEach(async () => {
    if (!existsSync(TEST_DIR)) {
      await mkdir(TEST_DIR, { recursive: true });
    }
    await writeFile(TEST_FILE, SAMPLE_CLAUDE_MD);
  });

  afterEach(async () => {
    if (existsSync(TEST_FILE)) {
      await unlink(TEST_FILE);
    }
  });

  describe("read", () => {
    it("should parse CLAUDE.md into sections", async () => {
      const updater = new ClaudeMdUpdater();
      const parsed = await updater.read(TEST_FILE);

      expect(parsed.sections.length).toBe(5);
      expect(parsed.sections[0]?.name).toBe("Task Management");
      expect(parsed.sections[1]?.name).toBe("Commands");
      expect(parsed.sections[2]?.name).toBe("Patterns");
      expect(parsed.sections[3]?.name).toBe("Architecture");
      expect(parsed.sections[4]?.name).toBe("Security");
    });

    it("should detect protected sections", async () => {
      const updater = new ClaudeMdUpdater();
      const parsed = await updater.read(TEST_FILE);

      const patternsSection = parsed.sections.find((s) => s.name === "Patterns");
      expect(patternsSection?.protected).toBe(true);

      const commandsSection = parsed.sections.find((s) => s.name === "Commands");
      expect(commandsSection?.protected).toBe(false);
    });

    it("should throw error for non-existent file", async () => {
      const updater = new ClaudeMdUpdater();
      await expect(updater.read("/nonexistent/path")).rejects.toThrow("File not found");
    });
  });

  describe("matchLearningToSection", () => {
    it("should match learning by keywords", async () => {
      const updater = new ClaudeMdUpdater();
      const parsed = await updater.read(TEST_FILE);

      const learning: Learning = {
        category: "commands",
        content: "Use bun test for running tests",
        confidence: 0.9,
        sourceQuotes: [],
      };

      const match = updater.matchLearningToSection(learning, parsed.sections);
      expect(match).toBe("Commands");
    });

    it("should respect protected sections", async () => {
      const updater = new ClaudeMdUpdater();
      const parsed = await updater.read(TEST_FILE);

      const learning: Learning = {
        category: "patterns",
        content: "New pattern for testing",
        confidence: 0.9,
        sourceQuotes: [],
        targetSection: "Patterns",
      };

      const match = updater.matchLearningToSection(learning, parsed.sections);
      expect(match).toBeNull();
    });

    it("should use targetSection if provided and not protected", async () => {
      const updater = new ClaudeMdUpdater();
      const parsed = await updater.read(TEST_FILE);

      const learning: Learning = {
        category: "rules",
        content: "Security rule",
        confidence: 0.9,
        sourceQuotes: [],
        targetSection: "Security",
      };

      const match = updater.matchLearningToSection(learning, parsed.sections);
      expect(match).toBe("Security");
    });

    it("should return null if no match found", async () => {
      const updater = new ClaudeMdUpdater();
      const parsed = await updater.read(TEST_FILE);

      const learning: Learning = {
        category: "patterns",
        content: "Something completely unrelated xyz123",
        confidence: 0.9,
        sourceQuotes: [],
      };

      const match = updater.matchLearningToSection(learning, parsed.sections);
      expect(match).toBeNull();
    });
  });

  describe("generateDiff", () => {
    it("should generate diff for unprotected section", async () => {
      const updater = new ClaudeMdUpdater();
      const section: Section = {
        name: "Commands",
        content: "Existing content",
        startLine: 10,
        endLine: 15,
        protected: false,
      };

      const learning: Learning = {
        category: "commands",
        content: "New command pattern",
        confidence: 0.9,
        sourceQuotes: [],
      };

      const diff = updater.generateDiff(section, learning);
      expect(diff).not.toBeNull();
      expect(diff?.newContent).toContain("New command pattern");
      expect(diff?.newContent).toContain("Existing content");
    });

    it("should return null for protected section", () => {
      const updater = new ClaudeMdUpdater();
      const section: Section = {
        name: "Patterns",
        content: "Protected content",
        startLine: 10,
        endLine: 15,
        protected: true,
      };

      const learning: Learning = {
        category: "patterns",
        content: "New pattern",
        confidence: 0.9,
        sourceQuotes: [],
      };

      const diff = updater.generateDiff(section, learning);
      expect(diff).toBeNull();
    });

    it("should skip duplicate content", () => {
      const updater = new ClaudeMdUpdater();
      const section: Section = {
        name: "Commands",
        content: "Use bun test for running tests",
        startLine: 10,
        endLine: 15,
        protected: false,
      };

      const learning: Learning = {
        category: "commands",
        content: "Use bun test for running tests",
        confidence: 0.9,
        sourceQuotes: [],
      };

      const diff = updater.generateDiff(section, learning);
      expect(diff).toBeNull();
    });
  });

  describe("applyDiffs", () => {
    it("should apply diffs to file", async () => {
      const updater = new ClaudeMdUpdater();
      const parsed = await updater.read(TEST_FILE);

      const commandsSection = parsed.sections.find((s) => s.name === "Commands");
      const diffs = [
        {
          sectionName: "Commands",
          oldContent: commandsSection!.content,
          newContent: commandsSection!.content + "\n\n**New**: Added command",
          reason: "Test diff",
        },
      ];

      const result = await updater.applyDiffs(parsed, diffs);

      expect(result.success).toBe(true);
      expect(result.appliedDiffs.length).toBe(1);
      expect(result.skippedDiffs.length).toBe(0);
    });

    it("should skip diffs for protected sections", async () => {
      const updater = new ClaudeMdUpdater();
      const parsed = await updater.read(TEST_FILE);

      const diffs = [
        {
          sectionName: "Patterns",
          oldContent: "Protected patterns section.",
          newContent: "Modified content",
          reason: "Test",
        },
      ];

      const result = await updater.applyDiffs(parsed, diffs);

      expect(result.success).toBe(true);
      expect(result.appliedDiffs.length).toBe(0);
      expect(result.skippedDiffs.length).toBe(1);
      expect(result.skippedDiffs[0]?.reason).toContain("protected");
    });

    it("should handle empty diffs", async () => {
      const updater = new ClaudeMdUpdater();
      const parsed = await updater.read(TEST_FILE);

      const result = await updater.applyDiffs(parsed, []);

      expect(result.success).toBe(true);
      expect(result.appliedDiffs.length).toBe(0);
    });
  });

  describe("update", () => {
    it("should filter low-confidence learnings", async () => {
      const updater = new ClaudeMdUpdater();
      const learnings: Learning[] = [
        { category: "commands", content: "Low confidence", confidence: 0.5, sourceQuotes: [] },
        { category: "commands", content: "High confidence cmd", confidence: 0.9, sourceQuotes: [] },
      ];

      const { result } = await updater.update(TEST_FILE, learnings);

      expect(result.appliedDiffs.length).toBeLessThanOrEqual(1);
    });
  });
});
