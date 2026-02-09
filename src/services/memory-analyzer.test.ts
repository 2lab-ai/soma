import { describe, it, expect } from "bun:test";
import { MemoryAnalyzer, type Learning } from "./memory-analyzer";
import type { ConversationEntry } from "./conversation-reader";

const mockEntry: ConversationEntry = {
  id: "2025-01-15",
  type: "daily",
  date: new Date("2025-01-15"),
  rawContent: `# Test Session

User: always use bun instead of npm for this project
Assistant: Understood, I'll use bun.

User: the todo list should be minimal
Assistant: I'll keep it concise.`,
  sections: new Map([["Dialogue", "test content"]]),
  insights: [],
  artifacts: [],
  quotes: [],
};

describe("MemoryAnalyzer", () => {
  describe("extractLearnings parsing", () => {
    it("should parse valid JSON response", () => {
      const analyzer = new MemoryAnalyzer("/nonexistent");
      const validResponse = `Here are the learnings:

\`\`\`json
[
  {
    "category": "corrections",
    "content": "Use bun instead of npm",
    "confidence": 0.95,
    "sourceQuotes": ["always use bun instead of npm"]
  },
  {
    "category": "preferences",
    "content": "Keep todo lists minimal",
    "confidence": 0.8,
    "sourceQuotes": ["the todo list should be minimal"]
  }
]
\`\`\``;

      const parsed = (
        analyzer as unknown as { parseLearningsResponse: (r: string) => Learning[] }
      ).parseLearningsResponse(validResponse);

      expect(parsed.length).toBe(2);
      expect(parsed[0]?.category).toBe("corrections");
      expect(parsed[0]?.confidence).toBe(0.95);
      expect(parsed[1]?.category).toBe("preferences");
    });

    it("should filter low confidence learnings", () => {
      const analyzer = new MemoryAnalyzer("/nonexistent");
      const response = `\`\`\`json
[
  {"category": "patterns", "content": "test1", "confidence": 0.9, "sourceQuotes": []},
  {"category": "patterns", "content": "test2", "confidence": 0.3, "sourceQuotes": []},
  {"category": "patterns", "content": "test3", "confidence": 0.5, "sourceQuotes": []}
]
\`\`\``;

      const parsed = (
        analyzer as unknown as { parseLearningsResponse: (r: string) => Learning[] }
      ).parseLearningsResponse(response);

      expect(parsed.length).toBe(2);
      expect(parsed.every((l) => l.confidence >= 0.4)).toBe(true);
    });

    it("should handle malformed JSON gracefully", () => {
      const analyzer = new MemoryAnalyzer("/nonexistent");
      const badResponse = `\`\`\`json
{ not valid json }
\`\`\``;

      const parsed = (
        analyzer as unknown as { parseLearningsResponse: (r: string) => Learning[] }
      ).parseLearningsResponse(badResponse);
      expect(parsed).toEqual([]);
    });

    it("should handle empty response", () => {
      const analyzer = new MemoryAnalyzer("/nonexistent");
      const emptyResponse = "No learnings found in this conversation.";

      const parsed = (
        analyzer as unknown as { parseLearningsResponse: (r: string) => Learning[] }
      ).parseLearningsResponse(emptyResponse);
      expect(parsed).toEqual([]);
    });

    it("should normalize invalid categories to patterns", () => {
      const analyzer = new MemoryAnalyzer("/nonexistent");
      const response = `\`\`\`json
[{"category": "invalid_category", "content": "test", "confidence": 0.8, "sourceQuotes": []}]
\`\`\``;

      const parsed = (
        analyzer as unknown as { parseLearningsResponse: (r: string) => Learning[] }
      ).parseLearningsResponse(response);
      expect(parsed[0]?.category).toBe("patterns");
    });

    it("should clamp confidence to 0-1 range", () => {
      const analyzer = new MemoryAnalyzer("/nonexistent");
      const response = `\`\`\`json
[
  {"category": "rules", "content": "test1", "confidence": 1.5, "sourceQuotes": []},
  {"category": "rules", "content": "test2", "confidence": -0.5, "sourceQuotes": []}
]
\`\`\``;

      const parsed = (
        analyzer as unknown as { parseLearningsResponse: (r: string) => Learning[] }
      ).parseLearningsResponse(response);
      expect(parsed[0]?.confidence).toBe(1);
      expect(parsed.length).toBe(1);
    });
  });

  describe("generateDiffs parsing", () => {
    it("should parse valid diff response", () => {
      const analyzer = new MemoryAnalyzer("/nonexistent");
      const response = `\`\`\`json
[
  {
    "section": "Workflow",
    "oldContent": "Use npm",
    "newContent": "Use bun",
    "reason": "User prefers bun"
  }
]
\`\`\``;

      const parsed = (
        analyzer as unknown as { parseDiffsResponse: (r: string) => unknown[] }
      ).parseDiffsResponse(response);
      expect(parsed.length).toBe(1);
      expect((parsed[0] as Record<string, string>).section).toBe("Workflow");
    });

    it("should filter diffs without section or newContent", () => {
      const analyzer = new MemoryAnalyzer("/nonexistent");
      const response = `\`\`\`json
[
  {"section": "", "oldContent": "x", "newContent": "y", "reason": ""},
  {"section": "Valid", "oldContent": "", "newContent": "y", "reason": ""},
  {"section": "Valid2", "oldContent": "x", "newContent": "", "reason": ""}
]
\`\`\``;

      const parsed = (
        analyzer as unknown as { parseDiffsResponse: (r: string) => unknown[] }
      ).parseDiffsResponse(response);
      expect(parsed.length).toBe(1);
      expect((parsed[0] as Record<string, string>).section).toBe("Valid");
    });
  });

  describe("formatConversationContent", () => {
    it("should format entries with headers", () => {
      const analyzer = new MemoryAnalyzer("/nonexistent");
      const formatted = (
        analyzer as unknown as {
          formatConversationContent: (e: ConversationEntry[]) => string;
        }
      ).formatConversationContent([mockEntry]);

      expect(formatted).toContain("--- 2025-01-15 (daily) ---");
      expect(formatted).toContain("always use bun");
    });

    it("should truncate long content", () => {
      const analyzer = new MemoryAnalyzer("/nonexistent");
      const longEntry: ConversationEntry = {
        ...mockEntry,
        rawContent: "x".repeat(10000),
      };

      const formatted = (
        analyzer as unknown as {
          formatConversationContent: (e: ConversationEntry[]) => string;
        }
      ).formatConversationContent([longEntry]);
      expect(formatted.length).toBeLessThan(9000);
    });
  });

  describe("high-confidence filtering", () => {
    it("should skip diff generation when no high-confidence learnings", async () => {
      const analyzer = new MemoryAnalyzer("/nonexistent");
      const learnings: Learning[] = [
        { category: "rules", content: "rule1", confidence: 0.5, sourceQuotes: [] },
        { category: "rules", content: "rule2", confidence: 0.6, sourceQuotes: [] },
        { category: "rules", content: "rule3", confidence: 0.79, sourceQuotes: [] },
      ];

      const result = await analyzer.generateDiffs(learnings, new Map());

      expect(result.rawResponse).toBe("No high-confidence learnings to apply");
      expect(result.diffs).toEqual([]);
    });
  });
});
