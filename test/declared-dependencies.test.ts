/**
 * Every package that production code imports must be declared in
 * package.json "dependencies".
 *
 * BUG: src/app/telegram-bot.ts imports "bottleneck", which was installed only
 * transitively through @grammyjs/transformer-throttler. A dedupe or an
 * upstream release could drop it from node_modules and break startup.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { builtinModules } from "module";
import { join, relative, resolve } from "path";

const REPO = resolve(import.meta.dir, "..");
const ROOTS = ["src", "mcp-servers", "scripts"];

function productionSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...productionSources(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      files.push(path);
  }
  return files;
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function isBuiltin(name: string): boolean {
  return (
    name.startsWith("node:") ||
    name === "bun" ||
    name.startsWith("bun:") ||
    builtinModules.includes(name)
  );
}

test("every package imported by production code is a declared dependency", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8"));
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);

  const undeclared: string[] = [];
  const importPattern = /\b(?:from|import)\s+["']([^"'./][^"']*)["']/g;
  for (const root of ROOTS) {
    for (const file of productionSources(join(REPO, root))) {
      const source = readFileSync(file, "utf-8");
      for (const match of source.matchAll(importPattern)) {
        const name = packageName(match[1]!);
        if (!isBuiltin(name) && !declared.has(name)) {
          undeclared.push(`${name} (${relative(REPO, file)})`);
        }
      }
    }
  }

  expect(undeclared).toEqual([]);
});
