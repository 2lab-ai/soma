/**
 * File-based chat storage using daily NDJSON files
 *
 * Format: data/chats/{tenant}/{channel}/{thread}/YYYY-MM-DD.ndjson
 * Each line is a JSON-serialized ChatRecord
 */

import { appendFile, mkdir, readdir, readFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { existsSync } from "fs";
import type {
  ChatRecord,
  SessionReference,
  IChatStorage,
  ChatSearchOptions,
} from "../types/chat-history";
import { buildStoragePartitionKey, parseSessionKey } from "../routing/session-key";

const FALLBACK_PARTITION_KEY = "default/unknown/main";
const DATE_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})\.ndjson$/;

export class FileChatStorage implements IChatStorage {
  private dataDir: string;
  private sessionRefsPath: string;

  constructor(dataDir = "data") {
    this.dataDir = resolve(dataDir, "chats");
    this.sessionRefsPath = resolve(dataDir, "sessions.ndjson");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(resolve(this.dataDir, ".."), { recursive: true });
  }

  private getPartitionDir(partitionKey: string): string {
    return join(this.dataDir, ...partitionKey.split("/"));
  }

  private resolvePartitionKey(sessionId: string): string {
    try {
      return buildStoragePartitionKey(parseSessionKey(sessionId)) as string;
    } catch {
      return FALLBACK_PARTITION_KEY;
    }
  }

  private tryResolvePartitionKey(sessionId: string): string | null {
    try {
      return buildStoragePartitionKey(parseSessionKey(sessionId)) as string;
    } catch {
      return null;
    }
  }

  private getFilePath(partitionKey: string, date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return join(this.getPartitionDir(partitionKey), `${year}-${month}-${day}.ndjson`);
  }

  async saveChat(record: ChatRecord): Promise<void> {
    await this.saveBatch([record]);
  }

  async saveBatch(records: ChatRecord[]): Promise<void> {
    if (records.length === 0) return;

    await this.init();

    // Group by partition/date
    const byDate = new Map<string, ChatRecord[]>();

    for (const record of records) {
      const partitionKey = this.resolvePartitionKey(record.sessionId);
      const date = new Date(record.timestamp);
      const filePath = this.getFilePath(partitionKey, date);

      if (!byDate.has(filePath)) {
        byDate.set(filePath, []);
      }
      byDate.get(filePath)!.push(record);
    }

    // Atomic append to each file
    for (const [filePath, fileRecords] of byDate.entries()) {
      await mkdir(dirname(filePath), { recursive: true });
      const lines = fileRecords.map((r) => JSON.stringify(r)).join("\n") + "\n";
      await appendFile(filePath, lines, "utf-8");
    }
  }

  async search(options: ChatSearchOptions): Promise<ChatRecord[]> {
    const {
      from,
      to,
      query,
      sessionId,
      speaker,
      storagePartitionKey,
      limit = 100,
      offset = 0,
    } = options;

    await this.init();

    const records: ChatRecord[] = [];
    const partitionKey =
      storagePartitionKey ?? (sessionId ? this.tryResolvePartitionKey(sessionId) : null);
    const files = await this.getFilesInRange(from, to, partitionKey);

    for (const filePath of files) {
      if (!existsSync(filePath)) continue;

      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        try {
          const record: ChatRecord = JSON.parse(line);

          // Apply timestamp filter
          const recordDate = new Date(record.timestamp);
          if (recordDate < from || recordDate > to) continue;

          // Apply other filters
          if (sessionId && record.sessionId !== sessionId) continue;
          if (speaker && record.speaker !== speaker) continue;
          if (query && !record.content.toLowerCase().includes(query.toLowerCase()))
            continue;

          records.push(record);
        } catch (e) {
          console.warn(`[ChatStorage] Failed to parse record in ${filePath}:`, e);
        }
      }
    }

    // Sort by timestamp descending (most recent first)
    records.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Apply pagination
    return records.slice(offset, offset + limit);
  }

  async getContextAround(
    timestamp: Date,
    before: number,
    after: number
  ): Promise<ChatRecord[]> {
    const windowStart = new Date(timestamp.getTime() - before * 60000);
    const windowEnd = new Date(timestamp.getTime() + after * 60000);

    const records = await this.search({
      from: windowStart,
      to: windowEnd,
      limit: 1000,
    });

    // Sort chronologically
    return records.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  async saveSessionReference(ref: SessionReference): Promise<void> {
    await this.init();
    const line = JSON.stringify(ref) + "\n";
    await appendFile(this.sessionRefsPath, line, "utf-8");
  }

  async getSessionReference(sessionId: string): Promise<SessionReference | null> {
    if (!existsSync(this.sessionRefsPath)) {
      return null;
    }

    const content = await readFile(this.sessionRefsPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    // Return most recent match (last in file)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;

      try {
        const ref: SessionReference = JSON.parse(line);
        if (ref.sessionId === sessionId) {
          return ref;
        }
      } catch (e) {
        console.warn(`[ChatStorage] Failed to parse session ref:`, e);
      }
    }

    return null;
  }

  private async listNdjsonFilesRecursive(dir: string): Promise<string[]> {
    if (!existsSync(dir)) {
      return [];
    }

    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.listNdjsonFilesRecursive(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith(".ndjson")) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private isDateFileInRange(filePath: string, from: Date, to: Date): boolean {
    const filename = basename(filePath);
    const match = filename.match(DATE_FILE_PATTERN);
    if (!match) return false;

    const year = match[1];
    const month = match[2];
    const day = match[3];
    if (!year || !month || !day) return false;

    const fileDate = new Date(Number(year), Number(month) - 1, Number(day));
    return fileDate >= from && fileDate <= to;
  }

  private async getFilesInRange(
    from: Date,
    to: Date,
    partitionKey?: string | null
  ): Promise<string[]> {
    if (!existsSync(this.dataDir)) {
      return [];
    }

    const roots = partitionKey ? [this.getPartitionDir(partitionKey)] : [this.dataDir];

    // Normalize dates to day boundaries
    const fromDay = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const toDay = new Date(to.getFullYear(), to.getMonth(), to.getDate());

    const files: string[] = [];
    for (const root of roots) {
      const ndjsonFiles = await this.listNdjsonFilesRecursive(root);
      for (const filePath of ndjsonFiles) {
        if (this.isDateFileInRange(filePath, fromDay, toDay)) {
          files.push(filePath);
        }
      }
    }

    return Array.from(new Set(files));
  }
}
