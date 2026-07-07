import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync } from "fs";

const TEST_PID_FILE = "/tmp/soma-test.pid";

afterEach(() => {
  try {
    unlinkSync(TEST_PID_FILE);
  } catch {}
});

describe("BUG soma-reentry-v2: PID lock prevents duplicate bot instances", () => {
  test("RED: acquirePidLock writes current PID to file", () => {
    // After fix: acquirePidLock() should exist and write PID
    const { acquirePidLock } = require("./pid-lock");
    acquirePidLock(TEST_PID_FILE);

    expect(existsSync(TEST_PID_FILE)).toBe(true);
    const pid = parseInt(readFileSync(TEST_PID_FILE, "utf-8").trim(), 10);
    expect(pid).toBe(process.pid);
  });

  test("RED: acquirePidLock overwrites stale PID file (dead process)", () => {
    // Write a PID that doesn't exist (99999999)
    writeFileSync(TEST_PID_FILE, "99999999");

    const { acquirePidLock } = require("./pid-lock");
    acquirePidLock(TEST_PID_FILE);

    const pid = parseInt(readFileSync(TEST_PID_FILE, "utf-8").trim(), 10);
    expect(pid).toBe(process.pid);
  });

  test("RED: releasePidLock removes PID file", () => {
    writeFileSync(TEST_PID_FILE, String(process.pid));

    const { releasePidLock } = require("./pid-lock");
    releasePidLock(TEST_PID_FILE);

    expect(existsSync(TEST_PID_FILE)).toBe(false);
  });
});
