import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RetentionCleanupService, type RetentionConfig } from "./retention-cleanup";
import { writeFile, mkdir, rm, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const TEST_DIR = "/tmp/retention-cleanup-test";

async function setupTestDir() {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(join(TEST_DIR, "chats"), { recursive: true });
  await mkdir(join(TEST_DIR, "summaries", "hourly"), { recursive: true });
  await mkdir(join(TEST_DIR, "summaries", "daily"), { recursive: true });
  await mkdir(join(TEST_DIR, "summaries", "weekly"), { recursive: true });
  await mkdir(join(TEST_DIR, "summaries", "monthly"), { recursive: true });
}

async function createTestFile(path: string, daysOld: number) {
  await writeFile(path, JSON.stringify({ test: true }), "utf-8");
  // Set mtime to daysOld days ago
  const mtime = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  const { utimes } = await import("fs/promises");
  await utimes(path, mtime, mtime);
}

describe("RetentionCleanupService", () => {
  beforeEach(async () => {
    await setupTestDir();
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("should create service with default config", () => {
      const service = new RetentionCleanupService(TEST_DIR);
      const config = service.getConfig();
      expect(config.chatRetentionDays).toBe(90);
      expect(config.hourlySummaryRetentionDays).toBe(7);
    });

    it("should merge custom config", () => {
      const service = new RetentionCleanupService(TEST_DIR, {
        chatRetentionDays: 30,
      });
      const config = service.getConfig();
      expect(config.chatRetentionDays).toBe(30);
      expect(config.hourlySummaryRetentionDays).toBe(7); // Default preserved
    });
  });

  describe("runCleanup - dryRun", () => {
    it("should not delete files in dry run mode", async () => {
      // Create old chat file
      await createTestFile(join(TEST_DIR, "chats", "2020-01-01.ndjson"), 1000);

      const service = new RetentionCleanupService(TEST_DIR, {
        chatRetentionDays: 30,
      });

      const result = await service.runCleanup(true);

      expect(result.chatFilesDeleted).toBe(1);
      // File should still exist
      expect(existsSync(join(TEST_DIR, "chats", "2020-01-01.ndjson"))).toBe(true);
    });
  });

  describe("runCleanup - actual deletion", () => {
    it("should delete old chat files", async () => {
      await createTestFile(join(TEST_DIR, "chats", "2020-01-01.ndjson"), 1000);
      await createTestFile(join(TEST_DIR, "chats", "2026-02-01.ndjson"), 1);

      const service = new RetentionCleanupService(TEST_DIR, {
        chatRetentionDays: 30,
      });

      const result = await service.runCleanup(false);

      expect(result.chatFilesDeleted).toBe(1);
      expect(existsSync(join(TEST_DIR, "chats", "2020-01-01.ndjson"))).toBe(false);
      expect(existsSync(join(TEST_DIR, "chats", "2026-02-01.ndjson"))).toBe(true);
    });

    it("should delete old hourly summaries", async () => {
      await createTestFile(join(TEST_DIR, "summaries", "hourly", "2020-01-01-00.json"), 100);
      await createTestFile(join(TEST_DIR, "summaries", "hourly", "2026-02-01-00.json"), 1);

      const service = new RetentionCleanupService(TEST_DIR, {
        hourlySummaryRetentionDays: 7,
      });

      const result = await service.runCleanup(false);

      expect(result.summaryFilesDeleted.hourly).toBe(1);
      expect(existsSync(join(TEST_DIR, "summaries", "hourly", "2020-01-01-00.json"))).toBe(false);
      expect(existsSync(join(TEST_DIR, "summaries", "hourly", "2026-02-01-00.json"))).toBe(true);
    });

    it("should respect maxFiles limit", async () => {
      // Create 5 files, all recent
      for (let i = 1; i <= 5; i++) {
        await createTestFile(join(TEST_DIR, "chats", `2026-02-0${i}.ndjson`), i);
      }

      const service = new RetentionCleanupService(TEST_DIR, {
        chatRetentionDays: 365, // Don't delete by age
        maxChatFiles: 3,
      });

      const result = await service.runCleanup(false);

      expect(result.chatFilesDeleted).toBe(2);
      const remaining = await readdir(join(TEST_DIR, "chats"));
      expect(remaining.length).toBe(3);
    });

    it("should not delete monthly summaries when retention is -1", async () => {
      await createTestFile(join(TEST_DIR, "summaries", "monthly", "2020-01.json"), 2000);

      const service = new RetentionCleanupService(TEST_DIR, {
        monthlySummaryRetentionDays: -1,
      });

      const result = await service.runCleanup(false);

      expect(result.summaryFilesDeleted.monthly).toBe(0);
      expect(existsSync(join(TEST_DIR, "summaries", "monthly", "2020-01.json"))).toBe(true);
    });
  });

  describe("getStatus", () => {
    it("should return formatted status string", () => {
      const service = new RetentionCleanupService(TEST_DIR);
      const status = service.getStatus();

      expect(status).toContain("Retention Policy");
      expect(status).toContain("Chats:");
      expect(status).toContain("Hourly:");
      expect(status).toContain("Monthly:");
    });
  });

  describe("error handling", () => {
    it("should handle non-existent directory gracefully", async () => {
      const service = new RetentionCleanupService("/nonexistent/path");
      const result = await service.runCleanup(false);

      expect(result.chatFilesDeleted).toBe(0);
      expect(result.errors.length).toBe(0);
    });

    it("should collect errors without stopping cleanup", async () => {
      // Create a valid file alongside the test
      await createTestFile(join(TEST_DIR, "chats", "2026-02-01.ndjson"), 1);

      const service = new RetentionCleanupService(TEST_DIR, {
        chatRetentionDays: 30,
      });

      // Should complete without throwing
      const result = await service.runCleanup(false);
      expect(result).toBeDefined();
    });
  });
});
