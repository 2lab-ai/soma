/**
 * Minimal .env parser for test/preload.ts — just enough to recognise what Bun's
 * .env auto-load put into process.env, so the preload can take it back out.
 * Handles `KEY=value`, `export KEY=value`, single/double quotes and trailing
 * `# comments` on unquoted values. Anything it cannot parse exactly (multi-line
 * values, `${VAR}` expansion) simply is not matched and stays in the env.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let value = m[2] ?? "";
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2)
      value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1] as string] = value;
  }
  return out;
}
