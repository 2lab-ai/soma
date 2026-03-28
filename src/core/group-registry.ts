/**
 * Dynamic Group Registry for Telegram Group Session Management.
 *
 * Maintains a runtime-mutable map of registered group chatIds with owner info,
 * persisted to disk as JSON. Merges with static ALLOWED_GROUPS
 * at the security layer (not here — single responsibility).
 *
 * Trace: docs/group-owner-confirm/trace.md, Scenario 6
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";

const DEFAULT_PERSISTENCE_PATH = "/tmp/soma-groups.json";
const WRITE_TMP_SUFFIX = ".tmp";

/** Entry stored per registered group. */
export interface GroupEntry {
  ownerId: number;
  activatedAt: string;
}

/** Persistence format — supports both old (number[]) and new (GroupEntry[]) formats. */
interface PersistedGroupData {
  groups: (number | { chatId: number; ownerId: number; activatedAt: string })[];
  updatedAt: string;
}

export class GroupRegistry {
  private readonly registeredGroups: Map<number, GroupEntry> = new Map();
  private readonly persistencePath: string;

  constructor(persistencePath: string = DEFAULT_PERSISTENCE_PATH) {
    this.persistencePath = persistencePath;
    this.loadFromDisk();
  }

  /**
   * Register a group chatId with owner. Returns true if newly added.
   * Trace S6, Section 3a: register(chatId, ownerId) stores owner association.
   */
  register(chatId: number, ownerId: number = 0): boolean {
    if (this.registeredGroups.has(chatId)) {
      return false;
    }
    const entry: GroupEntry = { ownerId, activatedAt: new Date().toISOString() };
    this.registeredGroups.set(chatId, entry);
    const persisted = this.saveToDisk();
    if (!persisted) {
      this.registeredGroups.delete(chatId);
      console.error(
        `[GroupRegistry] ROLLED BACK register of group ${chatId} — disk write failed`
      );
      return false;
    }
    console.log(
      `[GroupRegistry] Registered group ${chatId} owner=${ownerId} (total: ${this.registeredGroups.size})`
    );
    return true;
  }

  /**
   * Unregister a group chatId. Returns true if was registered.
   * Trace S3, Section 3b.
   */
  unregister(chatId: number): boolean {
    const entry = this.registeredGroups.get(chatId);
    if (!entry) {
      return false;
    }
    this.registeredGroups.delete(chatId);
    const persisted = this.saveToDisk();
    if (!persisted) {
      this.registeredGroups.set(chatId, entry);
      console.error(
        `[GroupRegistry] ROLLED BACK unregister of group ${chatId} — disk write failed`
      );
      return false;
    }
    console.log(
      `[GroupRegistry] Unregistered group ${chatId} (total: ${this.registeredGroups.size})`
    );
    return true;
  }

  /**
   * Check if a group chatId is dynamically registered.
   */
  isRegistered(chatId: number): boolean {
    return this.registeredGroups.has(chatId);
  }

  /**
   * Get the owner userId for a registered group.
   * Trace S6, Section 3a: returns ownerId or undefined.
   */
  getOwner(chatId: number): number | undefined {
    return this.registeredGroups.get(chatId)?.ownerId;
  }

  get size(): number {
    return this.registeredGroups.size;
  }

  /**
   * Load persisted groups from disk.
   * Trace S6, Section 3b: supports migration from old number[] to new GroupEntry[] format.
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
      let migrated = 0;
      for (const entry of data.groups) {
        if (typeof entry === "number" && Number.isFinite(entry)) {
          // Old format: plain number → migrate with default ownerId=0
          this.registeredGroups.set(entry, {
            ownerId: 0,
            activatedAt: "migrated",
          });
          migrated++;
        } else if (
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.chatId === "number" &&
          Number.isFinite(entry.chatId) &&
          typeof entry.ownerId === "number"
        ) {
          // New format: GroupEntry object
          this.registeredGroups.set(entry.chatId, {
            ownerId: entry.ownerId,
            activatedAt: entry.activatedAt || "unknown",
          });
        } else {
          skipped++;
          console.warn(
            `[GroupRegistry] Skipping invalid group entry: ${JSON.stringify(entry)}`
          );
        }
      }

      const parts: string[] = [];
      parts.push(
        `[GroupRegistry] Loaded ${this.registeredGroups.size} groups from disk`
      );
      if (migrated > 0) parts.push(`(${migrated} migrated from old format)`);
      if (skipped > 0) parts.push(`(${skipped} invalid entries skipped)`);
      console.log(parts.join(" "));

      // Auto-save if migration occurred to persist new format
      if (migrated > 0) {
        this.saveToDisk();
      }
    } catch (error) {
      console.error("[GroupRegistry] Failed to load from disk:", error);
    }
  }

  /**
   * Save current groups to disk in new GroupEntry[] format.
   */
  private saveToDisk(): boolean {
    try {
      const groups: { chatId: number; ownerId: number; activatedAt: string }[] = [];
      for (const [chatId, entry] of this.registeredGroups) {
        groups.push({ chatId, ownerId: entry.ownerId, activatedAt: entry.activatedAt });
      }
      const data = { groups, updatedAt: new Date().toISOString() };
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
