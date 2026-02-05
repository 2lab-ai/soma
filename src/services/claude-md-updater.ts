import { readFile, writeFile, rename } from "fs/promises";
import { existsSync } from "fs";
import type { Learning } from "./memory-analyzer";

export interface Section {
  name: string;
  content: string;
  startLine: number;
  endLine: number;
  protected: boolean;
}

export interface ParsedClaudeMd {
  sections: Section[];
  rawContent: string;
  filePath: string;
}

export interface Diff {
  sectionName: string;
  oldContent: string;
  newContent: string;
  reason: string;
}

export interface ApplyResult {
  success: boolean;
  appliedDiffs: Diff[];
  skippedDiffs: Array<{ diff: Diff; reason: string }>;
  error?: string;
}

const PROTECTED_MARKER = "<!-- AUTO_UPDATE: NO -->";
const SECTION_KEYWORDS: Record<string, string[]> = {
  "Task Management": ["bd", "issue", "task", "workflow", "beads"],
  Commands: ["command", "make", "bun", "npm", "script"],
  Architecture: ["module", "handler", "flow", "structure", "component"],
  Patterns: ["pattern", "convention", "style", "approach"],
  Security: ["security", "auth", "permission", "safe"],
  "Development Workflow": ["workflow", "deploy", "test", "lint", "commit"],
};

export class ClaudeMdUpdater {
  async read(filePath: string): Promise<ParsedClaudeMd> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = await readFile(filePath, "utf-8");
    const sections = this.parseSections(content);

    return { sections, rawContent: content, filePath };
  }

  private parseSections(content: string): Section[] {
    const lines = content.split("\n");
    const sections: Section[] = [];

    let currentSection: Section | null = null;
    let contentLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || "";
      const headerMatch = line.match(/^##\s+(.+)$/);

      if (headerMatch) {
        if (currentSection) {
          currentSection.content = contentLines.join("\n").trim();
          currentSection.endLine = i - 1;
          sections.push(currentSection);
        }

        const sectionName = headerMatch[1] || "Untitled";
        const isProtected = this.checkProtected(lines, i);

        currentSection = {
          name: sectionName,
          content: "",
          startLine: i,
          endLine: i,
          protected: isProtected,
        };
        contentLines = [];
      } else if (currentSection) {
        contentLines.push(line);
      }
    }

    if (currentSection) {
      currentSection.content = contentLines.join("\n").trim();
      currentSection.endLine = lines.length - 1;
      sections.push(currentSection);
    }

    return sections;
  }

  private checkProtected(lines: string[], headerIndex: number): boolean {
    for (let i = headerIndex + 1; i < Math.min(headerIndex + 5, lines.length); i++) {
      if (lines[i]?.includes(PROTECTED_MARKER)) {
        return true;
      }
      if (lines[i]?.match(/^##\s/)) {
        break;
      }
    }
    return false;
  }

  matchLearningToSection(learning: Learning, sections: Section[]): string | null {
    if (learning.targetSection) {
      const exact = sections.find(
        (s) => s.name.toLowerCase() === learning.targetSection?.toLowerCase()
      );
      if (exact && !exact.protected) {
        return exact.name;
      }
    }

    const contentLower = learning.content.toLowerCase();
    const categoryLower = learning.category.toLowerCase();

    for (const [sectionName, keywords] of Object.entries(SECTION_KEYWORDS)) {
      const section = sections.find((s) => s.name === sectionName);
      if (!section || section.protected) continue;

      for (const keyword of keywords) {
        if (contentLower.includes(keyword) || categoryLower.includes(keyword)) {
          return sectionName;
        }
      }
    }

    const patternsSection = sections.find((s) => s.name === "Patterns" && !s.protected);
    if (patternsSection) {
      return "Patterns";
    }

    return null;
  }

  generateDiff(section: Section, learning: Learning): Diff | null {
    if (section.protected) {
      return null;
    }

    const existingContent = section.content;

    if (
      existingContent
        .toLowerCase()
        .includes(learning.content.toLowerCase().slice(0, 30))
    ) {
      return null;
    }

    const newLine = `\n\n**${this.formatCategory(learning.category)}**: ${learning.content}`;
    const newContent = existingContent + newLine;

    return {
      sectionName: section.name,
      oldContent: existingContent,
      newContent,
      reason: `Add learning from category: ${learning.category} (confidence: ${learning.confidence})`,
    };
  }

  private formatCategory(category: string): string {
    return category.charAt(0).toUpperCase() + category.slice(1);
  }

  async applyDiffs(parsed: ParsedClaudeMd, diffs: Diff[]): Promise<ApplyResult> {
    const applied: Diff[] = [];
    const skipped: Array<{ diff: Diff; reason: string }> = [];

    if (diffs.length === 0) {
      return { success: true, appliedDiffs: [], skippedDiffs: [] };
    }

    let newContent = parsed.rawContent;

    for (const diff of diffs) {
      const section = parsed.sections.find((s) => s.name === diff.sectionName);

      if (!section) {
        skipped.push({ diff, reason: `Section not found: ${diff.sectionName}` });
        continue;
      }

      if (section.protected) {
        skipped.push({ diff, reason: `Section is protected: ${diff.sectionName}` });
        continue;
      }

      if (!newContent.includes(diff.oldContent)) {
        skipped.push({
          diff,
          reason: `Old content not found in section: ${diff.sectionName}`,
        });
        continue;
      }

      newContent = newContent.replace(diff.oldContent, diff.newContent);
      applied.push(diff);
    }

    if (applied.length === 0) {
      return { success: true, appliedDiffs: [], skippedDiffs: skipped };
    }

    try {
      const tempPath = `${parsed.filePath}.tmp`;
      await writeFile(tempPath, newContent, "utf-8");
      await rename(tempPath, parsed.filePath);

      return { success: true, appliedDiffs: applied, skippedDiffs: skipped };
    } catch (e) {
      return {
        success: false,
        appliedDiffs: [],
        skippedDiffs: skipped,
        error: `Failed to write file: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async update(
    filePath: string,
    learnings: Learning[]
  ): Promise<{ parsed: ParsedClaudeMd; result: ApplyResult }> {
    const parsed = await this.read(filePath);
    const diffs: Diff[] = [];

    for (const learning of learnings) {
      if (learning.confidence < 0.8) continue;

      const sectionName = this.matchLearningToSection(learning, parsed.sections);
      if (!sectionName) continue;

      const section = parsed.sections.find((s) => s.name === sectionName);
      if (!section) continue;

      const diff = this.generateDiff(section, learning);
      if (diff) {
        diffs.push(diff);
      }
    }

    const result = await this.applyDiffs(parsed, diffs);
    return { parsed, result };
  }
}

export const claudeMdUpdater = new ClaudeMdUpdater();
