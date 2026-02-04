/**
 * Skills Registry Service
 *
 * Manages ~/.claude/skills-registry.json for /skills command.
 * Provides validation against available skills in ~/.claude/skills/.
 */

import { homedir } from "os";
import { join } from "path";
import { readdir, rename } from "fs/promises";
import { existsSync, mkdirSync, rmSync } from "fs";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const SKILLS_DIR = join(CLAUDE_DIR, "skills");
const REGISTRY_PATH = join(CLAUDE_DIR, "skills-registry.json");
const DEFAULT_SKILLS = ["do-work", "new-task"];
const CACHE_TTL_MS = 60_000; // 60 seconds
const MAX_REGISTRY_SIZE = 10 * 1024; // 10KB
const MAX_SKILL_NAME_LENGTH = 64;

// Error types for discriminated handling
export class SkillsRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: "CORRUPT_FILE" | "SIZE_EXCEEDED" | "SCAN_FAILED" | "SAVE_FAILED" | "DIR_CREATE_FAILED",
    public readonly userMessage: string,
    originalError?: Error
  ) {
    super(message, { cause: originalError });
    this.name = "SkillsRegistryError";
  }
}

// Result type for add/remove operations
export type RegistryOpResult =
  | { success: true }
  | { success: false; reason: "invalid_name" | "already_exists" | "not_found" | "not_in_registry" | "save_failed"; message: string };

function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(name) && name.length <= MAX_SKILL_NAME_LENGTH;
}

function normalizeSkillName(name: string): string {
  return name.toLowerCase();
}

class SkillsRegistryImpl {
  private cache: string[] | null = null;
  private cacheTime = 0;

  /**
   * Load registry from file.
   * Returns defaults if file missing (expected).
   * Throws SkillsRegistryError on corrupt file or size exceeded (unexpected).
   */
  async load(): Promise<string[]> {
    const file = Bun.file(REGISTRY_PATH);

    // Expected: file doesn't exist yet - use defaults
    if (!(await file.exists())) {
      console.log("[SkillsRegistry] No registry file, using defaults");
      return DEFAULT_SKILLS;
    }

    // Unexpected: file too large - throw (user action needed)
    const size = file.size;
    if (size > MAX_REGISTRY_SIZE) {
      throw new SkillsRegistryError(
        `Registry file too large: ${size} bytes (max ${MAX_REGISTRY_SIZE})`,
        "SIZE_EXCEEDED",
        `Skills registry file is too large (${size} bytes). Delete ~/.claude/skills-registry.json and restart.`
      );
    }

    let text: string;
    let parsed: unknown;

    try {
      text = await file.text();
      parsed = JSON.parse(text);
    } catch (error) {
      // Unexpected: file exists but can't be parsed
      throw new SkillsRegistryError(
        `Failed to parse registry file: ${error}`,
        "CORRUPT_FILE",
        `Skills registry is corrupted. Delete ~/.claude/skills-registry.json and restart.`,
        error instanceof Error ? error : undefined
      );
    }

    // Unexpected: wrong format
    if (!Array.isArray(parsed)) {
      throw new SkillsRegistryError(
        `Invalid registry format: expected array, got ${typeof parsed}`,
        "CORRUPT_FILE",
        `Skills registry has invalid format. Delete ~/.claude/skills-registry.json and restart.`
      );
    }

    // Filter and log invalid entries with details
    const invalidEntries: string[] = [];
    const skills = parsed
      .filter((s) => {
        if (typeof s !== "string") {
          invalidEntries.push(`non-string: ${JSON.stringify(s)}`);
          return false;
        }
        const normalized = normalizeSkillName(s);
        if (!isValidSkillName(normalized)) {
          invalidEntries.push(`invalid name: "${s}"`);
          return false;
        }
        return true;
      })
      .map((s) => normalizeSkillName(s as string));

    if (invalidEntries.length > 0) {
      console.warn(
        `[SkillsRegistry] Filtered ${invalidEntries.length} invalid entries: ${invalidEntries.join(", ")}`
      );
    }

    return skills;
  }

  private cleanupFailureCount = 0;
  private static readonly CLEANUP_FAILURE_THRESHOLD = 3;

  /**
   * Save registry to file (atomic write).
   * Throws SkillsRegistryError with user-actionable message on failure.
   */
  async save(skills: string[]): Promise<void> {
    const tempPath = `${REGISTRY_PATH}.tmp`;

    // Size check before write
    const content = JSON.stringify(skills, null, 2);
    if (content.length > MAX_REGISTRY_SIZE) {
      throw new SkillsRegistryError(
        `Registry too large: ${content.length} bytes (max ${MAX_REGISTRY_SIZE})`,
        "SIZE_EXCEEDED",
        `Cannot save: too many skills (${skills.length}). Remove some skills first.`
      );
    }

    // Ensure .claude directory exists
    try {
      mkdirSync(CLAUDE_DIR, { recursive: true });
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "EEXIST") {
        throw new SkillsRegistryError(
          `Failed to create directory ${CLAUDE_DIR}: ${error.message}`,
          "DIR_CREATE_FAILED",
          `Cannot create ~/.claude directory. Check permissions: ${error.message}`
        );
      }
    }

    try {
      // Atomic write via temp file
      await Bun.write(tempPath, content);
      await rename(tempPath, REGISTRY_PATH);

      // Invalidate cache
      this.cache = null;

      console.log(`[SkillsRegistry] Saved ${skills.length} skills to registry`);
    } catch (error) {
      throw new SkillsRegistryError(
        `Failed to save registry: ${error}`,
        "SAVE_FAILED",
        `Cannot save skills registry. Check disk space and permissions for ~/.claude/`,
        error instanceof Error ? error : undefined
      );
    } finally {
      // Clean up temp file if it exists
      if (existsSync(tempPath)) {
        try {
          rmSync(tempPath);
          this.cleanupFailureCount = 0; // Reset on success
        } catch (cleanupError) {
          this.cleanupFailureCount++;
          console.warn(
            `[SkillsRegistry] Failed to cleanup temp file (${this.cleanupFailureCount}/${SkillsRegistryImpl.CLEANUP_FAILURE_THRESHOLD}): ${cleanupError}`
          );
          if (this.cleanupFailureCount >= SkillsRegistryImpl.CLEANUP_FAILURE_THRESHOLD) {
            console.error(
              `[SkillsRegistry] ALERT: Cleanup failures exceeded threshold. Manual cleanup needed: rm ${tempPath}`
            );
          }
        }
      }
    }
  }

  /**
   * Validate skills against available skills directory.
   * Returns only valid skills (those that exist).
   */
  async validate(skills: string[]): Promise<string[]> {
    const available = await this.scan();
    const availableSet = new Set(available);

    const valid = skills.filter((s) => availableSet.has(s));
    const invalid = skills.filter((s) => !availableSet.has(s));

    if (invalid.length > 0) {
      console.warn(
        `[SkillsRegistry] Invalid skills (not found): ${invalid.join(", ")}`
      );
    }

    return valid;
  }

  /**
   * Scan ~/.claude/skills/ for available skills.
   * Returns directory names (cached for 60s).
   * Returns empty array if directory doesn't exist (expected).
   * Throws SkillsRegistryError on read failures (unexpected).
   */
  async scan(): Promise<string[]> {
    // Return cached result if fresh (return copy to prevent mutation)
    if (this.cache && Date.now() - this.cacheTime < CACHE_TTL_MS) {
      return [...this.cache];
    }

    // Expected: skills directory doesn't exist - return empty
    if (!existsSync(SKILLS_DIR)) {
      console.log(`[SkillsRegistry] Skills directory not found: ${SKILLS_DIR}`);
      this.cache = [];
      this.cacheTime = Date.now();
      return [];
    }

    let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = await readdir(SKILLS_DIR, { withFileTypes: true }) as typeof entries;
    } catch (error) {
      // Unexpected: directory exists but can't be read
      throw new SkillsRegistryError(
        `Failed to read skills directory: ${error}`,
        "SCAN_FAILED",
        `Cannot read ~/.claude/skills/. Check permissions.`,
        error instanceof Error ? error : undefined
      );
    }

    const skills = entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.isSymbolicLink() &&
          isValidSkillName(e.name) &&
          existsSync(join(SKILLS_DIR, e.name, "SKILL.md"))
      )
      .map((e) => normalizeSkillName(e.name));

    // Update cache
    this.cache = skills;
    this.cacheTime = Date.now();

    return [...skills]; // Return copy
  }

  /**
   * Convenience method: Load, validate, auto-save cleaned list.
   * Returns validated skills.
   */
  async sync(): Promise<string[]> {
    const skills = await this.load();
    const valid = await this.validate(skills);

    if (valid.length !== skills.length) {
      console.log(
        `[SkillsRegistry] Auto-cleaning registry (${skills.length} → ${valid.length} skills)`
      );
      await this.save(valid);
    }

    return valid;
  }

  /**
   * Add skill to registry (if not already present).
   * Returns discriminated union with failure reason.
   */
  async add(skillName: string): Promise<RegistryOpResult> {
    const normalized = normalizeSkillName(skillName);

    if (!isValidSkillName(normalized)) {
      console.warn(`[SkillsRegistry] Invalid skill name: ${skillName}`);
      return {
        success: false,
        reason: "invalid_name",
        message: `Invalid skill name "${skillName}". Use lowercase letters, numbers, and hyphens only (max ${MAX_SKILL_NAME_LENGTH} chars).`
      };
    }

    const skills = await this.load();

    if (skills.includes(normalized)) {
      console.log(`[SkillsRegistry] Skill already in registry: ${normalized}`);
      return {
        success: false,
        reason: "already_exists",
        message: `Skill "${normalized}" is already in the registry.`
      };
    }

    // Verify skill exists
    const available = await this.scan();
    if (!available.includes(normalized)) {
      console.warn(`[SkillsRegistry] Skill not found: ${normalized}`);
      return {
        success: false,
        reason: "not_found",
        message: `Skill "${normalized}" not found in ~/.claude/skills/. Available: ${available.join(", ") || "none"}`
      };
    }

    try {
      skills.push(normalized);
      await this.save(skills);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        reason: "save_failed",
        message: error instanceof SkillsRegistryError ? error.userMessage : `Failed to save: ${error}`
      };
    }
  }

  /**
   * Remove skill from registry.
   * Returns discriminated union with failure reason.
   */
  async remove(skillName: string): Promise<RegistryOpResult> {
    const normalized = normalizeSkillName(skillName);
    const skills = await this.load();
    const index = skills.indexOf(normalized);

    if (index === -1) {
      console.log(`[SkillsRegistry] Skill not in registry: ${normalized}`);
      return {
        success: false,
        reason: "not_in_registry",
        message: `Skill "${normalized}" is not in the registry.`
      };
    }

    try {
      skills.splice(index, 1);
      await this.save(skills);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        reason: "save_failed",
        message: error instanceof SkillsRegistryError ? error.userMessage : `Failed to save: ${error}`
      };
    }
  }

  /**
   * Reset registry to defaults.
   */
  async reset(): Promise<void> {
    await this.save(DEFAULT_SKILLS);
    console.log("[SkillsRegistry] Reset to defaults");
  }
}

export const skillsRegistry = new SkillsRegistryImpl();
