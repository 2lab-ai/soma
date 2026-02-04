import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { SummaryGenerator } from "./summary-generator";
import type { ChatRecord, IChatStorage, ISummaryStorage, Summary } from "../types/chat-history";

const mockFetch = mock(() => Promise.resolve(new Response()));

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

describe("SummaryGenerator", () => {
  const originalFetch = globalThis.fetch;
  let chatStorage: MockChatStorage;
  let summaryStorage: MockSummaryStorage;

  beforeEach(() => {
    globalThis.fetch = mockFetch;
    mockFetch.mockClear();
    chatStorage = new MockChatStorage();
    summaryStorage = new MockSummaryStorage();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("generate", () => {
    it("should return success with no chats when period is empty", async () => {
      const generator = new SummaryGenerator(chatStorage, summaryStorage, {
        anthropicApiKey: "test-key",
      });

      const result = await generator.generate({
        granularity: "hourly",
        periodStart: new Date("2025-01-01T00:00:00Z"),
        periodEnd: new Date("2025-01-01T01:00:00Z"),
      });

      expect(result.success).toBe(true);
      expect(result.chatCount).toBe(0);
      expect(result.error).toContain("No chats");
    });

    it("should return error when API key not configured", async () => {
      const generator = new SummaryGenerator(chatStorage, summaryStorage);

      chatStorage.records = [
        {
          id: "1",
          sessionId: "s1",
          claudeSessionId: "cs1",
          model: "sonnet",
          timestamp: "2025-01-01T00:30:00Z",
          speaker: "user",
          content: "Hello",
        },
      ];

      const result = await generator.generate({
        granularity: "hourly",
        periodStart: new Date("2025-01-01T00:00:00Z"),
        periodEnd: new Date("2025-01-01T01:00:00Z"),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("API key");
    });

    it("should generate and save summary on success", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "msg_123",
            content: [{ type: "text", text: "Summary: User greeted, assistant responded." }],
            model: "claude-3-5-haiku-20241022",
            stop_reason: "end_turn",
            usage: { input_tokens: 50, output_tokens: 30 },
          }),
          { status: 200 }
        )
      );

      const generator = new SummaryGenerator(chatStorage, summaryStorage, {
        anthropicApiKey: "test-key",
      });

      chatStorage.records = [
        {
          id: "1",
          sessionId: "s1",
          claudeSessionId: "cs1",
          model: "sonnet",
          timestamp: "2025-01-01T00:30:00Z",
          speaker: "user",
          content: "Hello",
        },
        {
          id: "2",
          sessionId: "s1",
          claudeSessionId: "cs1",
          model: "sonnet",
          timestamp: "2025-01-01T00:30:05Z",
          speaker: "assistant",
          content: "Hi there!",
        },
      ];

      const result = await generator.generate({
        granularity: "hourly",
        periodStart: new Date("2025-01-01T00:00:00Z"),
        periodEnd: new Date("2025-01-01T01:00:00Z"),
      });

      expect(result.success).toBe(true);
      expect(result.summary).toBeDefined();
      expect(result.summary?.content).toContain("Summary");
      expect(result.chatCount).toBe(2);
      expect(summaryStorage.summaries.length).toBe(1);
    });

    it("should handle API errors gracefully", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Server error" } }), { status: 500 })
      );

      const generator = new SummaryGenerator(chatStorage, summaryStorage, {
        anthropicApiKey: "test-key",
      });

      chatStorage.records = [
        {
          id: "1",
          sessionId: "s1",
          claudeSessionId: "cs1",
          model: "sonnet",
          timestamp: "2025-01-01T00:30:00Z",
          speaker: "user",
          content: "Hello",
        },
      ];

      const result = await generator.generate({
        granularity: "hourly",
        periodStart: new Date("2025-01-01T00:00:00Z"),
        periodEnd: new Date("2025-01-01T01:00:00Z"),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("generateHourly", () => {
    it("should set correct period boundaries", async () => {
      const generator = new SummaryGenerator(chatStorage, summaryStorage, {
        anthropicApiKey: "test-key",
      });

      const result = await generator.generateHourly(new Date("2025-01-01T14:30:00Z"));

      expect(result.chatCount).toBe(0);
    });
  });

  describe("generateDaily", () => {
    it("should set correct period boundaries", async () => {
      const generator = new SummaryGenerator(chatStorage, summaryStorage, {
        anthropicApiKey: "test-key",
      });

      const result = await generator.generateDaily(new Date("2025-01-15T14:30:00Z"));

      expect(result.chatCount).toBe(0);
    });
  });

  describe("formatChatsForSummary", () => {
    it("should skip tool messages", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "msg_123",
            content: [{ type: "text", text: "Summary" }],
            model: "claude-3-5-haiku-20241022",
            stop_reason: "end_turn",
            usage: { input_tokens: 50, output_tokens: 30 },
          }),
          { status: 200 }
        )
      );

      const generator = new SummaryGenerator(chatStorage, summaryStorage, {
        anthropicApiKey: "test-key",
      });

      chatStorage.records = [
        {
          id: "1",
          sessionId: "s1",
          claudeSessionId: "cs1",
          model: "sonnet",
          timestamp: "2025-01-01T00:30:00Z",
          speaker: "user",
          content: "Run command",
        },
        {
          id: "2",
          sessionId: "s1",
          claudeSessionId: "cs1",
          model: "sonnet",
          timestamp: "2025-01-01T00:30:05Z",
          speaker: "tool",
          content: "Tool output here",
          toolName: "Bash",
        },
        {
          id: "3",
          sessionId: "s1",
          claudeSessionId: "cs1",
          model: "sonnet",
          timestamp: "2025-01-01T00:30:10Z",
          speaker: "assistant",
          content: "Command executed",
        },
      ];

      const result = await generator.generate({
        granularity: "hourly",
        periodStart: new Date("2025-01-01T00:00:00Z"),
        periodEnd: new Date("2025-01-01T01:00:00Z"),
      });

      expect(result.success).toBe(true);

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call?.[1]?.body as string);
      expect(body.messages[0].content).not.toContain("Tool output");
    });
  });
});
