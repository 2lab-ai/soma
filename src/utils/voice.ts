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

export async function transcribeVoice(filePath: string): Promise<string> {
  if (!openaiClient) {
    throw new Error("OpenAI client not configured");
  }

  const buffer = await Bun.file(filePath).arrayBuffer();
  const file = new File([buffer], "voice.ogg", { type: "audio/ogg" });
  const transcript = await openaiClient.audio.transcriptions.create({
    model: "gpt-4o-transcribe",
    file: file,
    prompt: TRANSCRIPTION_PROMPT,
  });
  return transcript.text;
}
