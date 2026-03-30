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

export async function downloadTelegramFile(ctx: Context): Promise<ArrayBuffer> {
  const token = ctx.api.token;

  try {
    const file = await ctx.getFile();
    if (!file.file_path) {
      throw new Error("Telegram file download failed: file_path is empty");
    }
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Telegram file download failed: HTTP ${response.status} ${response.statusText}`
      );
    }

    return await response.arrayBuffer();
  } catch (error: unknown) {
    throw scrubToken(error, token);
  }
}

/**
 * Remove every occurrence of `token` from the error's message and stack.
 * Returns a new Error so the original stack containing the token is discarded.
 */
function scrubToken(error: unknown, token: string): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = token ? raw.replaceAll(token, "[REDACTED]") : raw;

  const message = cleaned.startsWith("Telegram file download failed")
    ? cleaned
    : `Telegram file download failed: ${cleaned}`;

  const scrubbed = new Error(message);
  scrubbed.stack = `Error: ${message}`;
  return scrubbed;
}
