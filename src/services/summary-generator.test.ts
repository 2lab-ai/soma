import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SummaryGenerator } from "./summary-generator";
import { existsSync, rmSync } from "fs";
import { readFile } from "fs/promises";
import type {
  ChatRecord,
  IChatStorage,
  ISummaryStorage,
  Summary,
} from "../types/chat-history";

class MockChatStorage implements IChatStorage {
  records: ChatRecord[] = [];

  async saveChat(record: ChatRecord): Promise<void> {
    this.records.push(record);
  }

  async saveBatch(records: ChatRecord[]): Promise<void> {
    this.records.push(...records);
  }

  async search(): Promise<ChatRecord[]> {
    return this.records;
  }

  async getContextAround(): Promise<ChatRecord[]> {
    return this.records;
  }

  async saveSessionReference(): Promise<void> {}
  async getSessionReference() {
    return null;
  }
}

class MockSummaryStorage implements ISummaryStorage {
  summaries: Summary[] = [];

  async saveSummary(summary: Summary): Promise<void> {
    this.summaries.push(summary);
  }

  async getSummaries(): Promise<Summary[]> {
    return this.summaries;
  }

  async getLatest(): Promise<Summary[]> {
    return this.summaries;
  }

  async getSummary(): Promise<Summary | null> {
    return this.summaries[0] || null;
  }
}

const TEST_SUMMARIES_DIR = "data/summaries";

describe("SummaryGenerator", () => {
  let chatStorage: MockChatStorage;
  let summaryStorage: MockSummaryStorage;
  let generator: SummaryGenerator;

  beforeEach(() => {
    chatStorage = new MockChatStorage();
    summaryStorage = new MockSummaryStorage();
    generator = new SummaryGenerator(chatStorage, summaryStorage);
    if (existsSync(TEST_SUMMARIES_DIR)) {
      rmSync(TEST_SUMMARIES_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_SUMMARIES_DIR)) {
      rmSync(TEST_SUMMARIES_DIR, { recursive: true });
    }
  });

  describe("saveSummary", () => {
    it("should save summary to storage", async () => {
      const content = "Test summary content";
      const periodStart = new Date("2025-01-01T00:00:00Z");
      const periodEnd = new Date("2025-01-02T00:00:00Z");

      const summary = await generator.saveSummary(
        content,
        "daily",
        periodStart,
        periodEnd,
        10
      );

      expect(summary.content).toBe(content);
      expect(summary.granularity).toBe("daily");
      expect(summary.chatCount).toBe(10);
      expect(summary.model).toBe("claude-session");
      expect(summaryStorage.summaries.length).toBe(1);
    });
  });

  describe("saveMarkdownSummary", () => {
    it("should save markdown file with correct path", async () => {
      const date = new Date("2025-06-15T12:00:00Z");
      const content = "# Daily Summary\n\nTest content";

      const path = await generator.saveMarkdownSummary(date, content);

      expect(path).toBe("data/summaries/2025-06-15.md");
      expect(existsSync(path)).toBe(true);

      const saved = await readFile(path, "utf-8");
      expect(saved).toBe(content);
    });

    it("should create directory if not exists", async () => {
      const date = new Date("2025-06-16T12:00:00Z");
      const content = "Test";

      await generator.saveMarkdownSummary(date, content);

      expect(existsSync(TEST_SUMMARIES_DIR)).toBe(true);
    });
  });

  describe("getSummaryPath", () => {
    it("should return correct path format", () => {
      const date = new Date("2025-12-31T23:59:59Z");
      const path = generator.getSummaryPath(date);
      expect(path).toBe("data/summaries/2025-12-31.md");
    });
  });

  describe("hasSummary", () => {
    it("should return false when no summary exists", () => {
      const date = new Date("2025-01-01");
      expect(generator.hasSummary(date)).toBe(false);
    });

    it("should return true when summary exists", async () => {
      const date = new Date("2025-01-02");
      await generator.saveMarkdownSummary(date, "Test");
      expect(generator.hasSummary(date)).toBe(true);
    });
  });

  describe("readSummary", () => {
    it("should return null when no summary exists", async () => {
      const date = new Date("2025-01-03");
      const result = await generator.readSummary(date);
      expect(result).toBeNull();
    });

    it("should return content when summary exists", async () => {
      const date = new Date("2025-01-04");
      const content = "Summary content here";
      await generator.saveMarkdownSummary(date, content);

      const result = await generator.readSummary(date);
      expect(result).toBe(content);
    });
  });

  describe("getChatCount", () => {
    it("should return count of chats in range", async () => {
      chatStorage.records = [
        {
          id: "1",
          sessionId: "s1",
          claudeSessionId: "c1",
          model: "sonnet",
          timestamp: "2025-01-01T12:00:00Z",
          speaker: "user",
          content: "Hello",
        },
        {
          id: "2",
          sessionId: "s1",
          claudeSessionId: "c1",
          model: "sonnet",
          timestamp: "2025-01-01T12:01:00Z",
          speaker: "assistant",
          content: "Hi",
        },
        {
          id: "3",
          sessionId: "s1",
          claudeSessionId: "c1",
          model: "sonnet",
          timestamp: "2025-01-01T12:02:00Z",
          speaker: "user",
          content: "Bye",
        },
      ];

      const count = await generator.getChatCount(
        new Date("2025-01-01"),
        new Date("2025-01-02")
      );

      expect(count).toBe(3);
    });
  });
});
