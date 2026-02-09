/**
 * Retention and cleanup service for chat history and summaries
 *
 * Manages data retention policies and safely removes old files.
 */

import { readdir, stat, unlink } from "fs/promises";
import { join, resolve } from "path";
import { existsSync } from "fs";

export interface RetentionConfig {
  /** Days to keep chat files (default: 90) */
  chatRetentionDays: number;

  /** Days to keep hourly summaries (default: 7) */
  hourlySummaryRetentionDays: number;

  /** Days to keep daily summaries (default: 30) */
  dailySummaryRetentionDays: number;

  /** Days to keep weekly summaries (default: 365) */
  weeklySummaryRetentionDays: number;

  /** Days to keep monthly summaries (default: -1, never delete) */
  monthlySummaryRetentionDays: number;

  /** Maximum number of chat files to keep (optional, default: -1 = no limit) */
  maxChatFiles: number;

  /** Maximum number of hourly summaries to keep (optional, default: -1 = no limit) */
  maxHourlySummaries: number;
}

export interface CleanupResult {
  chatFilesDeleted: number;
  summaryFilesDeleted: {
    hourly: number;
    daily: number;
    weekly: number;
    monthly: number;
  };
  bytesFreed: number;
  errors: Array<{ path: string; error: string }>;
}

const DEFAULT_CONFIG: RetentionConfig = {
  chatRetentionDays: 90,
  hourlySummaryRetentionDays: 7,
  dailySummaryRetentionDays: 30,
  weeklySummaryRetentionDays: 365,
  monthlySummaryRetentionDays: -1, // Never delete
  maxChatFiles: -1,
  maxHourlySummaries: -1,
};

export function parseRetentionConfig(): RetentionConfig {
  return {
    chatRetentionDays:
      parseInt(process.env.RETENTION_CHAT_DAYS || "", 10) ||
      DEFAULT_CONFIG.chatRetentionDays,
    hourlySummaryRetentionDays:
      parseInt(process.env.RETENTION_HOURLY_DAYS || "", 10) ||
      DEFAULT_CONFIG.hourlySummaryRetentionDays,
    dailySummaryRetentionDays:
      parseInt(process.env.RETENTION_DAILY_DAYS || "", 10) ||
      DEFAULT_CONFIG.dailySummaryRetentionDays,
    weeklySummaryRetentionDays:
      parseInt(process.env.RETENTION_WEEKLY_DAYS || "", 10) ||
      DEFAULT_CONFIG.weeklySummaryRetentionDays,
    monthlySummaryRetentionDays:
      parseInt(process.env.RETENTION_MONTHLY_DAYS || "", 10) ||
      DEFAULT_CONFIG.monthlySummaryRetentionDays,
    maxChatFiles:
      parseInt(process.env.RETENTION_MAX_CHAT_FILES || "", 10) ||
      DEFAULT_CONFIG.maxChatFiles,
    maxHourlySummaries:
      parseInt(process.env.RETENTION_MAX_HOURLY || "", 10) ||
      DEFAULT_CONFIG.maxHourlySummaries,
  };
}

export class RetentionCleanupService {
  private dataDir: string;
  private config: RetentionConfig;

  constructor(dataDir = "data", config: Partial<RetentionConfig> = {}) {
    this.dataDir = resolve(dataDir);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async runCleanup(dryRun = false): Promise<CleanupResult> {
    const result: CleanupResult = {
      chatFilesDeleted: 0,
      summaryFilesDeleted: {
        hourly: 0,
        daily: 0,
        weekly: 0,
        monthly: 0,
      },
      bytesFreed: 0,
      errors: [],
    };

    // Clean chat files
    const chatResult = await this.cleanupDirectory(
      join(this.dataDir, "chats"),
      this.config.chatRetentionDays,
      this.config.maxChatFiles,
      /^\d{4}-\d{2}-\d{2}\.ndjson$/,
      dryRun
    );
    result.chatFilesDeleted = chatResult.deleted;
    result.bytesFreed += chatResult.bytesFreed;
    result.errors.push(...chatResult.errors);

    // Clean hourly summaries
    const hourlyResult = await this.cleanupDirectory(
      join(this.dataDir, "summaries", "hourly"),
      this.config.hourlySummaryRetentionDays,
      this.config.maxHourlySummaries,
      /^\d{4}-\d{2}-\d{2}-\d{2}\.json$/,
      dryRun
    );
    result.summaryFilesDeleted.hourly = hourlyResult.deleted;
    result.bytesFreed += hourlyResult.bytesFreed;
    result.errors.push(...hourlyResult.errors);

    // Clean daily summaries
    const dailyResult = await this.cleanupDirectory(
      join(this.dataDir, "summaries", "daily"),
      this.config.dailySummaryRetentionDays,
      -1,
      /^\d{4}-\d{2}-\d{2}\.json$/,
      dryRun
    );
    result.summaryFilesDeleted.daily = dailyResult.deleted;
    result.bytesFreed += dailyResult.bytesFreed;
    result.errors.push(...dailyResult.errors);

    // Clean weekly summaries
    const weeklyResult = await this.cleanupDirectory(
      join(this.dataDir, "summaries", "weekly"),
      this.config.weeklySummaryRetentionDays,
      -1,
      /^\d{4}-W\d{2}\.json$/,
      dryRun
    );
    result.summaryFilesDeleted.weekly = weeklyResult.deleted;
    result.bytesFreed += weeklyResult.bytesFreed;
    result.errors.push(...weeklyResult.errors);

    // Clean monthly summaries (only if retention > 0)
    if (this.config.monthlySummaryRetentionDays > 0) {
      const monthlyResult = await this.cleanupDirectory(
        join(this.dataDir, "summaries", "monthly"),
        this.config.monthlySummaryRetentionDays,
        -1,
        /^\d{4}-\d{2}\.json$/,
        dryRun
      );
      result.summaryFilesDeleted.monthly = monthlyResult.deleted;
      result.bytesFreed += monthlyResult.bytesFreed;
      result.errors.push(...monthlyResult.errors);
    }

    const mode = dryRun ? "DRY-RUN" : "CLEANUP";
    const totalDeleted =
      result.chatFilesDeleted +
      result.summaryFilesDeleted.hourly +
      result.summaryFilesDeleted.daily +
      result.summaryFilesDeleted.weekly +
      result.summaryFilesDeleted.monthly;

    console.log(
      `[RetentionCleanup] ${mode} complete: ${totalDeleted} files, ${this.formatBytes(result.bytesFreed)} freed`
    );

    return result;
  }

  private async cleanupDirectory(
    dir: string,
    retentionDays: number,
    maxFiles: number,
    pattern: RegExp,
    dryRun: boolean
  ): Promise<{
    deleted: number;
    bytesFreed: number;
    errors: Array<{ path: string; error: string }>;
  }> {
    const result = {
      deleted: 0,
      bytesFreed: 0,
      errors: [] as Array<{ path: string; error: string }>,
    };

    if (!existsSync(dir)) {
      return result;
    }

    const now = new Date();
    const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

    try {
      const files = await readdir(dir);
      const matchingFiles = files.filter((f) => pattern.test(f)).sort();

      // Track files to delete
      const toDelete: string[] = [];

      // First pass: by age
      if (retentionDays > 0) {
        for (const file of matchingFiles) {
          const filePath = join(dir, file);
          try {
            const stats = await stat(filePath);
            if (stats.mtime < cutoffDate) {
              toDelete.push(file);
            }
          } catch (e) {
            result.errors.push({
              path: filePath,
              error: `Failed to stat: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        }
      }

      // Second pass: by count (keep newest, delete oldest)
      if (maxFiles > 0) {
        const remaining = matchingFiles.filter((f) => !toDelete.includes(f));
        if (remaining.length > maxFiles) {
          // Sort oldest first (filenames are date-based so lexical sort works)
          const toDeleteByCount = remaining.slice(0, remaining.length - maxFiles);
          for (const file of toDeleteByCount) {
            if (!toDelete.includes(file)) {
              toDelete.push(file);
            }
          }
        }
      }

      // Delete files
      for (const file of toDelete) {
        const filePath = join(dir, file);
        try {
          const stats = await stat(filePath);

          if (dryRun) {
            console.log(
              `[RetentionCleanup] DRY-RUN: Would delete ${filePath} (${this.formatBytes(stats.size)})`
            );
          } else {
            await unlink(filePath);
            console.log(
              `[RetentionCleanup] Deleted ${filePath} (${this.formatBytes(stats.size)})`
            );
          }

          result.deleted++;
          result.bytesFreed += stats.size;
        } catch (e) {
          result.errors.push({
            path: filePath,
            error: `Failed to delete: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    } catch (e) {
      result.errors.push({
        path: dir,
        error: `Failed to read directory: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    return result;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  getConfig(): RetentionConfig {
    return { ...this.config };
  }

  getStatus(): string {
    const lines = ["📦 <b>Retention Policy</b>"];
    lines.push(`• Chats: ${this.config.chatRetentionDays} days`);
    lines.push(`• Hourly: ${this.config.hourlySummaryRetentionDays} days`);
    lines.push(`• Daily: ${this.config.dailySummaryRetentionDays} days`);
    lines.push(`• Weekly: ${this.config.weeklySummaryRetentionDays} days`);
    lines.push(
      `• Monthly: ${this.config.monthlySummaryRetentionDays === -1 ? "forever" : `${this.config.monthlySummaryRetentionDays} days`}`
    );

    if (this.config.maxChatFiles > 0) {
      lines.push(`• Max chat files: ${this.config.maxChatFiles}`);
    }
    if (this.config.maxHourlySummaries > 0) {
      lines.push(`• Max hourly summaries: ${this.config.maxHourlySummaries}`);
    }

    return lines.join("\n");
  }
}

let serviceInstance: RetentionCleanupService | null = null;

export function initRetentionCleanup(
  dataDir = "data",
  config?: Partial<RetentionConfig>
): RetentionCleanupService {
  const finalConfig = config || parseRetentionConfig();
  serviceInstance = new RetentionCleanupService(dataDir, finalConfig);
  return serviceInstance;
}

export function getRetentionCleanup(): RetentionCleanupService | null {
  return serviceInstance;
}
