/**
 * Image format detection and validation.
 *
 * Detects actual image format from magic bytes (not file extension),
 * validates against Claude API supported formats, and converts
 * unsupported formats to PNG when possible.
 *
 * Claude API supported image formats: JPEG, PNG, GIF, WebP
 */

/** Formats the Claude API accepts for vision. */
const SUPPORTED_FORMATS = new Set(["jpeg", "png", "gif", "webp"]);

interface ImageFormatInfo {
  /** Detected format name (e.g., "jpeg", "png", "webp", "gif", "bmp", "tiff", "heic") */
  format: string;
  /** Correct file extension including dot (e.g., ".jpg", ".png") */
  extension: string;
  /** Whether the Claude API supports this format natively */
  supported: boolean;
}

/**
 * Detect actual image format from magic bytes in an ArrayBuffer.
 * Returns null if format is unrecognized.
 */
export function detectImageFormat(buffer: ArrayBuffer): ImageFormatInfo | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { format: "jpeg", extension: ".jpg", supported: true };
  }

  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { format: "png", extension: ".png", supported: true };
  }

  // GIF: 47 49 46 38 (GIF8)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { format: "gif", extension: ".gif", supported: true };
  }

  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { format: "webp", extension: ".webp", supported: true };
  }

  // BMP: 42 4D
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { format: "bmp", extension: ".bmp", supported: false };
  }

  // TIFF: 49 49 2A 00 (little-endian) or 4D 4D 00 2A (big-endian)
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) {
    return { format: "tiff", extension: ".tiff", supported: false };
  }

  // HEIC/HEIF: ....ftyp
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand.startsWith("hei") || brand.startsWith("mif")) {
      return { format: "heic", extension: ".heic", supported: false };
    }
    if (brand === "avif") {
      return { format: "avif", extension: ".avif", supported: false };
    }
  }

  // AVIF also uses ftyp box
  // Already handled above

  return null;
}

/**
 * Ensure image buffer is in a Claude-supported format.
 *
 * Strategy:
 * 1. Detect actual format from magic bytes
 * 2. If supported (JPEG/PNG/GIF/WebP) → return buffer as-is with correct extension
 * 3. If unsupported but convertible (BMP/TIFF) → convert to PNG via canvas
 * 4. If unrecognizable → return null (caller should handle gracefully)
 *
 * Returns { buffer, extension } or null if image cannot be processed.
 */
export async function ensureSupportedImageFormat(
  buffer: ArrayBuffer
): Promise<{ buffer: ArrayBuffer; extension: string } | null> {
  const info = detectImageFormat(buffer);

  // Already supported — just return with correct extension
  if (info?.supported) {
    return { buffer, extension: info.extension };
  }

  // Unsupported but recognized — attempt conversion via Bun's built-in
  if (info && !info.supported) {
    console.log(
      `[IMAGE] Detected unsupported format: ${info.format}, attempting PNG conversion`
    );
    try {
      const converted = await convertToPng(buffer);
      if (converted) {
        return { buffer: converted, extension: ".png" };
      }
    } catch (err) {
      console.warn(`[IMAGE] PNG conversion failed for ${info.format}:`, err);
    }
  }

  // Unrecognized format — last resort, try conversion anyway
  if (!info) {
    console.warn("[IMAGE] Unrecognized image format from magic bytes, attempting PNG conversion");
    try {
      const converted = await convertToPng(buffer);
      if (converted) {
        return { buffer: converted, extension: ".png" };
      }
    } catch (err) {
      console.warn("[IMAGE] PNG conversion failed for unknown format:", err);
    }
  }

  return null;
}

/**
 * Convert image buffer to PNG using sharp if available,
 * falling back to ffmpeg CLI if installed.
 */
async function convertToPng(input: ArrayBuffer): Promise<ArrayBuffer | null> {
  // Try sharp first (may be available as transitive dependency)
  try {
    const sharp = require("sharp");
    const result = await sharp(Buffer.from(input)).png().toBuffer();
    console.log("[IMAGE] Converted to PNG via sharp");
    return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
  } catch {
    // sharp not available — fall through
  }

  // Try ffmpeg as fallback
  try {
    const { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } = require("fs");
    const tmpDir = mkdtempSync("/tmp/img-convert-");
    const inputPath = `${tmpDir}/input`;
    const outputPath = `${tmpDir}/output.png`;

    writeFileSync(inputPath, Buffer.from(input));

    const result = Bun.spawnSync(["ffmpeg", "-y", "-i", inputPath, outputPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    if (result.exitCode === 0) {
      const converted = readFileSync(outputPath);
      console.log("[IMAGE] Converted to PNG via ffmpeg");
      // Cleanup
      try {
        unlinkSync(inputPath);
        unlinkSync(outputPath);
        rmdirSync(tmpDir);
      } catch { /* best effort */ }
      return converted.buffer.slice(converted.byteOffset, converted.byteOffset + converted.byteLength);
    }

    // Cleanup on failure
    try {
      unlinkSync(inputPath);
      rmdirSync(tmpDir);
    } catch { /* best effort */ }
  } catch {
    // ffmpeg not available — fall through
  }

  return null;
}
