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
   * Returns defaults if file missing or corrupt.
   */
  async load(): Promise<string[]> {
    try {
      const file = Bun.file(REGISTRY_PATH);

      if (!(await file.exists())) {
        console.log("[SkillsRegistry] No registry file, using defaults");
        return DEFAULT_SKILLS;
      }

      const size = file.size;
      if (size > MAX_REGISTRY_SIZE) {
        console.warn(
          `[SkillsRegistry] Registry file too large (${size} bytes), using defaults`
        );
        return DEFAULT_SKILLS;
      }

      const text = await file.text();
      const parsed = JSON.parse(text);

      if (!Array.isArray(parsed)) {
        console.warn("[SkillsRegistry] Invalid format (not array), using defaults");
        return DEFAULT_SKILLS;
      }

      const skills = parsed
        .filter((s) => typeof s === "string")
        .map((s) => normalizeSkillName(s))
        .filter((s) => isValidSkillName(s));

      if (skills.length !== parsed.length) {
        console.warn(
          `[SkillsRegistry] Removed ${parsed.length - skills.length} invalid entries`
        );
      }

      return skills;
    } catch (error) {
      console.warn(`[SkillsRegistry] Failed to load registry: ${error}`);
      return DEFAULT_SKILLS;
    }
  }

  /**
   * Save registry to file (atomic write).
   */
  async save(skills: string[]): Promise<void> {
    const tempPath = `${REGISTRY_PATH}.tmp`;

    try {
      // Size check before write
      const content = JSON.stringify(skills, null, 2);
      if (content.length > MAX_REGISTRY_SIZE) {
        throw new Error(
          `Registry too large: ${content.length} bytes (max ${MAX_REGISTRY_SIZE})`
        );
      }

      // Ensure .claude directory exists
      try {
        mkdirSync(CLAUDE_DIR, { recursive: true });
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
      }

      // Atomic write via temp file
      await Bun.write(tempPath, content);
      await rename(tempPath, REGISTRY_PATH);

      // Invalidate cache
      this.cache = null;

      console.log(`[SkillsRegistry] Saved ${skills.length} skills to registry`);
    } catch (error) {
      console.error(`[SkillsRegistry] Failed to save registry: ${error}`);
      throw error;
    } finally {
      // Clean up temp file if it exists
      if (existsSync(tempPath)) {
        try {
          rmSync(tempPath);
        } catch (cleanupError) {
          console.warn(`[SkillsRegistry] Failed to cleanup temp file: ${cleanupError}`);
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
   */
  async scan(): Promise<string[]> {
    // Return cached result if fresh (return copy to prevent mutation)
    if (this.cache && Date.now() - this.cacheTime < CACHE_TTL_MS) {
      return [...this.cache];
    }

    try {
      if (!existsSync(SKILLS_DIR)) {
        console.warn(`[SkillsRegistry] Skills directory not found: ${SKILLS_DIR}`);
        return [];
      }

      const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
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
    } catch (error) {
      console.error(`[SkillsRegistry] Failed to scan skills directory: ${error}`);
      return [];
    }
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
   */
  async add(skillName: string): Promise<boolean> {
    const normalized = normalizeSkillName(skillName);

    if (!isValidSkillName(normalized)) {
      console.warn(`[SkillsRegistry] Invalid skill name: ${skillName}`);
      return false;
    }

    const skills = await this.load();

    if (skills.includes(normalized)) {
      console.log(`[SkillsRegistry] Skill already in registry: ${normalized}`);
      return false;
    }

    // Verify skill exists
    const available = await this.scan();
    if (!available.includes(normalized)) {
      console.warn(`[SkillsRegistry] Skill not found: ${normalized}`);
      return false;
    }

    skills.push(normalized);
    await this.save(skills);
    return true;
  }

  /**
   * Remove skill from registry.
   */
  async remove(skillName: string): Promise<boolean> {
    const normalized = normalizeSkillName(skillName);
    const skills = await this.load();
    const index = skills.indexOf(normalized);

    if (index === -1) {
      console.log(`[SkillsRegistry] Skill not in registry: ${normalized}`);
      return false;
    }

    skills.splice(index, 1);
    await this.save(skills);
    return true;
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
