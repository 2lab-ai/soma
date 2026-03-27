/**
 * Dynamic Group Registry for Telegram Group Session Management.
 *
 * Maintains a runtime-mutable set of registered group chatIds,
 * persisted to disk as JSON. Merges with static ALLOWED_GROUPS
 * at the security layer (not here — single responsibility).
 *
 * Trace: docs/telegram-group-session/trace.md, Scenarios 1-6
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";

const DEFAULT_PERSISTENCE_PATH = "/tmp/soma-groups.json";
const WRITE_TMP_SUFFIX = ".tmp";

interface PersistedGroupData {
  groups: number[];
  updatedAt: string;
}

export class GroupRegistry {
  private readonly registeredGroups: Set<number> = new Set();
  private readonly persistencePath: string;

  constructor(persistencePath: string = DEFAULT_PERSISTENCE_PATH) {
    this.persistencePath = persistencePath;
    this.loadFromDisk();
  }

  /**
   * Register a group chatId. Returns true if newly added, false if already existed.
   * Trace S1, Section 3b: adds chatId to Set, triggers saveToDisk.
   */
  register(chatId: number): boolean {
    if (this.registeredGroups.has(chatId)) {
      return false;
    }
    this.registeredGroups.add(chatId);
    const persisted = this.saveToDisk();
    console.log(
      `[GroupRegistry] Registered group ${chatId} (total: ${this.registeredGroups.size})` +
        (persisted ? "" : " [WARNING: NOT PERSISTED TO DISK]")
    );
    return true;
  }

  /**
   * Unregister a group chatId. Returns true if was registered, false if wasn't.
   * Trace S3, Section 3b: removes chatId from Set, triggers saveToDisk.
   */
  unregister(chatId: number): boolean {
    if (!this.registeredGroups.has(chatId)) {
      return false;
    }
    this.registeredGroups.delete(chatId);
    const persisted = this.saveToDisk();
    console.log(
      `[GroupRegistry] Unregistered group ${chatId} (total: ${this.registeredGroups.size})` +
        (persisted ? "" : " [WARNING: NOT PERSISTED TO DISK]")
    );
    return true;
  }

  /**
   * Check if a group chatId is dynamically registered.
   * Trace S4, Section 3a: O(1) Set lookup.
   */
  isRegistered(chatId: number): boolean {
    return this.registeredGroups.has(chatId);
  }

  /**
   * Number of dynamically registered groups.
   */
  get size(): number {
    return this.registeredGroups.size;
  }

  /**
   * Load persisted groups from disk.
   * Trace S5, Section 3a: read file → parse JSON → populate Set.
   */
  private loadFromDisk(): void {
    try {
      if (!existsSync(this.persistencePath)) {
        console.log("[GroupRegistry] No persisted groups, starting fresh");
        return;
      }

      const raw = readFileSync(this.persistencePath, "utf-8");
      const data: PersistedGroupData = JSON.parse(raw);

      if (!Array.isArray(data.groups)) {
        console.error("[GroupRegistry] Invalid groups format, starting fresh");
        return;
      }

      let skipped = 0;
      for (const groupId of data.groups) {
        if (typeof groupId === "number" && Number.isFinite(groupId)) {
          this.registeredGroups.add(groupId);
        } else {
          skipped++;
          console.warn(
            `[GroupRegistry] Skipping invalid group entry: ${JSON.stringify(groupId)}`
          );
        }
      }

      console.log(
        `[GroupRegistry] Loaded ${this.registeredGroups.size} groups from disk` +
          (skipped > 0 ? ` (${skipped} invalid entries skipped)` : "")
      );
    } catch (error) {
      console.error("[GroupRegistry] Failed to load from disk:", error);
      // Start with empty set — non-critical failure
    }
  }

  /**
   * Save current groups to disk.
   * Trace S5, Section 3b: Set → Array → JSON → writeFileSync.
   */
  private saveToDisk(): boolean {
    try {
      const data: PersistedGroupData = {
        groups: Array.from(this.registeredGroups),
        updatedAt: new Date().toISOString(),
      };
      const tmpPath = this.persistencePath + WRITE_TMP_SUFFIX;
      writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      renameSync(tmpPath, this.persistencePath);
      return true;
    } catch (error) {
      console.error(
        `[GroupRegistry] CRITICAL: Failed to persist ${this.registeredGroups.size} groups to ${this.persistencePath}:`,
        error
      );
      return false;
    }
  }
}

/** Global singleton instance. */
export const groupRegistry = new GroupRegistry();
