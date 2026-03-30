/**
 * RED-GREEN TDD for Issue #20: bot token scrubbing in Telegram file downloads.
 *
 * downloadTelegramFile must:
 * 1. Construct the Telegram file URL internally (caller never sees the token)
 * 2. Return ArrayBuffer on success
 * 3. On fetch failure, throw an error whose message does NOT contain the bot token
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import { downloadTelegramFile } from "./telegram-file";

// Fake bot token — the value that must NEVER appear in any thrown error
const FAKE_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

function makeFakeCtx(filePath: string) {
  return {
    api: { token: FAKE_TOKEN },
    getFile: mock(() =>
      Promise.resolve({ file_path: filePath } as { file_path: string })
    ),
  } as unknown as import("grammy").Context;
}

describe("downloadTelegramFile", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    // Restore original fetch after each test (including after suite's last test)
    globalThis.fetch = originalFetch;
  });

  test("returns ArrayBuffer on successful download", async () => {
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header bytes
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(payload, { status: 200 }))
    ) as unknown as typeof fetch;

    const result = await downloadTelegramFile(makeFakeCtx("photos/file_42.jpg"));

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result)).toEqual(payload);
  });

  test("calls correct Telegram file API URL", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(new ArrayBuffer(0), { status: 200 }))
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await downloadTelegramFile(makeFakeCtx("documents/report.pdf"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(calledUrl).toBe(
      `https://api.telegram.org/file/bot${FAKE_TOKEN}/documents/report.pdf`
    );
  });

  test("on network error, thrown message does NOT contain the bot token", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(
        new Error(`request to https://api.telegram.org/file/bot${FAKE_TOKEN}/x failed`)
      )
    ) as unknown as typeof fetch;

    try {
      await downloadTelegramFile(makeFakeCtx("x"));
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const msg = String(err);
      expect(msg).not.toContain(FAKE_TOKEN);
      expect(msg).toContain("Telegram file download failed");
    }
  });

  test("on HTTP error (non-ok response), thrown message does NOT contain the bot token", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Forbidden", { status: 403 }))
    ) as unknown as typeof fetch;

    try {
      await downloadTelegramFile(makeFakeCtx("secret.jpg"));
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const msg = String(err);
      expect(msg).not.toContain(FAKE_TOKEN);
      expect(msg).toContain("Telegram file download failed");
    }
  });

  test("on getFile failure, thrown message does NOT contain the bot token", async () => {
    const ctx = {
      api: { token: FAKE_TOKEN },
      getFile: mock(() =>
        Promise.reject(
          new Error(`https://api.telegram.org/bot${FAKE_TOKEN}/getFile failed`)
        )
      ),
    } as unknown as import("grammy").Context;

    try {
      await downloadTelegramFile(ctx);
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const msg = String(err);
      expect(msg).not.toContain(FAKE_TOKEN);
      expect(msg).toContain("Telegram file download failed");
    }
  });

  test("on non-Error throwable, thrown message does NOT contain the bot token", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(`raw string with token ${FAKE_TOKEN} leaked`)
    ) as unknown as typeof fetch;

    try {
      await downloadTelegramFile(makeFakeCtx("x"));
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const msg = String(err);
      expect(msg).not.toContain(FAKE_TOKEN);
      expect(msg).toContain("Telegram file download failed");
    }
  });

  test("on error, stack trace does NOT contain the bot token", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error(`https://api.telegram.org/file/bot${FAKE_TOKEN}/leak`))
    ) as unknown as typeof fetch;

    try {
      await downloadTelegramFile(makeFakeCtx("leak"));
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error) {
        expect(err.stack ?? "").not.toContain(FAKE_TOKEN);
      }
    }
  });
});
