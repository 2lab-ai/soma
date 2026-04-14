/**
 * Voice transcription utility — local Cohere STT server.
 * Converts Telegram OGG/Opus → WAV 16kHz mono via ffmpeg,
 * then POSTs to the local Cohere Transcribe server.
 */

import { spawn } from "child_process";
import { unlinkSync } from "fs";
import { STT_URL, TRANSCRIPTION_PROMPT } from "../config";

/**
 * Convert OGG/Opus to WAV 16kHz mono using ffmpeg.
 * Returns path to the generated WAV file.
 */
function convertToWav(oggPath: string): Promise<string> {
  const wavPath = oggPath.replace(/\.ogg$/, ".wav");
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      ["-i", oggPath, "-ar", "16000", "-ac", "1", "-f", "wav", "-y", wavPath],
      { timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
      } else {
        resolve(wavPath);
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`ffmpeg not found or failed to start: ${err.message}`));
    });
  });
}

/**
 * Transcribe a voice file using the local Cohere STT server.
 * Flow: OGG → WAV (ffmpeg) → HTTP POST to STT server → text
 */
export async function transcribeVoice(oggPath: string): Promise<string> {
  if (!STT_URL) {
    throw new Error("STT_URL not configured");
  }

  // 1. Convert OGG → WAV 16kHz mono
  const wavPath = await convertToWav(oggPath);

  try {
    // 2. Read WAV file
    const wavFile = Bun.file(wavPath);
    const wavBuffer = await wavFile.arrayBuffer();

    console.log(
      `[voice-transcribe] start: url=${STT_URL}, wavSize=${wavBuffer.byteLength}`
    );

    // 3. POST to local Cohere STT server
    const formData = new FormData();
    formData.append(
      "file",
      new File([wavBuffer], "voice.wav", { type: "audio/wav" })
    );
    if (TRANSCRIPTION_PROMPT) {
      formData.append("prompt", TRANSCRIPTION_PROMPT);
    }

    const response = await fetch(STT_URL, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      throw new Error(
        `STT server ${response.status}: ${body.slice(0, 300)}`
      );
    }

    // 4. Parse response — expect { "text": "..." } or plain text
    const contentType = response.headers.get("content-type") || "";
    let text: string;

    if (contentType.includes("application/json")) {
      const json = (await response.json()) as Record<string, unknown>;
      // Support common response shapes: { text }, { transcription }, { result }
      text = String(json.text ?? json.transcription ?? json.result ?? "");
      console.log(
        `[voice-transcribe] response keys: ${Object.keys(json).join(",")}`
      );
    } else {
      text = await response.text();
    }

    if (!text) {
      console.warn(
        `[voice-transcribe] empty transcript: wavSize=${wavBuffer.byteLength}`
      );
    }

    return text;
  } finally {
    // Clean up WAV temp file
    try {
      unlinkSync(wavPath);
    } catch {
      // ignore
    }
  }
}
