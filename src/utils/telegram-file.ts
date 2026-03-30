/**
 * Secure Telegram file download helper.
 *
 * Constructs the bot-token URL internally and guarantees that any thrown error
 * has the token scrubbed — preventing accidental token leakage via logs or
 * monitoring systems.
 *
 * @see https://github.com/2lab-ai/soma/issues/20
 */
import type { Context } from "grammy";

/**
 * Download a file from Telegram's servers.
 *
 * 1. Calls `ctx.getFile()` to obtain the file path.
 * 2. Constructs the download URL using `ctx.api.token` (never exposed to caller).
 * 3. On any failure, throws a sanitized error with the token scrubbed.
 * 4. Returns the raw `ArrayBuffer` on success.
 */
export async function downloadTelegramFile(ctx: Context): Promise<ArrayBuffer> {
  const token = ctx.api.token;
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Telegram file download failed: HTTP ${response.status} ${response.statusText}`
      );
    }

    return await response.arrayBuffer();
  } catch (error: unknown) {
    // Scrub the token from any error message or stack trace
    throw scrubToken(error, token);
  }
}

/**
 * Remove every occurrence of `token` from the error's message and stack.
 * Returns a new Error so the original stack containing the token is discarded.
 */
function scrubToken(error: unknown, token: string): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw.replaceAll(token, "[REDACTED]");

  // Ensure consistent prefix so callers can identify the source
  const message = cleaned.startsWith("Telegram file download failed")
    ? cleaned
    : `Telegram file download failed: ${cleaned}`;

  const scrubbed = new Error(message);
  // Build a clean stack — never propagate the original stack which may embed the URL
  scrubbed.stack = `Error: ${message}`;
  return scrubbed;
}
