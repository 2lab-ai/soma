/**
 * MessageQueue - Batches messages with debounce for idle-time optimization.
 *
 * Buffers incoming messages and auto-flushes after a configurable debounce window.
 * Manual flush is available for immediate batch retrieval.
 */

export type Message = string;
export type BatchPayload = Message[];

export interface MessageQueueOptions {
  /** Debounce window in milliseconds (default: 300, must be non-negative) */
  debounceMs?: number;
  /** Callback invoked on auto-flush (debounce expiry) */
  onFlush?: (batch: BatchPayload) => void | Promise<void>;
  /** Error handler for failures in onFlush callback */
  onError?: (error: Error, batch: BatchPayload) => void;
}

export class MessageQueue {
  private buffer: Message[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly options: MessageQueueOptions;
  private destroyed = false;

  constructor(options: MessageQueueOptions = {}) {
    const debounce = options.debounceMs ?? 300;
    if (debounce < 0) {
      throw new Error("debounceMs must be non-negative");
    }
    this.debounceMs = debounce;
    this.options = options;
  }

  /**
   * Add message to buffer and reset debounce timer.
   * @throws Error if queue has been destroyed
   */
  enqueue(message: Message): void {
    if (this.destroyed) {
      throw new Error("MessageQueue has been destroyed");
    }

    this.buffer.push(message);
    this.resetTimer();
  }

  /**
   * Manually flush buffer, canceling pending timer.
   * @returns Current batch (may be empty array)
   */
  flush(): BatchPayload {
    this.cancelTimer();
    const batch = [...this.buffer];
    this.buffer = [];
    return batch;
  }

  /**
   * Current buffer size.
   */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Cleanup timer and prevent further enqueues.
   */
  destroy(): void {
    this.cancelTimer();
    this.destroyed = true;
    this.buffer = [];
  }

  private resetTimer(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.autoFlush().catch((err) => {
        if (this.options.onError) {
          this.options.onError(err, this.buffer);
        } else {
          console.error("MessageQueue autoFlush error:", err);
        }
      });
    }, this.debounceMs);
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async autoFlush(): Promise<void> {
    const batch = this.flush(); // Sync grab + reset
    if (batch.length > 0) {
      await this.options.onFlush?.(batch);
    }
  }
}
