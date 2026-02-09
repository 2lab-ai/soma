import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import {
  saveRestartContext,
  findLatestRestartContext,
  formatRestartContextMessage,
  type ContextStats,
} from "./context-persistence";

const TEST_DIR = "/tmp/soma-test-context";

describe("context-persistence", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("saveRestartContext", () => {
    it("should create restart-context file with correct format", () => {
      const stats: ContextStats = {
        totalSessions: 1,
        totalQueries: 5,
        contextPercentage: "38.9",
        contextTokens: 77887,
        contextWindowSize: 200000,
      };

      const saveFile = saveRestartContext(TEST_DIR, stats, "2026-02-06T00-00-00");

      expect(existsSync(saveFile)).toBe(true);
      expect(saveFile).toContain("restart-context-2026-02-06T00-00-00.md");
    });

    it("should create directory if not exists", () => {
      const newDir = `${TEST_DIR}/nested/dir`;
      const stats: ContextStats = {
        totalSessions: 1,
        totalQueries: 1,
        contextPercentage: "10",
        contextTokens: 20000,
        contextWindowSize: 200000,
      };

      saveRestartContext(newDir, stats, "test-timestamp");

      expect(existsSync(newDir)).toBe(true);
    });

    it("should include all stats in file content", () => {
      const stats: ContextStats = {
        totalSessions: 2,
        totalQueries: 10,
        contextPercentage: "50.5",
        contextTokens: 101000,
        contextWindowSize: 200000,
      };

      saveRestartContext(TEST_DIR, stats, "stats-test");
      const result = findLatestRestartContext(TEST_DIR);

      expect(result).not.toBeNull();
      expect(result!.content).toContain("Active sessions: 2");
      expect(result!.content).toContain("Total queries: 10");
      expect(result!.content).toContain("50.5%");
      expect(result!.content).toContain("101,000");
    });
  });

  describe("findLatestRestartContext", () => {
    it("should return null for non-existent directory", () => {
      const result = findLatestRestartContext("/tmp/non-existent-dir-12345");
      expect(result).toBeNull();
    });

    it("should return null for empty directory", () => {
      const result = findLatestRestartContext(TEST_DIR);
      expect(result).toBeNull();
    });

    it("should return latest file by mtime", async () => {
      const stats: ContextStats = {
        totalSessions: 1,
        totalQueries: 1,
        contextPercentage: "10",
        contextTokens: 20000,
        contextWindowSize: 200000,
      };

      saveRestartContext(TEST_DIR, stats, "2026-01-01T00-00-00");
      await Bun.sleep(10);
      saveRestartContext(TEST_DIR, stats, "2026-02-01T00-00-00");
      await Bun.sleep(10);
      saveRestartContext(TEST_DIR, stats, "2026-03-01T00-00-00");

      const result = findLatestRestartContext(TEST_DIR);

      expect(result).not.toBeNull();
      expect(result!.name).toBe("restart-context-2026-03-01T00-00-00.md");
    });

    it("should include file content", () => {
      const stats: ContextStats = {
        totalSessions: 1,
        totalQueries: 5,
        contextPercentage: "25",
        contextTokens: 50000,
        contextWindowSize: 200000,
      };

      saveRestartContext(TEST_DIR, stats, "content-test");
      const result = findLatestRestartContext(TEST_DIR);

      expect(result).not.toBeNull();
      expect(result!.content).toContain("# Restart Context");
      expect(result!.content).toContain("Gracefully shut down via make up");
    });
  });

  describe("formatRestartContextMessage", () => {
    it("should format message with file name and content", () => {
      const file = {
        name: "restart-context-2026-02-06T00-00-00.md",
        path: "/path/to/file.md",
        mtime: Date.now(),
        content: "# Restart Context\n\nTest content",
      };

      const message = formatRestartContextMessage(file);

      expect(message).toContain("📋 **Saved Context Found:**");
      expect(message).toContain("restart-context-2026-02-06T00-00-00.md");
      expect(message).toContain("# Restart Context");
      expect(message).toContain("Test content");
    });
  });
});
