import { Cron } from "croner";
import type { IChatStorage, ISummaryStorage, SummaryGranularity } from "../types/chat-history";
import { SummaryGenerator } from "./summary-generator";

export interface SummarySchedulerConfig {
  hourly: boolean;
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
  anthropicApiKey?: string;
}

const DEFAULT_CONFIG: SummarySchedulerConfig = {
  hourly: true,
  daily: true,
  weekly: false,
  monthly: false,
};

export class SummaryScheduler {
  private generator: SummaryGenerator;
  private jobs: Map<string, Cron> = new Map();
  private config: SummarySchedulerConfig;
  private chatStorage: IChatStorage;
  private summaryStorage: ISummaryStorage;

  constructor(
    chatStorage: IChatStorage,
    summaryStorage: ISummaryStorage,
    config: Partial<SummarySchedulerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.chatStorage = chatStorage;
    this.summaryStorage = summaryStorage;
    this.generator = new SummaryGenerator(chatStorage, summaryStorage, {
      anthropicApiKey: config.anthropicApiKey,
    });
  }

  start(): void {
    this.stop();

    if (this.config.hourly) {
      const job = new Cron("5 * * * *", async () => {
        await this.generateHourlySummary();
      });
      this.jobs.set("hourly", job);
      console.log("[SummaryScheduler] Hourly summary scheduled (5 min past each hour)");
    }

    if (this.config.daily) {
      const job = new Cron("15 0 * * *", async () => {
        await this.generateDailySummary();
      });
      this.jobs.set("daily", job);
      console.log("[SummaryScheduler] Daily summary scheduled (00:15)");
    }

    if (this.config.weekly) {
      const job = new Cron("30 0 * * 1", async () => {
        await this.generateWeeklySummary();
      });
      this.jobs.set("weekly", job);
      console.log("[SummaryScheduler] Weekly summary scheduled (Monday 00:30)");
    }

    if (this.config.monthly) {
      const job = new Cron("45 0 1 * *", async () => {
        await this.generateMonthlySummary();
      });
      this.jobs.set("monthly", job);
      console.log("[SummaryScheduler] Monthly summary scheduled (1st of month 00:45)");
    }

    console.log(`[SummaryScheduler] Started with ${this.jobs.size} schedules`);
  }

  stop(): void {
    for (const [name, job] of this.jobs) {
      job.stop();
      console.log(`[SummaryScheduler] Stopped ${name} job`);
    }
    this.jobs.clear();
  }

  private async isAlreadyGenerated(
    granularity: SummaryGranularity,
    date: Date
  ): Promise<boolean> {
    const existing = await this.summaryStorage.getSummary(granularity, date);
    return existing !== null;
  }

  async generateHourlySummary(date?: Date): Promise<void> {
    const targetDate = date || this.getPreviousHour();

    if (await this.isAlreadyGenerated("hourly", targetDate)) {
      console.log(`[SummaryScheduler] Hourly summary already exists for ${targetDate.toISOString()}`);
      return;
    }

    console.log(`[SummaryScheduler] Generating hourly summary for ${targetDate.toISOString()}`);

    try {
      const result = await this.generator.generateHourly(targetDate);

      if (result.success && result.summary) {
        console.log(`[SummaryScheduler] Hourly summary generated (${result.chatCount} chats)`);
      } else if (result.chatCount === 0) {
        console.log("[SummaryScheduler] No chats in period, skipping hourly summary");
      } else {
        console.error(`[SummaryScheduler] Hourly summary failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`[SummaryScheduler] Hourly summary error: ${e}`);
    }
  }

  async generateDailySummary(date?: Date): Promise<void> {
    const targetDate = date || this.getYesterday();

    if (await this.isAlreadyGenerated("daily", targetDate)) {
      console.log(`[SummaryScheduler] Daily summary already exists for ${targetDate.toISOString()}`);
      return;
    }

    console.log(`[SummaryScheduler] Generating daily summary for ${targetDate.toISOString()}`);

    try {
      const result = await this.generator.generateDaily(targetDate);

      if (result.success && result.summary) {
        console.log(`[SummaryScheduler] Daily summary generated (${result.chatCount} chats)`);
      } else if (result.chatCount === 0) {
        console.log("[SummaryScheduler] No chats in period, skipping daily summary");
      } else {
        console.error(`[SummaryScheduler] Daily summary failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`[SummaryScheduler] Daily summary error: ${e}`);
    }
  }

  async generateWeeklySummary(date?: Date): Promise<void> {
    const targetDate = date || this.getLastWeekStart();

    if (await this.isAlreadyGenerated("weekly", targetDate)) {
      console.log(`[SummaryScheduler] Weekly summary already exists`);
      return;
    }

    console.log(`[SummaryScheduler] Generating weekly summary`);

    try {
      const result = await this.generator.generateWeekly(targetDate);

      if (result.success && result.summary) {
        console.log(`[SummaryScheduler] Weekly summary generated (${result.chatCount} chats)`);
      } else if (result.chatCount === 0) {
        console.log("[SummaryScheduler] No chats in period, skipping weekly summary");
      } else {
        console.error(`[SummaryScheduler] Weekly summary failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`[SummaryScheduler] Weekly summary error: ${e}`);
    }
  }

  async generateMonthlySummary(date?: Date): Promise<void> {
    const targetDate = date || this.getLastMonthStart();

    if (await this.isAlreadyGenerated("monthly", targetDate)) {
      console.log(`[SummaryScheduler] Monthly summary already exists`);
      return;
    }

    console.log(`[SummaryScheduler] Generating monthly summary`);

    try {
      const result = await this.generator.generateMonthly(targetDate);

      if (result.success && result.summary) {
        console.log(`[SummaryScheduler] Monthly summary generated (${result.chatCount} chats)`);
      } else if (result.chatCount === 0) {
        console.log("[SummaryScheduler] No chats in period, skipping monthly summary");
      } else {
        console.error(`[SummaryScheduler] Monthly summary failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`[SummaryScheduler] Monthly summary error: ${e}`);
    }
  }

  private getPreviousHour(): Date {
    const now = new Date();
    now.setHours(now.getHours() - 1);
    now.setMinutes(0, 0, 0);
    return now;
  }

  private getYesterday(): Date {
    const now = new Date();
    now.setDate(now.getDate() - 1);
    now.setHours(0, 0, 0, 0);
    return now;
  }

  private getLastWeekStart(): Date {
    const now = new Date();
    now.setDate(now.getDate() - 7);
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    now.setDate(diff);
    now.setHours(0, 0, 0, 0);
    return now;
  }

  private getLastMonthStart(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() - 1, 1);
  }

  getStatus(): string {
    const lines: string[] = [`📊 <b>Summary Scheduler</b>`];

    if (this.jobs.size === 0) {
      lines.push("Not running");
      return lines.join("\n");
    }

    for (const [name, job] of this.jobs) {
      const next = job.nextRun();
      const nextStr = next
        ? next.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        : "never";
      lines.push(`• ${name}: next at ${nextStr}`);
    }

    return lines.join("\n");
  }
}

let schedulerInstance: SummaryScheduler | null = null;

export function initSummaryScheduler(
  chatStorage: IChatStorage,
  summaryStorage: ISummaryStorage,
  config?: Partial<SummarySchedulerConfig>
): SummaryScheduler {
  if (schedulerInstance) {
    schedulerInstance.stop();
  }
  schedulerInstance = new SummaryScheduler(chatStorage, summaryStorage, config);
  return schedulerInstance;
}

export function getSummaryScheduler(): SummaryScheduler | null {
  return schedulerInstance;
}

export function startSummaryScheduler(): void {
  schedulerInstance?.start();
}

export function stopSummaryScheduler(): void {
  schedulerInstance?.stop();
}
