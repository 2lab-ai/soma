/**
 * BUG: on macOS `make logs` / `make errors` tailed /tmp/<name>.log and .err,
 * but the LaunchAgent installed by `make install-service` writes to
 * ~/Library/Logs/ai.2lab.<name>.{out,err}.log
 * (launchagent/install-macos-service.sh), the same file `make start` reads.
 * So on macOS both targets tailed files that nothing writes.
 *
 * The targets read the log paths from the installed plist (StandardOutPath /
 * StandardErrorPath), because the two supported install paths write different
 * files: `make install-service` → ~/Library/Logs/…, the manual plist template
 * → /tmp/soma.{log,err}.
 *
 * Runs the real Makefile targets against a scratch HOME that holds a plist and
 * fake logs, then kills the `tail -f`.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "..");
const SERVICE = "soma-makefile-logs-test";
const LABEL = `ai.2lab.${SERVICE}`;

function plist(outPath: string, errPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>StandardOutPath</key><string>${outPath}</string>
  <key>StandardErrorPath</key><string>${errPath}</string>
</dict></plist>
`;
}

/**
 * Scratch HOME with an installed plist. `layout` picks where that plist sends
 * the logs: "install-service" (~/Library/Logs/<label>.{out,err}.log, what
 * launchagent/install-macos-service.sh writes) or "template" (a custom path,
 * like the manual plist template's /tmp/soma.{log,err}).
 */
function makeScratchHome(
  layout: "install-service" | "template" = "install-service"
): string {
  // test/preload.ts already points $HOME at a per-run scratch dir.
  const home = mkdtempSync(join(process.env.HOME ?? REPO, "makefile-logs-"));
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  const logDir =
    layout === "install-service"
      ? join(home, "Library", "Logs")
      : join(home, "custom-logs");
  mkdirSync(logDir, { recursive: true });
  const outPath = join(
    logDir,
    layout === "install-service" ? `${LABEL}.out.log` : "soma.log"
  );
  const errPath = join(
    logDir,
    layout === "install-service" ? `${LABEL}.err.log` : "soma.err"
  );
  writeFileSync(
    join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    plist(outPath, errPath)
  );
  writeFileSync(outPath, "SENTINEL-OUT\n");
  writeFileSync(errPath, "SENTINEL-ERR\n");
  return home;
}

/** Run a make target until `sentinel` is printed (or 5 s pass), then kill it. */
function runUntil(target: string, home: string, sentinel: string): Promise<string> {
  return new Promise((done) => {
    const child = spawn(
      "make",
      ["-s", target, `SERVICE_NAME=${SERVICE}`, "ENV=/dev/null"],
      {
        cwd: REPO,
        env: { ...process.env, HOME: home },
        detached: true, // own process group, so the kill below also stops `tail -f`
      }
    );
    let output = "";
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        // already exited
      }
      done(output);
    };
    const timer = setTimeout(finish, 5_000);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(sentinel)) finish();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("exit", finish);
  });
}

describe("Makefile log targets on macOS", () => {
  test.skipIf(process.platform !== "darwin")(
    "make logs / make errors follow a plist that logs elsewhere (manual template)",
    async () => {
      const home = makeScratchHome("template");
      expect(await runUntil("logs", home, "SENTINEL-OUT")).toContain("SENTINEL-OUT");
      expect(await runUntil("errors", home, "SENTINEL-ERR")).toContain("SENTINEL-ERR");
    },
    25_000
  );

  test.skipIf(process.platform !== "darwin")(
    "make logs tails the LaunchAgent stdout log",
    async () => {
      const output = await runUntil("logs", makeScratchHome(), "SENTINEL-OUT");
      expect(output).toContain("SENTINEL-OUT");
    },
    15_000 // above runUntil's own 5 s cutoff, so a slow make fails on the assertion
  );

  test.skipIf(process.platform !== "darwin")(
    "make errors tails the LaunchAgent stderr log",
    async () => {
      const output = await runUntil("errors", makeScratchHome(), "SENTINEL-ERR");
      expect(output).toContain("SENTINEL-ERR");
    },
    15_000
  );
});
