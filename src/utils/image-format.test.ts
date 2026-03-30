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

  test("detects HEIC from ftyp box", () => {
    // ftyp at offset 4, brand "heic"
    const buf = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, // box size
      0x66, 0x74, 0x79, 0x70, // ftyp
      0x68, 0x65, 0x69, 0x63, // heic
    ]).buffer;
    const result = detectImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("heic");
    expect(result!.extension).toBe(".heic");
    expect(result!.supported).toBe(false);
  });

  test("detects AVIF from ftyp box", () => {
    const buf = new Uint8Array([
      0x00, 0x00, 0x00, 0x1c,
      0x66, 0x74, 0x79, 0x70, // ftyp
      0x61, 0x76, 0x69, 0x66, // avif
    ]).buffer;
    const result = detectImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("avif");
    expect(result!.extension).toBe(".avif");
    expect(result!.supported).toBe(false);
  });

  test("detects HEIF (mif1 brand)", () => {
    const buf = new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70, // ftyp
      0x6d, 0x69, 0x66, 0x31, // mif1
    ]).buffer;
    const result = detectImageFormat(buf);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("heic");
    expect(result!.supported).toBe(false);
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

  test("returns null for unsupported format when no converter available", async () => {
    // BMP header — unsupported, and no sharp/ffmpeg in test env
    const buf = new Uint8Array([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00]).buffer;
    const result = await ensureSupportedImageFormat(buf);
    // Without sharp/ffmpeg, conversion fails → returns null
    expect(result).toBeNull();
  });

  test("returns null for unrecognized format when no converter available", async () => {
    // Random bytes — not a known image format
    const buf = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]).buffer;
    const result = await ensureSupportedImageFormat(buf);
    expect(result).toBeNull();
  });
});
