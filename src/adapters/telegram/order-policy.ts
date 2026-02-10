const TELEGRAM_MAIN_THREAD_ID = "main";

export interface TelegramOrderPolicyInput {
  chatId: number;
  threadId?: number;
  timestampMs: number;
  text: string;
}

export interface TelegramOrderPolicyResult {
  accepted: boolean;
  interruptBypassApplied: boolean;
}

export interface TelegramOrderPolicy {
  evaluate(input: TelegramOrderPolicyInput): TelegramOrderPolicyResult;
}

function toOrderingThreadId(threadId?: number): string {
  if (!threadId || threadId === 1) {
    return TELEGRAM_MAIN_THREAD_ID;
  }
  return String(threadId);
}

function buildOrderingKey(input: TelegramOrderPolicyInput): string {
  return `${input.chatId}:${toOrderingThreadId(input.threadId)}`;
}

function isInterruptMessage(text: string): boolean {
  return text.trimStart().startsWith("!");
}

class DefaultTelegramOrderPolicy implements TelegramOrderPolicy {
  private readonly lastTimestampByThread = new Map<string, number>();

  evaluate(input: TelegramOrderPolicyInput): TelegramOrderPolicyResult {
    const orderingKey = buildOrderingKey(input);
    const lastTimestamp = this.lastTimestampByThread.get(orderingKey) ?? 0;
    const isInterrupt = isInterruptMessage(input.text);
    const interruptBypassApplied = input.timestampMs < lastTimestamp && isInterrupt;

    if (input.timestampMs < lastTimestamp && !interruptBypassApplied) {
      return {
        accepted: false,
        interruptBypassApplied: false,
      };
    }

    this.lastTimestampByThread.set(
      orderingKey,
      Math.max(lastTimestamp, input.timestampMs)
    );

    return {
      accepted: true,
      interruptBypassApplied,
    };
  }
}

export function createTelegramOrderPolicy(): TelegramOrderPolicy {
  return new DefaultTelegramOrderPolicy();
}
