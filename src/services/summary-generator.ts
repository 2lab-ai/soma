import { randomUUID } from "crypto";
import { writeFile, mkdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import type {
  Summary,
  SummaryGranularity,
  IChatStorage,
  ISummaryStorage,
} from "../types/chat-history";

const SUMMARIES_DIR = "data/summaries";

export interface GenerateSummaryResult {
  success: boolean;
  summary?: Summary;
  error?: string;
  chatCount: number;
}

/**
 * SummaryGenerator - Creates and saves conversation summaries
 *
 * Note: Actual summary generation is done by Claude via cron job.
 * This class handles saving/loading summaries and provides helper methods.
 */
export class SummaryGenerator {
  constructor(
    private chatStorage: IChatStorage,
    private summaryStorage: ISummaryStorage
  ) {}

  /**
   * Save a summary to storage
   */
  async saveSummary(
    content: string,
    granularity: SummaryGranularity,
    periodStart: Date,
    periodEnd: Date,
    chatCount: number
  ): Promise<Summary> {
    const summary: Summary = {
      id: randomUUID(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      granularity,
      model: "claude-session",
      content,
      chatCount,
    };

    await this.summaryStorage.saveSummary(summary);
    return summary;
  }

  /**
   * Save summary as markdown file (for cron job)
   */
  async saveMarkdownSummary(date: Date, content: string): Promise<string> {
    const dateStr = date.toISOString().split("T")[0];
    const filePath = join(SUMMARIES_DIR, `${dateStr}.md`);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");

    return filePath;
  }

  /**
   * Get summary markdown file path for a date
   */
  getSummaryPath(date: Date): string {
    const dateStr = date.toISOString().split("T")[0];
    return join(SUMMARIES_DIR, `${dateStr}.md`);
  }

  /**
   * Check if summary exists for a date
   */
  hasSummary(date: Date): boolean {
    return existsSync(this.getSummaryPath(date));
  }

  /**
   * Read summary for a date
   */
  async readSummary(date: Date): Promise<string | null> {
    const path = this.getSummaryPath(date);
    if (!existsSync(path)) return null;
    return await readFile(path, "utf-8");
  }

  /**
   * Get chat count for a date range (for summary metadata)
   */
  async getChatCount(from: Date, to: Date): Promise<number> {
    const chats = await this.chatStorage.search({ from, to, limit: 10000 });
    return chats.length;
  }
}
