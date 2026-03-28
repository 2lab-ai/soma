/**
 * Pending Group Confirmation Store.
 *
 * Manages pending group activation requests awaiting owner DM confirmation.
 * File-persisted, lazy TTL expiry.
 *
 * Trace: docs/group-owner-confirm/trace.md, Scenarios 1, 5
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";

const DEFAULT_PERSISTENCE_PATH = "/tmp/soma-pending-groups.json";
const WRITE_TMP_SUFFIX = ".tmp";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface PendingConfirmation {
  chatId: number;
  chatTitle: string;
  adderId: number;
  ownerId: number;
  dmMessageId: number;
  createdAt: number; // Date.now() timestamp
}

interface PersistedPendingData {
  pending: PendingConfirmation[];
  updatedAt: string;
}

export class PendingGroupStore {
  private readonly pendingGroups: Map<number, PendingConfirmation> = new Map();
  private readonly persistencePath: string;

  constructor(persistencePath: string = DEFAULT_PERSISTENCE_PATH) {
    this.persistencePath = persistencePath;
    this.loadFromDisk();
  }

  /**
   * Add a pending confirmation. Overwrites existing pending for same chatId.
   * Trace S1, Section 3c.
   */
  add(confirmation: PendingConfirmation): boolean {
    const previous = this.pendingGroups.get(confirmation.chatId);
    this.pendingGroups.set(confirmation.chatId, confirmation);
    const persisted = this.saveToDisk();
    if (!persisted) {
      // Rollback: restore previous state
      if (previous) {
        this.pendingGroups.set(confirmation.chatId, previous);
      } else {
        this.pendingGroups.delete(confirmation.chatId);
      }
      return false;
    }
    console.log(
      `[PendingGroupStore] Added pending for group ${confirmation.chatId} (owner: ${confirmation.ownerId})`
    );
    return true;
  }

  /**
   * Get pending confirmation. Returns undefined if not found or expired.
   * Expired entries are auto-removed (lazy expiry).
   * Trace S5, Section 3a.
   */
  get(chatId: number): PendingConfirmation | undefined {
    const pending = this.pendingGroups.get(chatId);
    if (!pending) return undefined;

    if (this.isExpired(pending)) {
      this.pendingGroups.delete(chatId);
      const persisted = this.saveToDisk();
      if (!persisted) {
        // Rollback: keep expired entry in memory (will retry on next access)
        this.pendingGroups.set(chatId, pending);
      }
      console.log(
        `[PendingGroupStore] Expired pending for group ${chatId} (age: ${Math.round((Date.now() - pending.createdAt) / 3600000)}h)`
      );
      return undefined;
    }

    return pending;
  }

  /**
   * Remove a pending confirmation.
   * Trace S2/S3, Section 4.
   */
  remove(chatId: number): boolean {
    const previous = this.pendingGroups.get(chatId);
    if (!previous) return false;
    this.pendingGroups.delete(chatId);
    const persisted = this.saveToDisk();
    if (!persisted) {
      // Rollback: restore deleted entry
      this.pendingGroups.set(chatId, previous);
      return false;
    }
    console.log(`[PendingGroupStore] Removed pending for group ${chatId}`);
    return true;
  }

  /**
   * Check if a pending confirmation has expired (>24h).
   */
  isExpired(pending: PendingConfirmation): boolean {
    return Date.now() - pending.createdAt > TTL_MS;
  }

  get size(): number {
    return this.pendingGroups.size;
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.persistencePath)) {
        return;
      }
      const raw = readFileSync(this.persistencePath, "utf-8");
      const data: PersistedPendingData = JSON.parse(raw);
      if (!Array.isArray(data.pending)) return;

      for (const entry of data.pending) {
        if (
          typeof entry.chatId === "number" &&
          typeof entry.ownerId === "number" &&
          typeof entry.createdAt === "number"
        ) {
          this.pendingGroups.set(entry.chatId, entry);
        }
      }
    } catch (error) {
      console.error("[PendingGroupStore] Failed to load from disk:", error);
    }
  }

  private saveToDisk(): boolean {
    try {
      const data: PersistedPendingData = {
        pending: Array.from(this.pendingGroups.values()),
        updatedAt: new Date().toISOString(),
      };
      const tmpPath = this.persistencePath + WRITE_TMP_SUFFIX;
      writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      renameSync(tmpPath, this.persistencePath);
      return true;
    } catch (error) {
      console.error("[PendingGroupStore] Failed to save to disk:", error);
      return false;
    }
  }
}

export const pendingGroupStore = new PendingGroupStore();
