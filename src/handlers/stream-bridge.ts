/**
 * DeltaQueue: Push→Pull bridge for native Telegram streaming.
 *
 * Claude SDK's statusCallback pushes cumulative text ("Hello", "Hello World", "Hello World!").
 * grammY's streamMessage consumes an AsyncIterator of string deltas ("Hello", " World", "!").
 * This class tracks previous text length and emits only new deltas.
 *
 * Each emitted chunk is guaranteed ≤ MAX_CHUNK_SIZE (4096) to satisfy
 * grammY's sendMessageDraft constraint.
 */

const MAX_CHUNK_SIZE = 4096;

export class DeltaQueue implements AsyncIterable<string> {
  private buffer: string[] = [];
  private waiter: ((result: IteratorResult<string>) => void) | null = null;
  private finished = false;
  private previousLength = 0;

  /** Push cumulative text; only the new delta since last push is queued.
   *  Splits into ≤4096-char chunks for grammY compatibility. */
  pushCumulative(fullText: string): void {
    if (this.finished) return;
    const delta = fullText.slice(this.previousLength);
    this.previousLength = fullText.length;
    if (!delta) return;

    // Split delta into safe chunks for sendMessageDraft
    const chunks =
      delta.length <= MAX_CHUNK_SIZE
        ? [delta]
        : Array.from({ length: Math.ceil(delta.length / MAX_CHUNK_SIZE) }, (_, i) =>
            delta.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE)
          );

    for (const chunk of chunks) {
      if (this.waiter) {
        this.waiter({ value: chunk, done: false });
        this.waiter = null;
      } else {
        this.buffer.push(chunk);
      }
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
