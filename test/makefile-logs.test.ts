/**
 * BUG: on macOS `make logs` / `make errors` tailed /tmp/<name>.log and .err,
 * but the LaunchAgent installed by `make install-service` writes to
 * ~/Library/Logs/ai.2lab.<name>.{out,err}.log
 * (launchagent/install-macos-service.sh), the same file `make start` reads.
 * So on macOS both targets tailed files that nothing writes.
 *
 * Runs the real Makefile targets against a scratch HOME that holds a fake
 * plist and fake LaunchAgent logs, then kills the `tail -f`.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "..");
const SERVICE = "soma-makefile-logs-test";
const LABEL = `ai.2lab.${SERVICE}`;

function makeScratchHome(): string {
  // test/preload.ts already points $HOME at a per-run scratch dir.
  const home = mkdtempSync(join(process.env.HOME ?? REPO, "makefile-logs-"));
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(home, "Library", "Logs"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", `${LABEL}.plist`), "");
  writeFileSync(join(home, "Library", "Logs", `${LABEL}.out.log`), "SENTINEL-OUT\n");
  writeFileSync(join(home, "Library", "Logs", `${LABEL}.err.log`), "SENTINEL-ERR\n");
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
