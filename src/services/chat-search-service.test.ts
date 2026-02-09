import { describe, test, expect, beforeEach } from "bun:test";
import { ChatSearchService } from "./chat-search-service";
import type {
  ChatRecord,
  IChatStorage,
  SessionReference,
  ChatSearchOptions,
} from "../types/chat-history";

class MockChatStorage implements IChatStorage {
  public records: ChatRecord[] = [];

  async saveChat(record: ChatRecord): Promise<void> {
    this.records.push(record);
  }

  async saveBatch(records: ChatRecord[]): Promise<void> {
    this.records.push(...records);
  }

  async search(options: ChatSearchOptions): Promise<ChatRecord[]> {
    let results = [...this.records];

    // Filter by date range
    results = results.filter((r) => {
      const date = new Date(r.timestamp);
      return date >= options.from && date <= options.to;
    });

    // Filter by sessionId
    if (options.sessionId) {
      results = results.filter((r) => r.sessionId === options.sessionId);
    }

    // Filter by speaker
    if (options.speaker) {
      results = results.filter((r) => r.speaker === options.speaker);
    }

    // Filter by query
    if (options.query) {
      results = results.filter((r) =>
        r.content.toLowerCase().includes(options.query!.toLowerCase())
      );
    }

    // Sort by timestamp descending
    results.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Pagination
    const offset = options.offset || 0;
    const limit = options.limit || 100;
    return results.slice(offset, offset + limit);
  }

  async getContextAround(
    timestamp: Date,
    beforeMinutes: number,
    afterMinutes: number
  ): Promise<ChatRecord[]> {
    const windowStart = new Date(timestamp.getTime() - beforeMinutes * 60000);
    const windowEnd = new Date(timestamp.getTime() + afterMinutes * 60000);

    const results = this.records.filter((r) => {
      const date = new Date(r.timestamp);
      return date >= windowStart && date <= windowEnd;
    });

    // Sort chronologically
    return results.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  async saveSessionReference(_ref: SessionReference): Promise<void> {}
  async getSessionReference(_sessionId: string): Promise<SessionReference | null> {
    return null;
  }
}

describe("ChatSearchService", () => {
  let storage: MockChatStorage;
  let service: ChatSearchService;

  beforeEach(() => {
    storage = new MockChatStorage();
    service = new ChatSearchService(storage);

    // Add test data
    const now = new Date();
    storage.records = [
      createRecord({
        timestamp: new Date(now.getTime() - 1000 * 60 * 60 * 24 * 5).toISOString(), // 5 days ago
        speaker: "user",
        content: "What is the weather like?",
      }),
      createRecord({
        timestamp: new Date(now.getTime() - 1000 * 60 * 60 * 24 * 5).toISOString(),
        speaker: "assistant",
        content: "The weather is sunny today.",
      }),
      createRecord({
        timestamp: new Date(now.getTime() - 1000 * 60 * 60 * 2).toISOString(), // 2 hours ago
        speaker: "user",
        content: "Tell me about rockets",
        sessionId: "session-123",
      }),
      createRecord({
        timestamp: new Date(now.getTime() - 1000 * 60 * 60 * 2).toISOString(),
        speaker: "assistant",
        content: "Rockets are vehicles designed to travel to space.",
        sessionId: "session-123",
      }),
      createRecord({
        timestamp: new Date(now.getTime() - 1000 * 60 * 30).toISOString(), // 30 min ago
        speaker: "user",
        content: "What about Mars?",
      }),
    ];
  });

  function createRecord(overrides: Partial<ChatRecord> = {}): ChatRecord {
    return {
      id: `record-${Math.random()}`,
      sessionId: "default-session",
      claudeSessionId: "claude-default",
      model: "claude-sonnet-4-5",
      timestamp: new Date().toISOString(),
      speaker: "user",
      content: "test message",
      ...overrides,
    };
  }

  test("searchByDateRange filters by date range", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 6); // 6 days ago
    const to = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 4); // 4 days ago

    const results = await service.searchByDateRange({ from, to });

    expect(results.length).toBe(2); // Only the 5-day-ago messages
  });

  test("searchByDateRange filters by query", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 10);
    const to = new Date();

    const results = await service.searchByDateRange({
      from,
      to,
      query: "rocket",
    });

    expect(results.length).toBe(2); // Both "rockets" user message and "Rockets" assistant message
    expect(results.some((r) => r.content.toLowerCase().includes("rocket"))).toBe(true);
  });

  test("searchByDateRange filters by speaker", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 10);
    const to = new Date();

    const results = await service.searchByDateRange({
      from,
      to,
      speaker: "user",
    });

    expect(results.length).toBe(3);
    expect(results.every((r) => r.speaker === "user")).toBe(true);
  });

  test("searchRecent gets last N days", async () => {
    const results = await service.searchRecent({ lastNDays: 3 });

    // Should get messages from last 3 days (2 hours ago and 30 min ago)
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test("searchRecent gets last N hours", async () => {
    const results = await service.searchRecent({ lastNHours: 1 });

    // Should get only the 30-min-ago message
    expect(results.length).toBe(1);
    expect(results[0]?.content).toContain("Mars");
  });

  test("searchRecent defaults to 7 days", async () => {
    const results = await service.searchRecent();

    // Should get all 5 messages (all within 7 days)
    expect(results.length).toBe(5);
  });

  test("getContextAround returns messages in time window", async () => {
    const now = new Date();
    const targetTime = new Date(now.getTime() - 1000 * 60 * 60 * 2); // 2 hours ago

    const results = await service.getContextAround({
      timestamp: targetTime,
      beforeMinutes: 10,
      afterMinutes: 10,
    });

    // Should get the 2 messages from 2 hours ago
    expect(results.length).toBe(2);
  });

  test("searchByKeyword finds messages with keyword", async () => {
    const results = await service.searchByKeyword("rockets");

    expect(results.length).toBe(2); // Both user and assistant messages
    expect(results.every((r) => r.content.toLowerCase().includes("rocket"))).toBe(true);
  });

  test("searchByKeyword respects lastNDays", async () => {
    const results = await service.searchByKeyword("weather", { lastNDays: 3 });

    // 5-day-old message should be excluded
    expect(results.length).toBe(0);
  });

  test("getUserMessages gets only user messages", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 10);
    const to = new Date();

    const results = await service.getUserMessages(from, to);

    expect(results.length).toBe(3);
    expect(results.every((r) => r.speaker === "user")).toBe(true);
  });

  test("getAssistantMessages gets only assistant messages", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 10);
    const to = new Date();

    const results = await service.getAssistantMessages(from, to);

    expect(results.length).toBe(2);
    expect(results.every((r) => r.speaker === "assistant")).toBe(true);
  });

  test("getConversation returns user and assistant separately", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 10);
    const to = new Date();

    const results = await service.getConversation(from, to);

    expect(results.user.length).toBe(3);
    expect(results.assistant.length).toBe(2);
  });

  test("searchInSession filters by sessionId", async () => {
    const results = await service.searchInSession("session-123");

    expect(results.length).toBe(2);
    expect(results.every((r) => r.sessionId === "session-123")).toBe(true);
  });

  test("searchInSession supports query filter", async () => {
    const results = await service.searchInSession("session-123", {
      query: "rockets",
    });

    expect(results.length).toBe(2); // Both messages in session-123 contain "rocket"
  });

  test("getMostRecent returns N most recent messages", async () => {
    const results = await service.getMostRecent(2);

    expect(results.length).toBe(2);
    // Most recent first
    expect(results[0]?.content).toContain("Mars");
  });

  test("searchByDateRange respects limit", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 10);
    const to = new Date();

    const results = await service.searchByDateRange({
      from,
      to,
      limit: 2,
    });

    expect(results.length).toBe(2);
  });

  test("searchByDateRange respects offset", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 10);
    const to = new Date();

    const page1 = await service.searchByDateRange({
      from,
      to,
      limit: 2,
      offset: 0,
    });

    const page2 = await service.searchByDateRange({
      from,
      to,
      limit: 2,
      offset: 2,
    });

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page1[0]?.id).not.toBe(page2[0]?.id);
  });
});
