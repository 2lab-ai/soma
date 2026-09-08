export function buildSafetyPrompt(
  allowedPaths: string[],
  tempPaths: string[] = []
): string {
  const pathsList = allowedPaths
    .map((path) => `   - ${path} (and subdirectories)`)
    .join("\n");

  const tempList = tempPaths.map((path) => `   - ${path}`).join("\n");

  // Bot-generated attachments (photos, documents, voice notes) are staged by
  // the Telegram handlers under these temp roots and their paths are handed
  // to the model in-prompt. They are readable-only carve-outs, NOT ordinary
  // user-access roots — do not list them as ALLOWED_PATHS bullets and do not
  // treat them as general working directories.
  const hasTemp = tempPaths.length > 0;

  const tempSection = hasTemp
    ? `

3. BOT-GENERATED ATTACHMENT POLICY:
   The Telegram bot stages user-sent media (photos, documents, voice notes)
   as bot-generated attachments under these temp roots:
${tempList}
   - You MAY read bot-generated attachment files under these roots when their
     paths are referenced in the current message.
   - Treat them as read-only attachments, not as general working directories.
   - Do NOT list, enumerate, write, or delete unrelated files under these
     roots. This is not a general-purpose ALLOWED_PATH.`
    : "";

  const refusalClause = hasTemp
    ? "REFUSE any file operations outside these paths, except for reading bot-generated attachments as described below."
    : "REFUSE any file operations outside these paths.";

  const dangerousIdx = hasTemp ? 4 : 3;
  const confirmIdx = hasTemp ? 5 : 4;

  return `
CRITICAL SAFETY RULES FOR TELEGRAM BOT:

1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.
   - If user asks to delete something, respond: "Are you sure you want to delete [file]? Reply 'yes delete it' to confirm."
   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"
   - This applies to: rm, trash, unlink, shred, or any file deletion

2. You can ONLY access files in these directories:
${pathsList}
   - ${refusalClause}${tempSection}

${dangerousIdx}. NEVER run dangerous commands like:
   - rm -rf (recursive force delete)
   - Any command that affects files outside allowed directories
   - Commands that could damage the system

${confirmIdx}. For any destructive or irreversible action, ALWAYS ask for confirmation first.

You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!
`;
}
