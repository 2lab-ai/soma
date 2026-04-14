/**
 * DeltaQueue: Push→Pull bridge for native Telegram streaming.
 *
 * Claude SDK's statusCallback pushes cumulative text ("Hello", "Hello World", "Hello World!").
 * grammY's streamMessage consumes an AsyncIterator of string deltas ("Hello", " World", "!").
 * This class tracks previous text length and emits only new deltas.
 */
export class DeltaQueue implements AsyncIterable<string> {
  private buffer: string[] = [];
  private waiter: ((result: IteratorResult<string>) => void) | null = null;
  private finished = false;
  private previousLength = 0;

  /** Push cumulative text; only the new delta since last push is queued. */
  pushCumulative(fullText: string): void {
    if (this.finished) return;
    const delta = fullText.slice(this.previousLength);
    this.previousLength = fullText.length;
    if (!delta) return;

    if (this.waiter) {
      this.waiter({ value: delta, done: false });
      this.waiter = null;
    } else {
      this.buffer.push(delta);
    }
  }

  /** Signal that no more data will be pushed. */
  end(): void {
    this.finished = true;
    if (this.waiter) {
      this.waiter({ value: undefined as unknown as string, done: true });
      this.waiter = null;
    }
  }

  /** Abort: discard remaining buffer and signal completion. */
  abort(): void {
    this.buffer.length = 0;
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      } else if (this.finished) {
        return;
      } else {
        const result = await new Promise<IteratorResult<string>>((resolve) => {
          this.waiter = resolve;
        });
        if (result.done) return;
        yield result.value;
      }
    }
  }
}
