/**
 * File-based summary storage organized by granularity
 *
 * Format:
 *   data/summaries/hourly/YYYY-MM-DD-HH.json
 *   data/summaries/daily/YYYY-MM-DD.json
 *   data/summaries/weekly/YYYY-Www.json (ISO week)
 *   data/summaries/monthly/YYYY-MM.json
 *
 * Each file contains a single Summary object
 */

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join, resolve } from "path";
import { existsSync } from "fs";
import type {
  Summary,
  ISummaryStorage,
  SummarySearchOptions,
  SummaryGranularity,
} from "../types/chat-history";

export class FileSummaryStorage implements ISummaryStorage {
  private dataDir: string;

  constructor(dataDir = "data") {
    this.dataDir = resolve(dataDir, "summaries");
  }

  async init(): Promise<void> {
    await mkdir(join(this.dataDir, "hourly"), { recursive: true });
    await mkdir(join(this.dataDir, "daily"), { recursive: true });
    await mkdir(join(this.dataDir, "weekly"), { recursive: true });
    await mkdir(join(this.dataDir, "monthly"), { recursive: true });
  }

  private getFilePath(granularity: SummaryGranularity, date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");

    let filename: string;

    switch (granularity) {
      case "hourly":
        filename = `${year}-${month}-${day}-${hour}.json`;
        break;
      case "daily":
        filename = `${year}-${month}-${day}.json`;
        break;
      case "weekly":
        filename = `${year}-W${this.getISOWeek(date)}.json`;
        break;
      case "monthly":
        filename = `${year}-${month}.json`;
        break;
    }

    return join(this.dataDir, granularity, filename);
  }

  private getISOWeek(date: Date): string {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return String(weekNo).padStart(2, "0");
  }

  async saveSummary(summary: Summary): Promise<void> {
    await this.init();

    const date = new Date(summary.periodStart);
    const filePath = this.getFilePath(summary.granularity, date);

    const data = JSON.stringify(summary, null, 2);
    await writeFile(filePath, data, "utf-8");
  }

  async getSummaries(options: SummarySearchOptions): Promise<Summary[]> {
    const { granularity, from, to, limit = 100 } = options;

    await this.init();

    const files = await this.getFilesInRange(granularity, from, to);
    const summaries: Summary[] = [];

    for (const file of files) {
      try {
        const content = await readFile(file, "utf-8");
        const summary: Summary = JSON.parse(content);

        const summaryStart = new Date(summary.periodStart);
        const summaryEnd = new Date(summary.periodEnd);

        // Check if summary period overlaps with query range [from, to] inclusive
        // Include summary if: summaryStart <= to AND summaryEnd > from
        // This excludes summaries that only touch the boundary
        if (summaryStart > to || summaryEnd <= from) continue;

        summaries.push(summary);
      } catch (e) {
        console.warn(`[SummaryStorage] Failed to parse summary in ${file}:`, e);
      }
    }

    // Sort by period start descending
    summaries.sort(
      (a, b) => new Date(b.periodStart).getTime() - new Date(a.periodStart).getTime()
    );

    return summaries.slice(0, limit);
  }

  async getLatest(granularity: SummaryGranularity, count: number): Promise<Summary[]> {
    await this.init();

    const dir = join(this.dataDir, granularity);
    if (!existsSync(dir)) {
      return [];
    }

    const files = await readdir(dir);
    const jsonFiles = files
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse() // Most recent first
      .slice(0, count);

    const summaries: Summary[] = [];

    for (const file of jsonFiles) {
      try {
        const content = await readFile(join(dir, file), "utf-8");
        summaries.push(JSON.parse(content));
      } catch (e) {
        console.warn(`[SummaryStorage] Failed to parse ${file}:`, e);
      }
    }

    return summaries;
  }

  async getSummary(
    granularity: SummaryGranularity,
    date: Date
  ): Promise<Summary | null> {
    await this.init();

    const filePath = this.getFilePath(granularity, date);

    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content);
    } catch (e) {
      console.warn(`[SummaryStorage] Failed to read summary at ${filePath}:`, e);
      return null;
    }
  }

  private async getFilesInRange(
    granularity: SummaryGranularity,
    from: Date,
    to: Date
  ): Promise<string[]> {
    const dir = join(this.dataDir, granularity);

    if (!existsSync(dir)) {
      return [];
    }

    const allFiles = await readdir(dir);
    const jsonFiles = allFiles.filter((f) => f.endsWith(".json"));

    return jsonFiles
      .filter((file) => {
        const date = this.parseDateFromFilename(granularity, file);
        if (!date) return false;

        // For range queries, be generous - include any file that might overlap
        const fileStart = date;
        const fileEnd = this.getEndDate(granularity, date);

        return fileEnd >= from && fileStart <= to;
      })
      .map((file) => join(dir, file));
  }

  private parseDateFromFilename(
    granularity: SummaryGranularity,
    filename: string
  ): Date | null {
    try {
      switch (granularity) {
        case "hourly": {
          const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.json$/);
          if (!match) return null;
          const [, year, month, day, hour] = match;
          return new Date(Number(year), Number(month) - 1, Number(day), Number(hour));
        }
        case "daily": {
          const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})\.json$/);
          if (!match) return null;
          const [, year, month, day] = match;
          return new Date(Number(year), Number(month) - 1, Number(day));
        }
        case "weekly": {
          const match = filename.match(/^(\d{4})-W(\d{2})\.json$/);
          if (!match) return null;
          const [, year, week] = match;
          // Approximate: first day of that ISO week
          const jan4 = new Date(Number(year), 0, 4);
          const firstMonday = new Date(jan4);
          firstMonday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
          firstMonday.setDate(firstMonday.getDate() + (Number(week) - 1) * 7);
          return firstMonday;
        }
        case "monthly": {
          const match = filename.match(/^(\d{4})-(\d{2})\.json$/);
          if (!match) return null;
          const [, year, month] = match;
          return new Date(Number(year), Number(month) - 1, 1);
        }
      }
    } catch {
      return null;
    }
  }

  private getEndDate(granularity: SummaryGranularity, date: Date): Date {
    const end = new Date(date);

    switch (granularity) {
      case "hourly":
        end.setHours(end.getHours() + 1);
        break;
      case "daily":
        end.setDate(end.getDate() + 1);
        break;
      case "weekly":
        end.setDate(end.getDate() + 7);
        break;
      case "monthly":
        end.setMonth(end.getMonth() + 1);
        break;
    }

    return end;
  }
}
