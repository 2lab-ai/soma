import OpenAI from "openai";
import {
  OPENAI_API_KEY,
  TRANSCRIPTION_AVAILABLE,
  TRANSCRIPTION_PROMPT,
} from "../config";

let openaiClient: OpenAI | null = null;
if (OPENAI_API_KEY && TRANSCRIPTION_AVAILABLE) {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
}

const TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const FALLBACK_MODEL = "whisper-1";

export async function transcribeVoice(filePath: string): Promise<string> {
  if (!openaiClient) {
    throw new Error("OpenAI client not configured");
  }

  // H4 defense: explicit File conversion avoids BunFile lazy read edge cases
  const bunFile = Bun.file(filePath);
  const buffer = await bunFile.arrayBuffer();
  const fileSize = buffer.byteLength;
  const file = new File([buffer], "voice.ogg", { type: "audio/ogg" });

  // Diagnostic log: capture pre-call state for post-mortem analysis
  console.log(`[voice-transcribe] start: model=${TRANSCRIPTION_MODEL}, fileSize=${fileSize}, promptLen=${TRANSCRIPTION_PROMPT.length}`);

  try {
    const transcript = await openaiClient.audio.transcriptions.create({
      model: TRANSCRIPTION_MODEL,
      file: file,
      prompt: TRANSCRIPTION_PROMPT,
    });

    // H1 defense: empty transcript is valid (silence/unclear audio), not an error
    if (!transcript.text) {
      console.warn(`[voice-transcribe] empty transcript: model=${TRANSCRIPTION_MODEL}, fileSize=${fileSize}`);
    }

    return transcript.text;
  } catch (error) {
    // Structured diagnostic log for post-mortem (H2/H3 defense)
    logTranscriptionError(TRANSCRIPTION_MODEL, fileSize, error);

    // H3 defense: retry without prompt (prompt param may be rejected)
    // Also serves as H2 partial defense: different model may still work
    console.log(`[voice-transcribe] retrying with fallback: model=${FALLBACK_MODEL}, no prompt`);
    try {
      const retryFile = new File([buffer], "voice.ogg", { type: "audio/ogg" });
      const fallback = await openaiClient.audio.transcriptions.create({
        model: FALLBACK_MODEL,
        file: retryFile,
      });

      if (!fallback.text) {
        console.warn(`[voice-transcribe] empty transcript on fallback: model=${FALLBACK_MODEL}, fileSize=${fileSize}`);
      }

      return fallback.text;
    } catch (fallbackError) {
      logTranscriptionError(FALLBACK_MODEL, fileSize, fallbackError);
      // Throw the original error — it's from the primary model and more informative
      throw error;
    }
  }
}

function logTranscriptionError(model: string, fileSize: number, error: unknown): void {
  const base = { model, fileSize, promptLen: TRANSCRIPTION_PROMPT.length };

  if (error instanceof OpenAI.APIError) {
    console.error(`[voice-transcribe] API error:`, {
      ...base,
      status: error.status,
      code: error.code,
      type: error.type,
      param: error.param,
      requestID: error.requestID,
      message: error.message,
    });
  } else {
    console.error(`[voice-transcribe] unexpected error:`, {
      ...base,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}
