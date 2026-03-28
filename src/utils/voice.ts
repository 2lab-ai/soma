import OpenAI from "openai";
import {
  OPENAI_API_KEY,
  TRANSCRIPTION_AVAILABLE,
  TRANSCRIPTION_PROMPT,
  COHERE_STT_URL,
} from "../config";

let openaiClient: OpenAI | null = null;
if (OPENAI_API_KEY && TRANSCRIPTION_AVAILABLE) {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
}

/**
 * Transcribe via local Cohere STT API server.
 * Falls back to null if server is unavailable.
 */
async function transcribeWithCohere(
  filePath: string,
  language: string = "ko"
): Promise<string | null> {
  if (!COHERE_STT_URL) return null;

  try {
    const file = Bun.file(filePath);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("language", language);

    const response = await fetch(`${COHERE_STT_URL}/v1/audio/transcriptions`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(60_000), // 60s timeout
    });

    if (!response.ok) {
      console.warn(
        `[voice] Cohere STT returned ${response.status}: ${await response.text()}`
      );
      return null;
    }

    const data = (await response.json()) as { text?: string };
    if (data.text) {
      console.log(
        `[voice] Cohere STT transcribed: "${data.text.slice(0, 80)}..."`
      );
      return data.text;
    }
    return null;
  } catch (error) {
    console.warn("[voice] Cohere STT unavailable, falling back:", error);
    return null;
  }
}

/**
 * Transcribe via OpenAI API (gpt-4o-transcribe).
 */
async function transcribeWithOpenAI(
  filePath: string
): Promise<string | null> {
  if (!openaiClient) return null;

  try {
    const file = Bun.file(filePath);
    const transcript = await openaiClient.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: file,
      prompt: TRANSCRIPTION_PROMPT,
    });
    return transcript.text;
  } catch (error) {
    console.error("[voice] OpenAI transcription failed:", error);
    return null;
  }
}

/**
 * Transcribe voice file. Strategy:
 * 1. Try local Cohere STT API (free, fast, private)
 * 2. Fallback to OpenAI gpt-4o-transcribe
 */
export async function transcribeVoice(filePath: string): Promise<string | null> {
  // Try Cohere first (local, free)
  const cohereResult = await transcribeWithCohere(filePath);
  if (cohereResult) return cohereResult;

  // Fallback to OpenAI
  if (openaiClient) {
    console.log("[voice] Falling back to OpenAI transcription");
    return transcribeWithOpenAI(filePath);
  }

  console.warn("[voice] No transcription backend available");
  return null;
}
