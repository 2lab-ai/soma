import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FileChatStorage } from "./chat-storage";
import type { ChatRecord, SessionReference } from "../types/chat-history";
import { rm, mkdir } from "fs/promises";
import { existsSync } from "fs";

const TEST_DATA_DIR = ".test-data-chat-storage";

describe("FileChatStorage", () => {
  let storage: FileChatStorage;

  beforeEach(async () => {
    // Clean up test directory
    if (existsSync(TEST_DATA_DIR)) {
      await rm(TEST_DATA_DIR, { recursive: true, force: true });
    }
    await mkdir(TEST_DATA_DIR, { recursive: true });

    storage = new FileChatStorage(TEST_DATA_DIR);
    await storage.init();
  });

  afterEach(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      await rm(TEST_DATA_DIR, { recursive: true, force: true });
    }
  });

  const createRecord = (overrides: Partial<ChatRecord> = {}): ChatRecord => ({
    id: `record-${Date.now()}-${Math.random()}`,
    sessionId: "session-1",
    claudeSessionId: "claude-1",
    model: "claude-sonnet-4-20250514",
    timestamp: new Date().toISOString(),
    speaker: "user",
    content: "test message",
    ...overrides,
  });

  test("saveChat creates NDJSON file", async () => {
    const record = createRecord();
    await storage.saveChat(record);

    const date = new Date(record.timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const expectedPath = `${TEST_DATA_DIR}/chats/${year}-${month}-${day}.ndjson`;

    expect(existsSync(expectedPath)).toBe(true);
  });

  test("saveBatch groups records by date", async () => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    await storage.saveBatch([
      createRecord({ timestamp: today.toISOString(), content: "today 1" }),
      createRecord({ timestamp: today.toISOString(), content: "today 2" }),
      createRecord({ timestamp: yesterday.toISOString(), content: "yesterday 1" }),
    ]);

    const results = await storage.search({
      from: yesterday,
      to: today,
      limit: 10,
    });

    expect(results.length).toBe(3);
    expect(results.find((r) => r.content === "today 1")).toBeDefined();
    expect(results.find((r) => r.content === "yesterday 1")).toBeDefined();
  });

  test("search filters by date range", async () => {
    const baseDate = new Date("2026-02-04T10:00:00Z");
    const dayBefore = new Date(baseDate);
    dayBefore.setDate(dayBefore.getDate() - 1);
    const dayAfter = new Date(baseDate);
    dayAfter.setDate(dayAfter.getDate() + 1);

    await storage.saveBatch([
      createRecord({ timestamp: dayBefore.toISOString(), content: "before" }),
      createRecord({ timestamp: baseDate.toISOString(), content: "target" }),
      createRecord({ timestamp: dayAfter.toISOString(), content: "after" }),
    ]);

    const results = await storage.search({
      from: baseDate,
      to: baseDate,
      limit: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0]?.content).toBe("target");
  });

  test("search filters by sessionId", async () => {
    await storage.saveBatch([
      createRecord({ sessionId: "session-1", content: "msg 1" }),
      createRecord({ sessionId: "session-2", content: "msg 2" }),
      createRecord({ sessionId: "session-1", content: "msg 3" }),
    ]);

    const results = await storage.search({
      from: new Date(Date.now() - 86400000),
      to: new Date(Date.now() + 86400000),
      sessionId: "session-1",
      limit: 10,
    });

    expect(results.length).toBe(2);
    expect(results.every((r) => r.sessionId === "session-1")).toBe(true);
  });

  test("search filters by speaker", async () => {
    await storage.saveBatch([
      createRecord({ speaker: "user", content: "user msg" }),
      createRecord({ speaker: "assistant", content: "assistant msg" }),
      createRecord({ speaker: "user", content: "user msg 2" }),
    ]);

    const results = await storage.search({
      from: new Date(Date.now() - 86400000),
      to: new Date(Date.now() + 86400000),
      speaker: "user",
      limit: 10,
    });

    expect(results.length).toBe(2);
    expect(results.every((r) => r.speaker === "user")).toBe(true);
  });

  test("search filters by query (case-insensitive)", async () => {
    await storage.saveBatch([
      createRecord({ content: "This is about ROCKETS" }),
      createRecord({ content: "This is about cars" }),
      createRecord({ content: "rockets are cool" }),
    ]);

    const results = await storage.search({
      from: new Date(Date.now() - 86400000),
      to: new Date(Date.now() + 86400000),
      query: "rocket",
      limit: 10,
    });

    expect(results.length).toBe(2);
    expect(results.every((r) => r.content.toLowerCase().includes("rocket"))).toBe(true);
  });

  test("search returns results sorted by timestamp descending", async () => {
    const base = new Date("2026-02-04T10:00:00Z");

    await storage.saveBatch([
      createRecord({ timestamp: new Date(base.getTime() + 1000).toISOString(), content: "3" }),
      createRecord({ timestamp: new Date(base.getTime()).toISOString(), content: "1" }),
      createRecord({ timestamp: new Date(base.getTime() + 500).toISOString(), content: "2" }),
    ]);

    const results = await storage.search({
      from: base,
      to: new Date(base.getTime() + 2000),
      limit: 10,
    });

    expect(results.map((r) => r.content)).toEqual(["3", "2", "1"]);
  });

  test("search respects limit and offset", async () => {
    await storage.saveBatch(
      Array.from({ length: 10 }, (_, i) => createRecord({ content: `msg ${i}` }))
    );

    const page1 = await storage.search({
      from: new Date(Date.now() - 86400000),
      to: new Date(Date.now() + 86400000),
      limit: 3,
      offset: 0,
    });

    const page2 = await storage.search({
      from: new Date(Date.now() - 86400000),
      to: new Date(Date.now() + 86400000),
      limit: 3,
      offset: 3,
    });

    expect(page1.length).toBe(3);
    expect(page2.length).toBe(3);
    expect(page1[0]?.id).not.toBe(page2[0]?.id);
  });

  test("getContextAround returns messages in time window", async () => {
    const base = new Date("2026-02-04T10:00:00Z");

    await storage.saveBatch([
      createRecord({
        timestamp: new Date(base.getTime() - 10 * 60000).toISOString(),
        content: "10 min before",
      }),
      createRecord({
        timestamp: new Date(base.getTime() - 2 * 60000).toISOString(),
        content: "2 min before",
      }),
      createRecord({ timestamp: base.toISOString(), content: "target" }),
      createRecord({
        timestamp: new Date(base.getTime() + 2 * 60000).toISOString(),
        content: "2 min after",
      }),
      createRecord({
        timestamp: new Date(base.getTime() + 10 * 60000).toISOString(),
        content: "10 min after",
      }),
    ]);

    const results = await storage.getContextAround(base, 5, 5); // ±5 minutes

    expect(results.length).toBe(3);
    expect(results.map((r) => r.content)).toEqual(["2 min before", "target", "2 min after"]);
  });

  test("saveSessionReference and getSessionReference", async () => {
    const ref: SessionReference = {
      sessionId: "session-123",
      claudeSessionId: "claude-456",
      transcriptPath: "/path/to/transcript",
      startTime: new Date().toISOString(),
      messageCount: 42,
    };

    await storage.saveSessionReference(ref);
    const retrieved = await storage.getSessionReference("session-123");

    expect(retrieved).not.toBeNull();
    expect(retrieved!.sessionId).toBe("session-123");
    expect(retrieved!.messageCount).toBe(42);
  });

  test("getSessionReference returns most recent for duplicate sessionIds", async () => {
    const ref1: SessionReference = {
      sessionId: "session-1",
      claudeSessionId: "claude-1",
      transcriptPath: "/path/1",
      startTime: new Date().toISOString(),
      messageCount: 10,
    };

    const ref2: SessionReference = {
      sessionId: "session-1",
      claudeSessionId: "claude-2",
      transcriptPath: "/path/2",
      startTime: new Date().toISOString(),
      messageCount: 20,
    };

    await storage.saveSessionReference(ref1);
    await storage.saveSessionReference(ref2);

    const retrieved = await storage.getSessionReference("session-1");

    expect(retrieved?.messageCount).toBe(20); // Most recent
  });

  test("getSessionReference returns null for non-existent session", async () => {
    const retrieved = await storage.getSessionReference("non-existent");
    expect(retrieved).toBeNull();
  });

  test("search returns empty array for non-existent date range", async () => {
    const results = await storage.search({
      from: new Date("2020-01-01"),
      to: new Date("2020-01-02"),
      limit: 10,
    });

    expect(results).toEqual([]);
  });

  test("concurrent saveBatch operations", async () => {
    const batches = Array.from({ length: 5 }, (_, batchIdx) =>
      Array.from({ length: 10 }, (_, i) =>
        createRecord({ content: `batch-${batchIdx}-msg-${i}` })
      )
    );

    await Promise.all(batches.map((batch) => storage.saveBatch(batch)));

    const results = await storage.search({
      from: new Date(Date.now() - 86400000),
      to: new Date(Date.now() + 86400000),
      limit: 100,
    });

    expect(results.length).toBe(50); // 5 batches × 10 records
  });
});
