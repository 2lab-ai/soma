/**
 * Tests for Conversation Reader Service
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ConversationReader } from "./conversation-reader";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), "conversation-reader-test");

describe("ConversationReader", () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    writeFileSync(
      join(TEST_DIR, "2025-01-15.md"),
      `# 2025-01-15 Session Log

## Session Info
- Time: 18:00-19:00 KST
- Topics: Testing, Implementation

## Dialogue

Key quote: "This is a significant insight about consciousness"

### Subsection

> "This is a block quote with important context"

## Artifacts

Created: ZETTEL/concepts/test_concept.md
`
    );

    writeFileSync(
      join(TEST_DIR, "2025-01.md"),
      `# 2025-01 Monthly Summary

## 2025-01-10 Session

Brief summary of events

## 2025-01-20 Session

Another summary
`
    );

    writeFileSync(join(TEST_DIR, "invalid-name.md"), `# Invalid File`);
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it("should scan metadata and find valid files", async () => {
    const reader = new ConversationReader(TEST_DIR);
    const { metadata, errors } = await reader.scanMetadata();

    expect(metadata.length).toBe(2);
    expect(metadata.some((m) => m.type === "daily")).toBe(true);
    expect(metadata.some((m) => m.type === "monthly")).toBe(true);
    expect(errors).toEqual([]);
  });

  it("should return error for nonexistent directory", async () => {
    const reader = new ConversationReader("/nonexistent/path");
    const { metadata, errors } = await reader.scanMetadata();

    expect(metadata).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("not found");
  });

  it("should surface errors in getEntries result", async () => {
    const reader = new ConversationReader(TEST_DIR);
    const result = await reader.getEntries({
      dateRange: {
        start: new Date("2025-01-01"),
        end: new Date("2025-12-31"),
      },
    });

    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("should parse daily file correctly", async () => {
    const reader = new ConversationReader(TEST_DIR);
    const result = await reader.readFile(join(TEST_DIR, "2025-01-15.md"));

    expect(result.ok).toBe(true);
    expect(result.data?.type).toBe("daily");
    expect(result.data?.id).toBe("2025-01-15");
    expect(result.data?.sections.size).toBeGreaterThan(0);
  });

  it("should extract sections correctly", async () => {
    const reader = new ConversationReader(TEST_DIR);
    const result = await reader.readFile(join(TEST_DIR, "2025-01-15.md"));

    expect(result.ok).toBe(true);
    expect(result.data?.sections.has("Session Info")).toBe(true);
    expect(result.data?.sections.has("Dialogue")).toBe(true);
  });

  it("should extract quotes", async () => {
    const reader = new ConversationReader(TEST_DIR);
    const result = await reader.readFile(join(TEST_DIR, "2025-01-15.md"));

    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.quotes.length).toBeGreaterThan(0);
    expect(result.data!.quotes.some((q) => q.includes("consciousness"))).toBe(true);
  });

  it("should extract artifacts", async () => {
    const reader = new ConversationReader(TEST_DIR);
    const result = await reader.readFile(join(TEST_DIR, "2025-01-15.md"));

    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.artifacts?.length).toBeGreaterThan(0);
    expect(result.data!.artifacts?.[0]?.type).toBe("zettel");
  });

  it("should filter by lastNDays", async () => {
    const reader = new ConversationReader(TEST_DIR);
    const result = await reader.getEntries({ lastNDays: 30 });

    expect(result.entries.length).toBeGreaterThanOrEqual(0);
    expect(result.errors).toBeDefined();
    expect(result.warnings).toBeDefined();
  });

  it("should filter by date range", async () => {
    const reader = new ConversationReader(TEST_DIR);
    const result = await reader.getEntries({
      dateRange: {
        start: new Date("2025-01-01"),
        end: new Date("2025-01-31"),
      },
    });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.every((e) => e.date >= new Date("2025-01-01"))).toBe(true);
  });

  it("should include monthly files when flag is set", async () => {
    const reader = new ConversationReader(TEST_DIR);
    const withMonthly = await reader.getEntries({
      lastNDays: 30,
      includeMonthly: true,
    });
    const withoutMonthly = await reader.getEntries({
      lastNDays: 30,
      includeMonthly: false,
    });

    expect(withMonthly.entries.length).toBeGreaterThanOrEqual(
      withoutMonthly.entries.length
    );
  });

  it("should handle missing files gracefully", async () => {
    const reader = new ConversationReader(TEST_DIR);
    const result = await reader.readFile(join(TEST_DIR, "nonexistent.md"));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("should handle empty files gracefully", async () => {
    writeFileSync(join(TEST_DIR, "2025-02-01.md"), "");
    const reader = new ConversationReader(TEST_DIR);
    const result = await reader.readFile(join(TEST_DIR, "2025-02-01.md"));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Empty");
  });

  it("should sort entries by date ascending", async () => {
    const reader = new ConversationReader(TEST_DIR);
    const result = await reader.getEntries({
      dateRange: {
        start: new Date("2025-01-01"),
        end: new Date("2025-12-31"),
      },
    });

    for (let i = 1; i < result.entries.length; i++) {
      expect(result.entries[i]!.date >= result.entries[i - 1]!.date).toBe(true);
    }
  });

  it("should parse monthly file correctly", async () => {
    const reader = new ConversationReader(TEST_DIR);
    const result = await reader.readFile(join(TEST_DIR, "2025-01.md"));

    expect(result.ok).toBe(true);
    expect(result.data?.type).toBe("monthly");
    expect(result.data?.endDate).toBeDefined();
  });
});
