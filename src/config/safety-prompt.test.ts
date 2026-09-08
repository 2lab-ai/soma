import { describe, expect, test } from "bun:test";
import { buildSafetyPrompt } from "./safety-prompt";

// Regression: agi-2ry
//
// Telegram media handlers (src/handlers/photo.ts:61, src/handlers/document.ts:126/132,
// src/handlers/voice.ts:104) write bot-generated attachments under a single
// staging root TEMP_DIR=/tmp/soma and reference those paths in the prompt.
// src/security.ts:98-103 additionally permits broader runtime-compat roots
// (TEMP_PATHS = ["/tmp/", "/private/tmp/", "/var/folders/"]) at the
// isPathAllowed layer, but the *safety prompt* the model reads must NOT
// advertise those broader roots — they are executable-layer compatibility,
// not model-facing policy. Advertising them would over-broaden the read
// carve-out relative to what the bot actually creates.
//
// Desired contract: buildSafetyPrompt must distinguish ordinary user-access
// roots (ALLOWED_PATHS) from the bot's own attachment staging root
// (TEMP_DIR), permit reading bot-generated attachments under TEMP_DIR, and
// NOT list TEMP_DIR as an ordinary ALLOWED_PATH.
describe("buildSafetyPrompt (agi-2ry telegram temp-policy)", () => {
  const ALLOWED = ["/Users/bot/Documents", "/Users/bot/Downloads"];
  const TEMP_DIR = "/tmp/soma";
  const TEMP = [TEMP_DIR];

  test("agi-2ry: prompt distinguishes bot temp attachment root from ALLOWED_PATHS", () => {
    const prompt = buildSafetyPrompt(ALLOWED, TEMP);

    // 1) Temp attachment policy must be explicitly stated (bot-generated
    //    files under TEMP_DIR are readable). Match trailing-slash-safe:
    //    the staging root must appear either bare or with a trailing "/".
    expect(prompt).toMatch(/tmp|attachment|bot-generated/i);
    for (const tempPath of TEMP) {
      const escaped = tempPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(prompt).toMatch(new RegExp(`${escaped}/?`));
    }

    // 2) TEMP_DIR must NOT be listed as an ordinary ALLOWED_PATHS bullet
    //    (it's a separate class: readable bot-generated attachments, not a
    //    general user-access root).
    const allowedBulletLine = (p: string) => `- ${p} (and subdirectories)`;
    for (const tempPath of TEMP) {
      expect(prompt).not.toContain(allowedBulletLine(tempPath));
    }

    // 3) Broader runtime-compat roots MUST NOT leak into the model-facing
    //    prompt — those are executable-layer only (src/security.ts:98-103,
    //    core/session/query-runtime.ts:355-358).
    expect(prompt).not.toContain("/private/tmp/");
    expect(prompt).not.toContain("/var/folders/");

    // 4) The blanket "REFUSE any file operations outside these paths" line
    //    must be qualified so that bot-generated temp attachments are not
    //    swept into the refusal.
    const blanketRefusal = /REFUSE any file operations outside these paths\s*$/m;
    expect(prompt).not.toMatch(blanketRefusal);
  });
});
