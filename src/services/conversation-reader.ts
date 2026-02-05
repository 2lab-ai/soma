/**
 * Conversation Reader Service
 *
 * Reads p9 conversation history markdown files for memory extraction.
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, resolve, relative } from "path";

const DEFAULT_HISTORY_DIR = "/home/zhugehyuk/2lab.ai/soul/p9/USER/history";

export interface SessionInfo {
  date: Date;
  timeRange?: string;
  topics: string[];
}

export interface ConversationInsight {
  title: string;
  content: string;
  quotes?: string[];
}

export interface Artifact {
  type: "zettel" | "system" | "other";
  path?: string;
  description: string;
}

export interface ConversationEntry {
  id: string;
  type: "daily" | "monthly";
  date: Date;
  endDate?: Date;
  rawContent: string;
  sections: Map<string, string>;
  insights: ConversationInsight[];
  artifacts: Artifact[];
  quotes: string[];
}

export interface DateRange {
  start: Date;
  end: Date;
}

export interface ReaderOptions {
  dateRange?: DateRange;
  lastNDays?: number;
  includeMonthly?: boolean;
}

export interface GetEntriesResult {
  entries: ConversationEntry[];
  warnings: string[];
  errors: Array<{ path: string; error: string }>;
}

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  warnings: string[];
}

interface FileMetadata {
  path: string;
  type: "daily" | "monthly";
  date: Date;
  endDate?: Date;
  size: number;
  mtime: number;
}

type FilenameParseResult = {
  type: "daily" | "monthly";
  date: Date;
  endDate?: Date;
};

function parseFilename(filename: string): FilenameParseResult | null {
  const dailyMatch = filename.match(/^(\d{4})-(\d{2})-(\d{2})\.md$/);
  if (dailyMatch) {
    const [, year, month, day] = dailyMatch;
    if (!year || !month || !day) return null;
    return {
      type: "daily",
      date: new Date(+year, +month - 1, +day),
    };
  }

  const monthlyMatch = filename.match(/^(\d{4})-(\d{2})\.md$/);
  if (monthlyMatch) {
    const [, year, month] = monthlyMatch;
    if (!year || !month) return null;
    return {
      type: "monthly",
      date: new Date(+year, +month - 1, 1),
      endDate: new Date(+year, +month, 0),
    };
  }

  return null;
}

function extractSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split("\n");
  let currentHeader = "";
  let currentContent: string[] = [];

  function saveCurrentSection(): void {
    if (currentHeader) {
      sections.set(currentHeader, currentContent.join("\n").trim());
    }
  }

  for (const line of lines) {
    const headerMatch = line.match(/^##(?:#)? (.+)$/);

    if (headerMatch) {
      saveCurrentSection();
      const headerText = headerMatch[1];
      if (!headerText) continue;
      currentHeader = headerText;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  saveCurrentSection();
  return sections;
}

function extractQuotes(content: string): string[] {
  const quotes: string[] = [];

  for (const line of content.split("\n")) {
    const match = line.match(/^>\s*"?(.+?)"?\s*$/);
    if (match?.[1]) quotes.push(match[1]);
  }

  const inlineMatches = content.matchAll(/"([^"]{20,})"/g);
  for (const match of inlineMatches) {
    if (match[1]) quotes.push(match[1]);
  }

  return quotes;
}

function extractArtifacts(content: string): Artifact[] {
  const artifacts: Artifact[] = [];
  const zettelMatches = content.matchAll(/ZETTEL\/([^`\s]+)/g);

  for (const match of zettelMatches) {
    artifacts.push({
      type: "zettel",
      path: match[0],
      description: match[0],
    });
  }

  return artifacts;
}

export class ConversationReader {
  private metadataCache: Map<string, FileMetadata> = new Map();

  constructor(private historyDir: string = DEFAULT_HISTORY_DIR) {}

  async scanMetadata(): Promise<{ metadata: FileMetadata[]; errors: string[] }> {
    const errors: string[] = [];
    let files: string[];

    try {
      files = await readdir(this.historyDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          metadata: [],
          errors: [`History directory not found: ${this.historyDir}`],
        };
      }
      if (code === "EACCES") {
        return { metadata: [], errors: [`Permission denied: ${this.historyDir}`] };
      }
      return { metadata: [], errors: [`Failed to read directory: ${String(e)}`] };
    }

    const metadata: FileMetadata[] = [];

    for (const file of files) {
      const parsed = parseFilename(file);
      if (!parsed) continue;

      const fullPath = join(this.historyDir, file);

      try {
        const fileStat = await stat(fullPath);
        const meta: FileMetadata = {
          path: fullPath,
          ...parsed,
          size: fileStat.size,
          mtime: fileStat.mtimeMs,
        };
        metadata.push(meta);
        this.metadataCache.set(fullPath, meta);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        errors.push(`${file}: ${code === "EACCES" ? "permission denied" : String(e)}`);
      }
    }

    return {
      metadata: metadata.sort((a, b) => b.date.getTime() - a.date.getTime()),
      errors,
    };
  }

  private validatePath(path: string): string | null {
    const resolvedPath = resolve(path);
    const resolvedHistoryDir = resolve(this.historyDir);
    const rel = relative(resolvedHistoryDir, resolvedPath);

    if (rel.startsWith("..") || rel.includes("/..") || rel.includes("\\..")) {
      return `Path traversal blocked: ${path}`;
    }

    return null;
  }

  async readFile(path: string): Promise<ParseResult<ConversationEntry>> {
    const warnings: string[] = [];
    const pathError = this.validatePath(path);

    if (pathError) {
      return { ok: false, error: pathError, warnings: [] };
    }

    const resolvedPath = resolve(path).replace(/\\/g, "/");

    try {
      const content = await readFile(resolvedPath, "utf-8");

      if (!content.trim()) {
        return { ok: false, error: "Empty file", warnings: [] };
      }

      const entry = this.parse(content, resolvedPath, warnings);
      return { ok: true, data: entry, warnings };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const code = err.code;

      if (code === "ENOENT") {
        return { ok: false, error: `File not found: ${resolvedPath}`, warnings: [] };
      }
      if (code === "EACCES") {
        return { ok: false, error: `Permission denied: ${resolvedPath}`, warnings: [] };
      }
      if (code === "EISDIR") {
        return {
          ok: false,
          error: `Path is a directory: ${resolvedPath}`,
          warnings: [],
        };
      }
      if (code === "EMFILE" || code === "ENFILE") {
        return { ok: false, error: `Too many open files`, warnings: [] };
      }

      return {
        ok: false,
        error: `Read failed [${code || "unknown"}]: ${err.message}`,
        warnings: [],
      };
    }
  }

  private extractFilename(path: string): string {
    return path.split("/").pop() || "";
  }

  private validateContent(content: string, path: string, warnings: string[]): void {
    if (!content.startsWith("#")) {
      warnings.push(`${path}: No H1 header found`);
    }
  }

  private validateSections(
    sections: Map<string, string>,
    path: string,
    warnings: string[]
  ): void {
    if (sections.size === 0) {
      warnings.push(`${path}: No sections found`);
    }
  }

  private parse(content: string, path: string, warnings: string[]): ConversationEntry {
    this.validateContent(content, path, warnings);

    const sections = extractSections(content);
    this.validateSections(sections, path, warnings);

    const quotes = extractQuotes(content);
    const artifacts = extractArtifacts(content);

    const filename = this.extractFilename(path);
    const parsed = parseFilename(filename);

    if (!parsed) {
      throw new Error(`Invalid filename format: ${filename} (from path: ${path})`);
    }

    return {
      id: filename.replace(".md", ""),
      type: parsed.type,
      date: parsed.date,
      endDate: parsed.endDate,
      rawContent: content,
      sections,
      insights: [],
      artifacts,
      quotes,
    };
  }

  private buildDateRange(opts: ReaderOptions): DateRange | null {
    if (opts.lastNDays) {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - opts.lastNDays);
      return { start, end };
    }

    if (opts.dateRange) {
      return opts.dateRange;
    }

    return null;
  }

  private isInDateRange(
    meta: FileMetadata,
    range: DateRange,
    opts: ReaderOptions
  ): boolean {
    if (meta.type === "daily") {
      return meta.date >= range.start && meta.date <= range.end;
    }

    if (!opts.includeMonthly) {
      return false;
    }

    const endDate = meta.endDate ?? meta.date;
    return endDate >= range.start && meta.date <= range.end;
  }

  private filterMetadata(
    metadata: FileMetadata[],
    opts: ReaderOptions
  ): FileMetadata[] {
    const range = this.buildDateRange(opts);
    if (!range) {
      return metadata;
    }

    return metadata.filter((meta) => this.isInDateRange(meta, range, opts));
  }

  async getEntries(opts: ReaderOptions = {}): Promise<GetEntriesResult> {
    const { metadata, errors: scanErrors } = await this.scanMetadata();
    const filtered = this.filterMetadata(metadata, opts);

    const entries: ConversationEntry[] = [];
    const warnings: string[] = [];
    const errors: Array<{ path: string; error: string }> = scanErrors.map((e) => ({
      path: this.historyDir,
      error: e,
    }));

    for (const meta of filtered) {
      const result = await this.readFile(meta.path);

      if (result.ok && result.data) {
        entries.push(result.data);
        if (result.warnings.length > 0) {
          warnings.push(...result.warnings);
        }
      } else if (result.error) {
        errors.push({ path: meta.path, error: result.error });
      }
    }

    return {
      entries: entries.sort((a, b) => a.date.getTime() - b.date.getTime()),
      warnings,
      errors,
    };
  }
}
