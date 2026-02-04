import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FileSummaryStorage } from "./summary-storage";
import type { Summary, SummaryGranularity } from "../types/chat-history";
import { rm, mkdir } from "fs/promises";
import { existsSync } from "fs";

const TEST_DATA_DIR = ".test-data-summary-storage";

describe("FileSummaryStorage", () => {
  let storage: FileSummaryStorage;

  beforeEach(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      await rm(TEST_DATA_DIR, { recursive: true, force: true });
    }
    await mkdir(TEST_DATA_DIR, { recursive: true });

    storage = new FileSummaryStorage(TEST_DATA_DIR);
    await storage.init();
  });

  afterEach(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      await rm(TEST_DATA_DIR, { recursive: true, force: true });
    }
  });

  const createSummary = (
    granularity: SummaryGranularity,
    periodStart: Date,
    periodEnd: Date,
    content = "test summary"
  ): Summary => ({
    id: `summary-${Date.now()}-${Math.random()}`,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    granularity,
    model: "claude-haiku-4-20250514",
    content,
    chatCount: 10,
  });

  test("saveSummary creates file for hourly granularity", async () => {
    const date = new Date("2026-02-04T10:00:00Z");
    const summary = createSummary("hourly", date, new Date(date.getTime() + 3600000));

    await storage.saveSummary(summary);

    const retrieved = await storage.getSummary("hourly", date);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("test summary");
  });

  test("saveSummary creates file for daily granularity", async () => {
    const date = new Date("2026-02-04T00:00:00Z");
    const summary = createSummary("daily", date, new Date(date.getTime() + 86400000));

    await storage.saveSummary(summary);

    const retrieved = await storage.getSummary("daily", date);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("test summary");
  });

  test("saveSummary creates file for weekly granularity", async () => {
    const date = new Date("2026-02-02T00:00:00Z"); // Monday
    const summary = createSummary("weekly", date, new Date(date.getTime() + 7 * 86400000));

    await storage.saveSummary(summary);

    const retrieved = await storage.getSummary("weekly", date);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("test summary");
  });

  test("saveSummary creates file for monthly granularity", async () => {
    const date = new Date("2026-02-01T00:00:00Z");
    const endDate = new Date("2026-03-01T00:00:00Z");
    const summary = createSummary("monthly", date, endDate);

    await storage.saveSummary(summary);

    const retrieved = await storage.getSummary("monthly", date);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("test summary");
  });

  test("getSummaries filters by date range for daily granularity", async () => {
    const base = new Date("2026-02-04T00:00:00Z");

    for (let i = 0; i < 5; i++) {
      const date = new Date(base);
      date.setDate(date.getDate() + i);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      await storage.saveSummary(createSummary("daily", date, endDate, `day ${i}`));
    }

    const results = await storage.getSummaries({
      granularity: "daily",
      from: new Date("2026-02-05T00:00:00Z"),
      to: new Date("2026-02-07T00:00:00Z"),
      limit: 10,
    });

    expect(results.length).toBe(3);
    expect(results.map((r) => r.content)).toContain("day 1");
    expect(results.map((r) => r.content)).toContain("day 2");
    expect(results.map((r) => r.content)).toContain("day 3");
  });

  test("getSummaries returns results sorted by period start descending", async () => {
    const base = new Date("2026-02-04T00:00:00Z");

    for (let i = 0; i < 3; i++) {
      const date = new Date(base);
      date.setDate(date.getDate() + i);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      await storage.saveSummary(createSummary("daily", date, endDate, `day ${i}`));
    }

    const results = await storage.getSummaries({
      granularity: "daily",
      from: base,
      to: new Date("2026-02-10T00:00:00Z"),
      limit: 10,
    });

    // Most recent first
    expect(results[0]?.content).toBe("day 2");
    expect(results[1]?.content).toBe("day 1");
    expect(results[2]?.content).toBe("day 0");
  });

  test("getSummaries respects limit", async () => {
    const base = new Date("2026-02-04T00:00:00Z");

    for (let i = 0; i < 10; i++) {
      const date = new Date(base);
      date.setDate(date.getDate() + i);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      await storage.saveSummary(createSummary("daily", date, endDate, `day ${i}`));
    }

    const results = await storage.getSummaries({
      granularity: "daily",
      from: base,
      to: new Date("2026-02-20T00:00:00Z"),
      limit: 3,
    });

    expect(results.length).toBe(3);
  });

  test("getLatest returns most recent summaries", async () => {
    const base = new Date("2026-02-04T00:00:00Z");

    for (let i = 0; i < 5; i++) {
      const date = new Date(base);
      date.setDate(date.getDate() + i);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      await storage.saveSummary(createSummary("daily", date, endDate, `day ${i}`));
    }

    const latest = await storage.getLatest("daily", 2);

    expect(latest.length).toBe(2);
    expect(latest[0]?.content).toBe("day 4"); // Most recent
    expect(latest[1]?.content).toBe("day 3");
  });

  test("getSummary returns null for non-existent summary", async () => {
    const result = await storage.getSummary("daily", new Date("2020-01-01T00:00:00Z"));
    expect(result).toBeNull();
  });

  test("getSummaries returns empty array for non-existent date range", async () => {
    const results = await storage.getSummaries({
      granularity: "daily",
      from: new Date("2020-01-01"),
      to: new Date("2020-01-02"),
      limit: 10,
    });

    expect(results).toEqual([]);
  });

  test("getLatest returns empty array when no summaries exist", async () => {
    const latest = await storage.getLatest("daily", 5);
    expect(latest).toEqual([]);
  });

  test("saveSummary overwrites existing summary", async () => {
    const date = new Date("2026-02-04T00:00:00Z");
    const endDate = new Date(date.getTime() + 86400000);

    const summary1 = createSummary("daily", date, endDate, "first version");
    const summary2 = createSummary("daily", date, endDate, "second version");

    await storage.saveSummary(summary1);
    await storage.saveSummary(summary2);

    const retrieved = await storage.getSummary("daily", date);
    expect(retrieved!.content).toBe("second version");
  });

  test("handles hourly granularity correctly", async () => {
    const base = new Date("2026-02-04T10:00:00Z");

    for (let hour = 10; hour < 15; hour++) {
      const date = new Date("2026-02-04T00:00:00Z");
      date.setHours(hour);
      const endDate = new Date(date.getTime() + 3600000);

      await storage.saveSummary(createSummary("hourly", date, endDate, `hour ${hour}`));
    }

    const results = await storage.getSummaries({
      granularity: "hourly",
      from: new Date("2026-02-04T11:00:00Z"),
      to: new Date("2026-02-04T13:59:59Z"),
      limit: 10,
    });

    expect(results.length).toBe(3);
    expect(results.map((r) => r.content)).toContain("hour 11");
    expect(results.map((r) => r.content)).toContain("hour 12");
    expect(results.map((r) => r.content)).toContain("hour 13");
  });

  test("handles weekly granularity correctly", async () => {
    // ISO week starts on Monday
    const week1 = new Date("2026-02-02T00:00:00Z"); // Week 6
    const week2 = new Date("2026-02-09T00:00:00Z"); // Week 7
    const week3 = new Date("2026-02-16T00:00:00Z"); // Week 8

    await storage.saveSummary(
      createSummary("weekly", week1, new Date(week1.getTime() + 7 * 86400000), "week 1")
    );
    await storage.saveSummary(
      createSummary("weekly", week2, new Date(week2.getTime() + 7 * 86400000), "week 2")
    );
    await storage.saveSummary(
      createSummary("weekly", week3, new Date(week3.getTime() + 7 * 86400000), "week 3")
    );

    const results = await storage.getSummaries({
      granularity: "weekly",
      from: new Date("2026-02-08T00:00:00Z"),
      to: new Date("2026-02-20T00:00:00Z"),
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.map((r) => r.content)).toContain("week 2");
    expect(results.map((r) => r.content)).toContain("week 3");
  });

  test("handles monthly granularity correctly", async () => {
    const jan = new Date("2026-01-01T00:00:00Z");
    const feb = new Date("2026-02-01T00:00:00Z");
    const mar = new Date("2026-03-01T00:00:00Z");

    await storage.saveSummary(
      createSummary("monthly", jan, new Date("2026-02-01T00:00:00Z"), "jan")
    );
    await storage.saveSummary(
      createSummary("monthly", feb, new Date("2026-03-01T00:00:00Z"), "feb")
    );
    await storage.saveSummary(
      createSummary("monthly", mar, new Date("2026-04-01T00:00:00Z"), "mar")
    );

    const results = await storage.getSummaries({
      granularity: "monthly",
      from: new Date("2026-01-15T00:00:00Z"),
      to: new Date("2026-03-15T00:00:00Z"),
      limit: 10,
    });

    expect(results.length).toBe(3);
    expect(results.map((r) => r.content)).toContain("jan");
    expect(results.map((r) => r.content)).toContain("feb");
    expect(results.map((r) => r.content)).toContain("mar");
  });

  test("concurrent saveSummary operations", async () => {
    const base = new Date("2026-02-04T00:00:00Z");

    const promises = Array.from({ length: 10 }, (_, i) => {
      const date = new Date(base);
      date.setDate(date.getDate() + i);
      const endDate = new Date(date.getTime() + 86400000);
      return storage.saveSummary(createSummary("daily", date, endDate, `day ${i}`));
    });

    await Promise.all(promises);

    const results = await storage.getSummaries({
      granularity: "daily",
      from: base,
      to: new Date("2026-02-20T00:00:00Z"),
      limit: 20,
    });

    expect(results.length).toBe(10);
  });
});
