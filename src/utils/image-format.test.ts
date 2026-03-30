import { describe, expect, test } from "bun:test";
import { detectImageFormat, ensureSupportedImageFormat } from "./image-format";

describe("detectImageFormat", () => {
  test("detects JPEG from magic bytes", () => {
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]).buffer;
    const result = detectImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("jpeg");
    expect(result!.extension).toBe(".jpg");
    expect(result!.supported).toBe(true);
  });

  test("detects PNG from magic bytes", () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).buffer;
    const result = detectImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("png");
    expect(result!.extension).toBe(".png");
    expect(result!.supported).toBe(true);
  });

  test("detects GIF from magic bytes", () => {
    const buf = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).buffer;
    const result = detectImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("gif");
    expect(result!.extension).toBe(".gif");
    expect(result!.supported).toBe(true);
  });

  test("detects WebP from magic bytes", () => {
    // RIFF....WEBP
    const buf = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // file size (doesn't matter for detection)
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]).buffer;
    const result = detectImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("webp");
    expect(result!.extension).toBe(".webp");
    expect(result!.supported).toBe(true);
  });

  test("detects BMP as unsupported", () => {
    const buf = new Uint8Array([0x42, 0x4d, 0x00, 0x00]).buffer;
    const result = detectImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("bmp");
    expect(result!.supported).toBe(false);
  });

  test("detects TIFF (little-endian) as unsupported", () => {
    const buf = new Uint8Array([0x49, 0x49, 0x2a, 0x00]).buffer;
    const result = detectImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("tiff");
    expect(result!.supported).toBe(false);
  });

  test("detects TIFF (big-endian) as unsupported", () => {
    const buf = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a]).buffer;
    const result = detectImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("tiff");
    expect(result!.supported).toBe(false);
  });

  test("returns null for empty buffer", () => {
    const buf = new Uint8Array([]).buffer;
    expect(detectImageFormat(buf)).toBeNull();
  });

  test("returns null for too-small buffer", () => {
    const buf = new Uint8Array([0x00, 0x01]).buffer;
    expect(detectImageFormat(buf)).toBeNull();
  });

  test("returns null for unrecognized bytes", () => {
    const buf = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]).buffer;
    expect(detectImageFormat(buf)).toBeNull();
  });
});

describe("ensureSupportedImageFormat", () => {
  test("passes through JPEG without conversion", async () => {
    // Minimal JPEG-like header
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer;
    const result = await ensureSupportedImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.extension).toBe(".jpg");
    // Buffer should be the same (no conversion needed)
    expect(result!.buffer).toBe(buf);
  });

  test("passes through PNG without conversion", async () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).buffer;
    const result = await ensureSupportedImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.extension).toBe(".png");
    expect(result!.buffer).toBe(buf);
  });

  test("passes through WebP without conversion", async () => {
    const buf = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]).buffer;
    const result = await ensureSupportedImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.extension).toBe(".webp");
    expect(result!.buffer).toBe(buf);
  });

  test("passes through GIF without conversion", async () => {
    const buf = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).buffer;
    const result = await ensureSupportedImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.extension).toBe(".gif");
    expect(result!.buffer).toBe(buf);
  });
});
