import { exec } from "child_process";
import { promisify } from "util";
import { readFile, copyFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { ClaudeMdUpdater, type ApplyResult } from "./claude-md-updater";
import type { Learning } from "./memory-analyzer";

const execAsync = promisify(exec);

export interface UpdateResult {
  success: boolean;
  filesUpdated: string[];
  commitHash?: string;
  learningsApplied: number;
  learningsSkipped: number;
  error?: string;
}

export interface MemoryUpdaterConfig {
  claudeMdPath: string;
  memoryMdPath?: string;
  workingDir: string;
  dryRun?: boolean;
}

export class MemoryUpdater {
  private backupFiles: Map<string, string> = new Map();
  private updater = new ClaudeMdUpdater();
  private config: MemoryUpdaterConfig;

  constructor(config: MemoryUpdaterConfig) {
    this.config = config;
  }

  async updateMemoryFiles(learnings: Learning[]): Promise<UpdateResult> {
    const highConfidence = learnings.filter((l) => l.confidence >= 0.8);

    if (highConfidence.length === 0) {
      return {
        success: true,
        filesUpdated: [],
        learningsApplied: 0,
        learningsSkipped: learnings.length,
      };
    }

    const filesToUpdate = [this.config.claudeMdPath];
    if (this.config.memoryMdPath && existsSync(this.config.memoryMdPath)) {
      filesToUpdate.push(this.config.memoryMdPath);
    }

    try {
      await this.createBackups(filesToUpdate);

      const results: ApplyResult[] = [];
      for (const filePath of filesToUpdate) {
        if (!existsSync(filePath)) continue;
        const result = await this.updater.update(filePath, highConfidence);
        results.push(result.result);
      }

      const isValid = await this.validateUpdates(filesToUpdate);
      if (!isValid) {
        await this.rollback();
        return {
          success: false,
          filesUpdated: [],
          learningsApplied: 0,
          learningsSkipped: learnings.length,
          error: "Validation failed after updates",
        };
      }

      const totalApplied = results.reduce((sum, r) => sum + r.appliedDiffs.length, 0);
      const totalSkipped = results.reduce((sum, r) => sum + r.skippedDiffs.length, 0);

      if (totalApplied === 0) {
        await this.cleanupBackups();
        return {
          success: true,
          filesUpdated: [],
          learningsApplied: 0,
          learningsSkipped: learnings.length,
        };
      }

      if (this.config.dryRun) {
        await this.rollback();
        return {
          success: true,
          filesUpdated: filesToUpdate,
          learningsApplied: totalApplied,
          learningsSkipped: totalSkipped,
        };
      }

      const commitHash = await this.commitChanges(
        this.formatCommitMessage(highConfidence, filesToUpdate),
        filesToUpdate
      );

      await this.cleanupBackups();

      return {
        success: true,
        filesUpdated: filesToUpdate,
        commitHash,
        learningsApplied: totalApplied,
        learningsSkipped: totalSkipped,
      };
    } catch (e) {
      await this.rollback();
      return {
        success: false,
        filesUpdated: [],
        learningsApplied: 0,
        learningsSkipped: learnings.length,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async validateUpdates(filePaths: string[]): Promise<boolean> {
    for (const filePath of filePaths) {
      if (!existsSync(filePath)) continue;

      try {
        const content = await readFile(filePath, "utf-8");

        if (content.length === 0) {
          return false;
        }

        if (filePath.endsWith(".md")) {
          if (!content.includes("#")) {
            return false;
          }
        }

        const openBraces = (content.match(/```/g) || []).length;
        if (openBraces % 2 !== 0) {
          return false;
        }
      } catch {
        return false;
      }
    }

    return true;
  }

  async commitChanges(
    message: string,
    filePaths: string[]
  ): Promise<string | undefined> {
    try {
      const relativePaths = filePaths.map((p) =>
        p.startsWith(this.config.workingDir)
          ? p.slice(this.config.workingDir.length + 1)
          : p
      );

      await execAsync(`git add ${relativePaths.join(" ")}`, {
        cwd: this.config.workingDir,
      });

      const { stdout } = await execAsync(
        `git commit -m "${message.replace(/"/g, '\\"')}"`,
        { cwd: this.config.workingDir }
      );

      const hashMatch = stdout.match(/\[[\w-]+\s+([a-f0-9]+)\]/);
      return hashMatch?.[1];
    } catch (e) {
      const error = e as { stderr?: string; stdout?: string };
      if (
        error.stderr?.includes("nothing to commit") ||
        error.stdout?.includes("nothing to commit")
      ) {
        return undefined;
      }
      throw e;
    }
  }

  async rollback(): Promise<void> {
    for (const [original, backup] of this.backupFiles) {
      if (existsSync(backup)) {
        await copyFile(backup, original);
        await unlink(backup);
      }
    }
    this.backupFiles.clear();
  }

  private async createBackups(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      if (!existsSync(filePath)) continue;

      const backupPath = `${filePath}.backup.${Date.now()}`;
      await copyFile(filePath, backupPath);
      this.backupFiles.set(filePath, backupPath);
    }
  }

  private async cleanupBackups(): Promise<void> {
    for (const backup of this.backupFiles.values()) {
      if (existsSync(backup)) {
        await unlink(backup);
      }
    }
    this.backupFiles.clear();
  }

  private formatCommitMessage(learnings: Learning[], filePaths: string[]): string {
    const date = new Date().toISOString().split("T")[0];
    const fileNames = filePaths.map((p) => p.split("/").pop()).join(", ");
    const learningsList = learnings
      .slice(0, 5)
      .map((l) => `- [${l.category}] ${l.content.slice(0, 50)}...`)
      .join("\n");

    return `chore(memory): Daily CLAUDE.md update (${date})

Learnings extracted from conversations:
${learningsList}${learnings.length > 5 ? `\n- ... and ${learnings.length - 5} more` : ""}

Files updated: ${fileNames}

[AUTOMATED]`;
  }
}

export function createMemoryUpdater(config: MemoryUpdaterConfig): MemoryUpdater {
  return new MemoryUpdater(config);
}
