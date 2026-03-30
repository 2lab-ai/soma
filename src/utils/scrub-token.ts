/**
 * Utility to scrub bot tokens from error messages before logging or displaying them.
 */

/**
 * Converts input to string and replaces any occurrence of the bot token with [REDACTED].
 *
 * @param input - Error, string, or any throwable value
 * @param token - The bot token to redact
 * @returns Sanitized string with token replaced
 */
export function scrubBotToken(input: unknown, token: string): string {
  let str: string;
  if (input instanceof Error) {
    str = `${input.name}: ${input.message}`;
  } else if (typeof input === "string") {
    str = input;
  } else {
    str = String(input);
  }
  return token ? str.replaceAll(token, "[REDACTED]") : str;
}
