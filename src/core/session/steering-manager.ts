import {
  createSteeringMessage,
  type PendingRecovery,
  type SteeringMessage,
} from "../../types/session";
import { formatSteeringMessages } from "./session-helpers";

export interface SteeringAddResult {
  evicted: boolean;
  evictedMessage: SteeringMessage | null;
}

export class SteeringManager {
  private steeringBuffer: SteeringMessage[] = [];
  private injectedSteeringDuringQuery: SteeringMessage[] = [];
  private pendingRecovery: PendingRecovery | null = null;
  private _evictionCount = 0;

  constructor(
    private readonly maxSteeringMessages: number,
    private readonly pendingRecoveryTimeoutMs: number
  ) {}

  getSteeringCount(): number {
    return this.steeringBuffer.length;
  }

  hasSteeringMessages(): boolean {
    return this.steeringBuffer.length > 0 || this.injectedSteeringDuringQuery.length > 0;
  }

  /** Total messages evicted since last reset. */
  get evictionCount(): number {
    return this._evictionCount;
  }

  addSteering(
    message: string,
    messageId: number,
    receivedDuringTool?: string
  ): SteeringAddResult {
    let evictedMessage: SteeringMessage | null = null;
    if (this.steeringBuffer.length >= this.maxSteeringMessages) {
      evictedMessage = this.steeringBuffer.shift() ?? null;
      this._evictionCount++;
    }

    const steeringMessage = createSteeringMessage(
      message,
      messageId,
      receivedDuringTool
    );
    this.steeringBuffer.push(steeringMessage);
    return { evicted: evictedMessage !== null, evictedMessage };
  }

  consumeSteering(): string | null {
    if (!this.steeringBuffer.length) {
      return null;
    }
    const formatted = formatSteeringMessages(this.steeringBuffer);
    this.steeringBuffer = [];
    return formatted;
  }

  /**
   * Consume steering buffer, returning both formatted text AND original messageIds.
   * Used by auto-continue loop to update emoji reactions on consumed messages.
   */
  consumeSteeringWithIds(): { formatted: string; messageIds: number[] } | null {
    if (!this.steeringBuffer.length) {
      return null;
    }
    const messageIds = this.steeringBuffer
      .map((m) => m.messageId)
      .filter((id): id is number => id !== undefined);
    const formatted = formatSteeringMessages(this.steeringBuffer);
    this.steeringBuffer = [];
    return { formatted, messageIds };
  }

  peekSteering(): string | null {
    if (!this.steeringBuffer.length) return null;
    return formatSteeringMessages(this.steeringBuffer);
  }

  extractSteeringMessages(): SteeringMessage[] {
    // Collect from BOTH stores: injectedSteeringDuringQuery (already sent to
    // Claude via PostToolUse but not yet acknowledged) AND steeringBuffer
    // (queued but not yet injected).  Deduplicate by messageId so messages
    // tracked in both arrays aren't returned twice.
    const seen = new Set<number>();
    const combined: SteeringMessage[] = [];

    for (const msg of this.injectedSteeringDuringQuery) {
      if (msg.messageId !== undefined) seen.add(msg.messageId);
      combined.push(msg);
    }
    for (const msg of this.steeringBuffer) {
      if (msg.messageId !== undefined && seen.has(msg.messageId)) continue;
      combined.push(msg);
    }

    this.injectedSteeringDuringQuery = [];
    this.steeringBuffer = [];
    return combined;
  }

  trackBufferedMessagesForInjection(): number {
    if (!this.steeringBuffer.length) {
      return 0;
    }
    this.injectedSteeringDuringQuery.push(...this.steeringBuffer);
    return this.steeringBuffer.length;
  }

  getInjectedCount(): number {
    return this.injectedSteeringDuringQuery.length;
  }

  restoreInjectedSteering(): number {
    const injectedCount = this.injectedSteeringDuringQuery.length;
    if (!injectedCount) {
      return 0;
    }

    this.steeringBuffer = [...this.injectedSteeringDuringQuery, ...this.steeringBuffer];
    this.injectedSteeringDuringQuery = [];
    return injectedCount;
  }

  clearInjectedSteeringTracking(): void {
    this.injectedSteeringDuringQuery = [];
  }

  setPendingRecovery(
    messages: SteeringMessage[],
    chatId: number,
    messageId?: number
  ): void {
    this.pendingRecovery = {
      messages,
      promptedAt: Date.now(),
      state: "awaiting",
      chatId,
      messageId,
    };
  }

  getPendingRecovery(): PendingRecovery | null {
    if (!this.pendingRecovery) return null;

    const elapsed = Date.now() - this.pendingRecovery.promptedAt;
    if (elapsed > this.pendingRecoveryTimeoutMs) {
      this.pendingRecovery = null;
      return null;
    }

    return this.pendingRecovery;
  }

  resolvePendingRecovery(): SteeringMessage[] | null {
    const recovery = this.getPendingRecovery();
    if (!recovery || recovery.state === "resolved") return null;

    recovery.state = "resolved";
    const messages = recovery.messages;
    this.pendingRecovery = null;
    return messages;
  }

  clearPendingRecovery(): number {
    const discarded = this.pendingRecovery?.messages.length ?? 0;
    this.pendingRecovery = null;
    return discarded;
  }

  hasPendingRecovery(): boolean {
    return this.getPendingRecovery() !== null;
  }

  reset(): void {
    this.steeringBuffer = [];
    this.injectedSteeringDuringQuery = [];
    this.pendingRecovery = null;
    this._evictionCount = 0;
  }
}
