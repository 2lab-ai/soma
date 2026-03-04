export function isReentrancyError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("already running");
  }
  return String(error).includes("already running");
}
