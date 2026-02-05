import { spawn } from "child_process";
import { CLAUDE_CLI_PATH } from "../config";
import type { ConversationEntry } from "./conversation-reader";

export type LearningCategory =
  | "commands"
  | "workflows"
  | "corrections"
  | "patterns"
  | "tools"
  | "rules"
  | "preferences";

export interface Learning {
  category: LearningCategory;
  content: string;
  confidence: number;
  sourceQuotes: string[];
  targetSection?: string;
}

export interface LearningExtractionResult {
  learnings: Learning[];
  rawResponse: string;
  error?: string;
}

export interface DiffEntry {
  section: string;
  oldContent: string;
  newContent: string;
  reason: string;
}

export interface DiffGenerationResult {
  diffs: DiffEntry[];
  rawResponse: string;
  error?: string;
}

const EXTRACTION_PROMPT = `You are analyzing conversation logs to extract learnings for updating a user's CLAUDE.md configuration file.

Extract learnings in these categories:
- commands: New CLI commands, aliases, or command patterns the user prefers
- workflows: Multi-step processes or task sequences the user follows
- corrections: Times the user corrected you (indicates previous understanding was wrong)
- patterns: Code patterns, naming conventions, or structural preferences
- tools: Tool preferences, MCP servers, or integrations the user uses
- rules: Explicit rules or constraints the user mentioned
- preferences: Personal preferences for communication style, formatting, etc.

For each learning:
1. Identify the category
2. Write the learning as a concise instruction (imperative form)
3. Assign confidence (0.0-1.0):
   - 1.0: User explicitly stated as rule/preference
   - 0.8-0.9: User corrected you or clearly demonstrated preference
   - 0.6-0.7: Inferred from multiple examples
   - 0.4-0.5: Single implicit example
   - <0.4: Uncertain, may need more context
4. Include source quotes (exact text from conversation)

Output JSON array:
\`\`\`json
[
  {
    "category": "corrections",
    "content": "Always use bun instead of npm for this project",
    "confidence": 0.95,
    "sourceQuotes": ["use bun, not npm", "this project uses bun"]
  }
]
\`\`\`

IMPORTANT:
- Only extract learnings with confidence >= 0.4
- Keep content concise (1-2 sentences max)
- Quote exact text from conversation
- If no learnings found, return empty array []

CONVERSATION CONTENT:
`;

const DIFF_PROMPT = `You are generating minimal diffs to update CLAUDE.md sections based on verified learnings.

Each learning should be matched to the most appropriate section.
Generate the smallest possible change that incorporates the learning.

Input format:
- CURRENT SECTIONS: The existing CLAUDE.md content by section
- LEARNINGS: High-confidence learnings to incorporate

Output JSON array:
\`\`\`json
[
  {
    "section": "Section Name",
    "oldContent": "exact text to replace",
    "newContent": "replacement text with learning incorporated",
    "reason": "Brief explanation of the change"
  }
]
\`\`\`

Rules:
1. ONLY apply learnings with confidence >= 0.8
2. Make MINIMAL changes - don't rewrite sections
3. Preserve existing formatting and structure
4. If learning doesn't fit any section, skip it
5. If unsure, add TODO comment instead of direct change
6. Never remove existing content unless contradicted by high-confidence learning

CURRENT SECTIONS:
`;

export class MemoryAnalyzer {
  constructor(private claudePath: string = CLAUDE_CLI_PATH) {}

  async extractLearnings(
    entries: ConversationEntry[]
  ): Promise<LearningExtractionResult> {
    const content = this.formatConversationContent(entries);
    const prompt = EXTRACTION_PROMPT + content;

    try {
      const response = await this.callClaude(prompt);
      const learnings = this.parseLearningsResponse(response);
      return { learnings, rawResponse: response };
    } catch (e) {
      return {
        learnings: [],
        rawResponse: "",
        error: `Extraction failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async generateDiffs(
    learnings: Learning[],
    sections: Map<string, string>
  ): Promise<DiffGenerationResult> {
    const highConfidence = learnings.filter((l) => l.confidence >= 0.8);

    if (highConfidence.length === 0) {
      return { diffs: [], rawResponse: "No high-confidence learnings to apply" };
    }

    const sectionsText = this.formatSections(sections);
    const learningsText = this.formatLearnings(highConfidence);
    const prompt = DIFF_PROMPT + sectionsText + "\n\nLEARNINGS:\n" + learningsText;

    try {
      const response = await this.callClaude(prompt);
      const diffs = this.parseDiffsResponse(response);
      return { diffs, rawResponse: response };
    } catch (e) {
      return {
        diffs: [],
        rawResponse: "",
        error: `Diff generation failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  private formatConversationContent(entries: ConversationEntry[]): string {
    return entries
      .map((e) => {
        const header = `--- ${e.id} (${e.type}) ---`;
        const content = e.rawContent.slice(0, 8000);
        return `${header}\n${content}`;
      })
      .join("\n\n");
  }

  private formatSections(sections: Map<string, string>): string {
    return Array.from(sections.entries())
      .map(([name, content]) => `## ${name}\n${content}`)
      .join("\n\n");
  }

  private formatLearnings(learnings: Learning[]): string {
    return learnings
      .map(
        (l, i) => `${i + 1}. [${l.category}] ${l.content} (confidence: ${l.confidence})`
      )
      .join("\n");
  }

  private parseLearningsResponse(response: string): Learning[] {
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) {
      const directParse = response.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (directParse) {
        return this.validateLearnings(JSON.parse(directParse[0]));
      }
      return [];
    }

    try {
      const parsed = JSON.parse(jsonMatch[1] || "[]");
      return this.validateLearnings(parsed);
    } catch {
      return [];
    }
  }

  private validateLearnings(data: unknown): Learning[] {
    if (!Array.isArray(data)) return [];

    const validCategories: LearningCategory[] = [
      "commands",
      "workflows",
      "corrections",
      "patterns",
      "tools",
      "rules",
      "preferences",
    ];

    return data
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null
      )
      .map((item) => ({
        category: validCategories.includes(item.category as LearningCategory)
          ? (item.category as LearningCategory)
          : "patterns",
        content: String(item.content || ""),
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
        sourceQuotes: Array.isArray(item.sourceQuotes)
          ? item.sourceQuotes.map(String)
          : [],
        targetSection: item.targetSection ? String(item.targetSection) : undefined,
      }))
      .filter((l) => l.content && l.confidence >= 0.4);
  }

  private parseDiffsResponse(response: string): DiffEntry[] {
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) return [];

    try {
      const parsed = JSON.parse(jsonMatch[1] || "[]");
      return this.validateDiffs(parsed);
    } catch {
      return [];
    }
  }

  private validateDiffs(data: unknown): DiffEntry[] {
    if (!Array.isArray(data)) return [];

    return data
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null
      )
      .map((item) => ({
        section: String(item.section || ""),
        oldContent: String(item.oldContent || ""),
        newContent: String(item.newContent || ""),
        reason: String(item.reason || ""),
      }))
      .filter((d) => d.section && d.newContent);
  }

  private callClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        this.claudePath,
        ["--print", "--dangerously-skip-permissions"],
        {
          env: { ...process.env },
        }
      );

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Claude CLI exited with ${code}: ${stderr}`));
        }
      });

      proc.on("error", (err) => {
        reject(err);
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }
}
