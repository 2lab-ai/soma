/**
 * TTS utility — fish-tts wrapper for voice reply mode.
 * Generates audio from text using fish-tts with IU voice (default).
 */

import { spawn } from "child_process";
import { unlinkSync, existsSync } from "fs";
import { TEMP_DIR } from "../config";

const FISH_TTS_SCRIPT =
  "/home/zhugehyuk/2lab.ai/skills/fish-tts/scripts/fish-tts.sh";

const DEFAULT_VOICE = "iu";
const MAX_TEXT_LENGTH = 500; // fish-tts can struggle with very long text

/**
 * Generate speech audio from text using fish-tts.
 * Returns the path to the generated WAV file, or null on failure.
 */
export async function generateSpeech(
  text: string,
  voice: string = DEFAULT_VOICE
): Promise<string | null> {
  // Truncate very long text
  const truncated =
    text.length > MAX_TEXT_LENGTH
      ? text.slice(0, MAX_TEXT_LENGTH) + "..."
      : text;

  // Strip markdown formatting for cleaner speech
  const cleanText = stripMarkdown(truncated);
  if (!cleanText.trim()) return null;

  const timestamp = Date.now();
  const outputPath = `${TEMP_DIR}/tts_reply_${timestamp}.wav`;

  try {
    const exitCode = await runFishTts(cleanText, voice, outputPath);

    if (exitCode !== 0 || !existsSync(outputPath)) {
      console.error(`[tts] fish-tts failed with exit code ${exitCode}`);
      return null;
    }

    console.log(`[tts] Generated speech: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error("[tts] Error generating speech:", error);
    return null;
  }
}

/**
 * Clean up a TTS audio file.
 */
export function cleanupTtsFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    console.debug("[tts] Failed to delete TTS file:", filePath);
  }
}

/**
 * Strip markdown formatting for cleaner TTS output.
 */
function stripMarkdown(text: string): string {
  return (
    text
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, "")
      // Remove inline code
      .replace(/`[^`]+`/g, "")
      // Remove bold/italic markers
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      // Remove headers
      .replace(/^#{1,6}\s+/gm, "")
      // Remove links but keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove bullet points
      .replace(/^[\s]*[-*+]\s+/gm, "")
      // Remove numbered lists prefix
      .replace(/^[\s]*\d+\.\s+/gm, "")
      // Remove extra whitespace
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Run fish-tts as subprocess.
 */
function runFishTts(
  text: string,
  voice: string,
  outputPath: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      FISH_TTS_SCRIPT,
      [text, "--voice", voice, "--output", outputPath],
      {
        timeout: 120_000, // 2 minute timeout
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[tts] fish-tts stderr: ${stderr.slice(-500)}`);
      }
      resolve(code ?? 1);
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}
