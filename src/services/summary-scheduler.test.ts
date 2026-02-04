import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { SummaryScheduler, type SummarySchedulerConfig } from "./summary-scheduler";
import type { IChatStorage, ISummaryStorage, Summary, ChatRecord, SummaryGranularity } from "../types/chat-history";

const createMockChatStorage = (): IChatStorage => ({
  save: mock(() => Promise.resolve()),
  search: mock(() => Promise.resolve([])),
  getById: mock(() => Promise.resolve(null)),
  delete: mock(() => Promise.resolve(true)),
});

const createMockSummaryStorage = (): ISummaryStorage => ({
  saveSummary: mock(() => Promise.resolve()),
  getSummary: mock(() => Promise.resolve(null)),
  listSummaries: mock(() => Promise.resolve([])),
  deleteSummary: mock(() => Promise.resolve(true)),
});

describe("SummaryScheduler", () => {
  let chatStorage: IChatStorage;
  let summaryStorage: ISummaryStorage;

  beforeEach(() => {
    chatStorage = createMockChatStorage();
    summaryStorage = createMockSummaryStorage();
  });

  describe("constructor", () => {
    it("should create scheduler with default config", () => {
      const scheduler = new SummaryScheduler(chatStorage, summaryStorage);
      expect(scheduler).toBeDefined();
    });

    it("should merge custom config with defaults", () => {
      const config: Partial<SummarySchedulerConfig> = {
        hourly: false,
        weekly: true,
      };
      const scheduler = new SummaryScheduler(chatStorage, summaryStorage, config);
      expect(scheduler).toBeDefined();
    });
  });

  describe("start/stop", () => {
    it("should start and stop without errors", () => {
      const scheduler = new SummaryScheduler(chatStorage, summaryStorage);
      scheduler.start();
      scheduler.stop();
    });

    it("should stop existing jobs before starting new ones", () => {
      const scheduler = new SummaryScheduler(chatStorage, summaryStorage);
      scheduler.start();
      scheduler.start(); // Should stop first, then start
      scheduler.stop();
    });
  });

  describe("generateHourlySummary", () => {
    it("should skip if summary already exists", async () => {
      const existingSummary: Summary = {
        id: "test-id",
        periodStart: new Date().toISOString(),
        periodEnd: new Date().toISOString(),
        granularity: "hourly",
        model: "test",
        content: "existing",
        chatCount: 5,
      };

      (summaryStorage.getSummary as ReturnType<typeof mock>).mockResolvedValue(existingSummary);

      const scheduler = new SummaryScheduler(chatStorage, summaryStorage);
      await scheduler.generateHourlySummary();

      // Should not call search if summary exists
      expect(chatStorage.search).not.toHaveBeenCalled();
    });

    it("should skip if no chats in period", async () => {
      (summaryStorage.getSummary as ReturnType<typeof mock>).mockResolvedValue(null);
      (chatStorage.search as ReturnType<typeof mock>).mockResolvedValue([]);

      const scheduler = new SummaryScheduler(chatStorage, summaryStorage);
      await scheduler.generateHourlySummary();

      // Should not save summary if no chats
      expect(summaryStorage.saveSummary).not.toHaveBeenCalled();
    });

    it("should use provided date for target period", async () => {
      (summaryStorage.getSummary as ReturnType<typeof mock>).mockResolvedValue(null);
      (chatStorage.search as ReturnType<typeof mock>).mockResolvedValue([]);

      const scheduler = new SummaryScheduler(chatStorage, summaryStorage);
      const targetDate = new Date("2025-01-15T14:30:00");
      await scheduler.generateHourlySummary(targetDate);

      expect(chatStorage.search).toHaveBeenCalled();
    });
  });

  describe("generateDailySummary", () => {
    it("should skip if summary already exists", async () => {
      const existingSummary: Summary = {
        id: "test-id",
        periodStart: new Date().toISOString(),
        periodEnd: new Date().toISOString(),
        granularity: "daily",
        model: "test",
        content: "existing",
        chatCount: 10,
      };

      (summaryStorage.getSummary as ReturnType<typeof mock>).mockResolvedValue(existingSummary);

      const scheduler = new SummaryScheduler(chatStorage, summaryStorage);
      await scheduler.generateDailySummary();

      expect(chatStorage.search).not.toHaveBeenCalled();
    });
  });

  describe("generateWeeklySummary", () => {
    it("should skip if summary already exists", async () => {
      const existingSummary: Summary = {
        id: "test-id",
        periodStart: new Date().toISOString(),
        periodEnd: new Date().toISOString(),
        granularity: "weekly",
        model: "test",
        content: "existing",
        chatCount: 50,
      };

      (summaryStorage.getSummary as ReturnType<typeof mock>).mockResolvedValue(existingSummary);

      const scheduler = new SummaryScheduler(chatStorage, summaryStorage);
      await scheduler.generateWeeklySummary();

      expect(chatStorage.search).not.toHaveBeenCalled();
    });
  });

  describe("generateMonthlySummary", () => {
    it("should skip if summary already exists", async () => {
      const existingSummary: Summary = {
        id: "test-id",
        periodStart: new Date().toISOString(),
        periodEnd: new Date().toISOString(),
        granularity: "monthly",
        model: "test",
        content: "existing",
        chatCount: 200,
      };

      (summaryStorage.getSummary as ReturnType<typeof mock>).mockResolvedValue(existingSummary);

      const scheduler = new SummaryScheduler(chatStorage, summaryStorage);
      await scheduler.generateMonthlySummary();

      expect(chatStorage.search).not.toHaveBeenCalled();
    });
  });

  describe("getStatus", () => {
    it("should return 'Not running' when no jobs scheduled", () => {
      const scheduler = new SummaryScheduler(chatStorage, summaryStorage);
      const status = scheduler.getStatus();
      expect(status).toContain("Not running");
    });

    it("should return job schedules when running", () => {
      const scheduler = new SummaryScheduler(chatStorage, summaryStorage, {
        hourly: true,
        daily: true,
        weekly: false,
        monthly: false,
      });
      scheduler.start();

      const status = scheduler.getStatus();
      expect(status).toContain("hourly");
      expect(status).toContain("daily");

      scheduler.stop();
    });
  });
});
