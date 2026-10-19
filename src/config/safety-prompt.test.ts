import { describe, expect, test } from "bun:test";
import { buildSafetyPrompt } from "./safety-prompt";
import { ALLOWED_PATHS, SAFETY_PROMPT, TEMP_DIR } from "./index";
import { resolveTempDir } from "./env";

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

  test("BUG agi-2ry: prompt distinguishes bot temp attachment root from ALLOWED_PATHS", () => {
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
    //    src/core/session/query-runtime.ts `checkToolInputSafety`).
    expect(prompt).not.toContain("/private/tmp/");
    expect(prompt).not.toContain("/var/folders/");

    // 4) The blanket "REFUSE any file operations outside these paths" line
    //    must be qualified so that bot-generated temp attachments are not
    //    swept into the refusal.
    const blanketRefusal = /REFUSE any file operations outside these paths\s*$/m;
    expect(prompt).not.toMatch(blanketRefusal);
  });
});

// Regression: agi-2ry (exported wiring)
//
// buildSafetyPrompt is only the shape; the exported SAFETY_PROMPT is what the
// live session.ts hands to the model (src/core/session/session.ts:862). The
// shape test above is worthless if config/index.ts wires it with the wrong
// input — e.g. passing TEMP_PATHS (["/tmp/","/private/tmp/","/var/folders/"])
// instead of [TEMP_DIR] would silently re-broaden the model-facing carve-out.
// Assert the actual exported string here.
describe("SAFETY_PROMPT (exported wiring)", () => {
  test("BUG agi-2ry: advertises /tmp/soma as the sole attachment root, hides runtime-compat roots", () => {
    // Bot-generated attachment root that the Telegram handlers stage under
    // must appear. (test/preload.ts points TEMP_DIR at scratch; production is
    // /tmp/soma — pinned by the resolveTempDir test below.)
    expect(SAFETY_PROMPT).toContain(TEMP_DIR);

    // Runtime-compat siblings (executable-layer only) MUST NOT leak into the
    // model-facing prompt. The user-access roots themselves may legitimately
    // live under those prefixes (test/preload.ts realpaths WORKING_DIR, so a
    // checkout under /tmp yields /private/tmp/...), so mask them first.
    const compatPrefixed = [...ALLOWED_PATHS, TEMP_DIR].filter(
      (root) => root.startsWith("/private/tmp/") || root.startsWith("/var/folders/")
    );
    const withoutAllowedRoots = compatPrefixed.reduce(
      (prompt, root) => prompt.split(root).join("<ALLOWED_ROOT>"),
      SAFETY_PROMPT
    );
    expect(withoutAllowedRoots).not.toContain("/private/tmp");
    expect(withoutAllowedRoots).not.toContain("/var/folders");

    // Attachment policy must explicitly narrow reads to attachments called
    // out in the current message and mark them read-only. Without both, the
    // carve-out drifts back into "general working directory" territory.
    expect(SAFETY_PROMPT).toContain("referenced in the current message");
    expect(SAFETY_PROMPT).toContain("read-only");
  });
});

describe("resolveTempDir (attachment staging root)", () => {
  test("is /tmp/soma in production, whatever SOMA_TEMP_DIR says", () => {
    expect(resolveTempDir({})).toBe("/tmp/soma");
    expect(resolveTempDir({ NODE_ENV: "production", SOMA_TEMP_DIR: "/elsewhere" })).toBe("/tmp/soma");
  });

  test("honours SOMA_TEMP_DIR only under bun test (NODE_ENV=test)", () => {
    expect(resolveTempDir({ NODE_ENV: "test", SOMA_TEMP_DIR: "/scratch/attachments" })).toBe(
      "/scratch/attachments"
    );
    expect(resolveTempDir({ NODE_ENV: "test", SOMA_TEMP_DIR: "  " })).toBe("/tmp/soma");
  });
});
