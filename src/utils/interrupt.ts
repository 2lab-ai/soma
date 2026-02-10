export function addTimestamp(message: string): string {
  const now = new Date();
  const timestamp = now.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  return `${message}\n\n<timestamp>${timestamp}</timestamp>`;
}

interface InterruptableSession {
  isRunning: boolean;
  isInterrupting: boolean;
  stop: () => Promise<"stopped" | "pending" | false>;
  markInterrupt: () => void;
  clearStopRequested: () => void;
  startInterrupt: () => boolean;
  endInterrupt: () => void;
}

export async function checkInterrupt(
  text: string,
  session?: InterruptableSession
): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  const strippedText = text.slice(1).trimStart();

  if (!session) {
    console.warn("checkInterrupt called without session - cannot stop query");
    return strippedText;
  }

  if (session.isRunning) {
    if (!session.startInterrupt()) {
      console.log("! prefix - interrupt already in progress, waiting...");
      const start = Date.now();
      while (session.isInterrupting && Date.now() - start < 6000) {
        await Bun.sleep(100);
      }
      return strippedText;
    }

    try {
      console.log("! prefix - interrupting current query");
      session.markInterrupt();
      await session.stop();
      session.clearStopRequested();
    } finally {
      session.endInterrupt();
    }
  }

  return strippedText;
}
