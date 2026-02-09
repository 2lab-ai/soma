import { describe, test, expect, beforeEach } from "bun:test";
import { ChatCaptureService } from "./chat-capture-service";
import type {
  ChatRecord,
  IChatStorage,
  SessionReference,
  ChatSearchOptions,
} from "../types/chat-history";

class MockChatStorage implements IChatStorage {
  public records: ChatRecord[] = [];
  public sessionRefs: SessionReference[] = [];
  public saveError: Error | null = null;

  async saveChat(record: ChatRecord): Promise<void> {
    if (this.saveError) throw this.saveError;
    this.records.push(record);
  }

  async saveBatch(records: ChatRecord[]): Promise<void> {
    if (this.saveError) throw this.saveError;
    this.records.push(...records);
  }

  async search(_options: ChatSearchOptions): Promise<ChatRecord[]> {
    return this.records;
  }

  async getContextAround(
    _timestamp: Date,
    _before: number,
    _after: number
  ): Promise<ChatRecord[]> {
    return this.records;
  }

  async saveSessionReference(ref: SessionReference): Promise<void> {
    if (this.saveError) throw this.saveError;
    this.sessionRefs.push(ref);
  }

  async getSessionReference(sessionId: string): Promise<SessionReference | null> {
    return this.sessionRefs.find((r) => r.sessionId === sessionId) || null;
  }

  reset() {
    this.records = [];
    this.sessionRefs = [];
    this.saveError = null;
  }
}

describe("ChatCaptureService", () => {
  let storage: MockChatStorage;
  let service: ChatCaptureService;

  beforeEach(() => {
    storage = new MockChatStorage();
    service = new ChatCaptureService(storage);
  });

  test("captureMessage saves a message to storage", async () => {
    await service.captureMessage({
      sessionId: "session-1",
      claudeSessionId: "claude-1",
      model: "claude-sonnet-4-20250514",
      speaker: "user",
      content: "Hello Claude",
    });

    expect(storage.records.length).toBe(1);
    expect(storage.records[0]?.content).toBe("Hello Claude");
    expect(storage.records[0]?.speaker).toBe("user");
  });

  test("captureMessage generates unique IDs", async () => {
    await service.captureMessage({
      sessionId: "session-1",
      claudeSessionId: "claude-1",
      model: "claude-sonnet-4-20250514",
      speaker: "user",
      content: "Message 1",
    });

    await service.captureMessage({
      sessionId: "session-1",
      claudeSessionId: "claude-1",
      model: "claude-sonnet-4-20250514",
      speaker: "user",
      content: "Message 2",
    });

    expect(storage.records.length).toBe(2);
    expect(storage.records[0]?.id).not.toBe(storage.records[1]?.id);
  });

  test("captureMessage sets timestamp", async () => {
    const before = Date.now();

    await service.captureMessage({
      sessionId: "session-1",
      claudeSessionId: "claude-1",
      model: "claude-sonnet-4-20250514",
      speaker: "user",
      content: "Test",
    });

    const after = Date.now();

    const timestamp = new Date(storage.records[0]!.timestamp).getTime();
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  test("captureMessage includes optional fields", async () => {
    await service.captureMessage({
      sessionId: "session-1",
      claudeSessionId: "claude-1",
      model: "claude-sonnet-4-20250514",
      speaker: "tool",
      content: "Tool result",
      toolName: "read_file",
      toolInput: { path: "/test" },
      thinkingSummary: "Reading file",
      tokenUsage: { input: 100, output: 50 },
    });

    const record = storage.records[0]!;
    expect(record.toolName).toBe("read_file");
    expect(record.toolInput).toEqual({ path: "/test" });
    expect(record.thinkingSummary).toBe("Reading file");
    expect(record.tokenUsage).toEqual({ input: 100, output: 50 });
  });

  test("captureMessage handles storage errors gracefully", async () => {
    storage.saveError = new Error("Storage failure");

    // Should not throw
    await service.captureMessage({
      sessionId: "session-1",
      claudeSessionId: "claude-1",
      model: "claude-sonnet-4-20250514",
      speaker: "user",
      content: "Test",
    });

    expect(storage.records.length).toBe(0);
  });

  test("captureMessages saves multiple messages efficiently", async () => {
    await service.captureMessages([
      {
        sessionId: "session-1",
        claudeSessionId: "claude-1",
        model: "claude-sonnet-4-20250514",
        speaker: "user",
        content: "Message 1",
      },
      {
        sessionId: "session-1",
        claudeSessionId: "claude-1",
        model: "claude-sonnet-4-20250514",
        speaker: "assistant",
        content: "Response 1",
      },
      {
        sessionId: "session-1",
        claudeSessionId: "claude-1",
        model: "claude-sonnet-4-20250514",
        speaker: "user",
        content: "Message 2",
      },
    ]);

    expect(storage.records.length).toBe(3);
    expect(storage.records[0]?.content).toBe("Message 1");
    expect(storage.records[1]?.content).toBe("Response 1");
    expect(storage.records[2]?.content).toBe("Message 2");
  });

  test("captureMessages handles empty array", async () => {
    await service.captureMessages([]);
    expect(storage.records.length).toBe(0);
  });

  test("captureMessages handles storage errors gracefully", async () => {
    storage.saveError = new Error("Batch save failed");

    await service.captureMessages([
      {
        sessionId: "session-1",
        claudeSessionId: "claude-1",
        model: "claude-sonnet-4-20250514",
        speaker: "user",
        content: "Test",
      },
    ]);

    expect(storage.records.length).toBe(0);
  });

  test("captureUserMessage convenience method", async () => {
    await service.captureUserMessage(
      "session-1",
      "claude-1",
      "model-1",
      "User message"
    );

    expect(storage.records.length).toBe(1);
    expect(storage.records[0]?.speaker).toBe("user");
    expect(storage.records[0]?.content).toBe("User message");
    expect(storage.records[0]?.sessionId).toBe("session-1");
  });

  test("captureAssistantMessage convenience method", async () => {
    await service.captureAssistantMessage(
      "session-1",
      "claude-1",
      "model-1",
      "Assistant response"
    );

    expect(storage.records.length).toBe(1);
    expect(storage.records[0]?.speaker).toBe("assistant");
    expect(storage.records[0]?.content).toBe("Assistant response");
  });

  test("captureAssistantMessage with optional fields", async () => {
    await service.captureAssistantMessage(
      "session-1",
      "claude-1",
      "model-1",
      "Response",
      {
        thinkingSummary: "Analyzing...",
        tokenUsage: { input: 200, output: 100 },
      }
    );

    const record = storage.records[0]!;
    expect(record.thinkingSummary).toBe("Analyzing...");
    expect(record.tokenUsage).toEqual({ input: 200, output: 100 });
  });

  test("captureToolExecution convenience method", async () => {
    await service.captureToolExecution(
      "session-1",
      "claude-1",
      "model-1",
      "read_file",
      { path: "/test.txt" },
      "File contents"
    );

    const record = storage.records[0]!;
    expect(record.speaker).toBe("tool");
    expect(record.toolName).toBe("read_file");
    expect(record.toolInput).toEqual({ path: "/test.txt" });
    expect(record.content).toBe("File contents");
  });

  test("saveSessionReference stores session info", async () => {
    const ref: SessionReference = {
      sessionId: "session-1",
      claudeSessionId: "claude-1",
      transcriptPath: "/path/to/transcript",
      startTime: new Date().toISOString(),
      messageCount: 10,
    };

    await service.saveSessionReference(ref);

    expect(storage.sessionRefs.length).toBe(1);
    expect(storage.sessionRefs[0]).toEqual(ref);
  });

  test("saveSessionReference handles errors gracefully", async () => {
    storage.saveError = new Error("Session ref save failed");

    await service.saveSessionReference({
      sessionId: "session-1",
      claudeSessionId: "claude-1",
      transcriptPath: "/path",
      startTime: new Date().toISOString(),
      messageCount: 0,
    });

    expect(storage.sessionRefs.length).toBe(0);
  });

  test("getSessionReference retrieves session info", async () => {
    const ref: SessionReference = {
      sessionId: "session-123",
      claudeSessionId: "claude-456",
      transcriptPath: "/path/to/transcript",
      startTime: new Date().toISOString(),
      messageCount: 42,
    };

    await service.saveSessionReference(ref);
    const retrieved = await service.getSessionReference("session-123");

    expect(retrieved).toEqual(ref);
  });

  test("getSessionReference returns null for non-existent session", async () => {
    const retrieved = await service.getSessionReference("non-existent");
    expect(retrieved).toBeNull();
  });

  test("concurrent captureMessage calls", async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      service.captureMessage({
        sessionId: "session-1",
        claudeSessionId: "claude-1",
        model: "model-1",
        speaker: "user",
        content: `Message ${i}`,
      })
    );

    await Promise.all(promises);

    expect(storage.records.length).toBe(10);
    expect(new Set(storage.records.map((r) => r.id)).size).toBe(10); // All unique IDs
  });
});
