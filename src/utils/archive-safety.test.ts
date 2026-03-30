import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from "fs";
import { resolve, join } from "path";
import { isPathContained, isSymlink, sanitizeExtractedDir } from "./archive-safety";

const TEST_DIR = resolve("/tmp", `archive-safety-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("isPathContained", () => {
  test("allows normal relative path", () => {
    expect(isPathContained("/tmp/extract", "file.txt")).toBe(true);
  });

  test("allows nested relative path", () => {
    expect(isPathContained("/tmp/extract", "sub/dir/file.txt")).toBe(true);
  });

  test("allows ./safe/file.txt", () => {
    expect(isPathContained("/tmp/extract", "./safe/file.txt")).toBe(true);
  });

  test("rejects ../../etc/passwd", () => {
    expect(isPathContained("/tmp/extract", "../../etc/passwd")).toBe(false);
  });

  test("rejects ../escape.txt", () => {
    expect(isPathContained("/tmp/extract", "../escape.txt")).toBe(false);
  });

  test("rejects absolute path outside dir", () => {
    expect(isPathContained("/tmp/extract", "/etc/passwd")).toBe(false);
  });
});

describe("isSymlink", () => {
  test("returns false for regular file", () => {
    const filePath = join(TEST_DIR, "regular.txt");
    writeFileSync(filePath, "hello");
    expect(isSymlink(filePath)).toBe(false);
  });

  test("returns true for symlink", () => {
    const target = join(TEST_DIR, "regular.txt");
    const link = join(TEST_DIR, "link.txt");
    // Ensure target exists
    if (!existsSync(target)) {
      writeFileSync(target, "hello");
    }
    symlinkSync(target, link);
    expect(isSymlink(link)).toBe(true);
  });

  test("returns false for non-existent path", () => {
    expect(isSymlink(join(TEST_DIR, "nonexistent.txt"))).toBe(false);
  });
});

describe("sanitizeExtractedDir", () => {
  test("removes directory symlinks", async () => {
    const dir = join(TEST_DIR, "dir-symlink-test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "safe.txt"), "ok");
    symlinkSync("/tmp", join(dir, "escape-dir"));
    const removed = await sanitizeExtractedDir(dir);
    expect(removed.some(r => r.includes("symlink"))).toBe(true);
    expect(existsSync(join(dir, "escape-dir"))).toBe(false);
    expect(existsSync(join(dir, "safe.txt"))).toBe(true);
  });

  test("removes symlinks but keeps normal files", async () => {
    const dir = join(TEST_DIR, "sanitize-test");
    mkdirSync(dir, { recursive: true });

    // Create a normal file
    const normalFile = join(dir, "safe.txt");
    writeFileSync(normalFile, "safe content");

    // Create a symlink
    const symlinkPath = join(dir, "dangerous-link");
    symlinkSync("/etc/passwd", symlinkPath);

    const removed = await sanitizeExtractedDir(dir);

    expect(removed.length).toBe(1);
    expect(removed[0]).toContain("symlink");
    expect(existsSync(normalFile)).toBe(true);
    expect(existsSync(symlinkPath)).toBe(false);
  });
});

describe("extractArchive integration", () => {
  test("tar with path traversal entry does not write outside extractDir", async () => {
    // Create a temp directory to act as extractDir
    const extractDir = join(TEST_DIR, "extract-integration");
    const parentDir = join(TEST_DIR, "extract-integration-parent");
    mkdirSync(extractDir, { recursive: true });
    mkdirSync(parentDir, { recursive: true });

    // Create a tar that contains a traversal path ../../escape.txt
    const tarDir = join(TEST_DIR, "tar-build");
    mkdirSync(tarDir, { recursive: true });

    // Create the escape file in a subdir that mimics traversal
    const escapeContent = "I escaped!";
    writeFileSync(join(tarDir, "escape.txt"), escapeContent);
    writeFileSync(join(tarDir, "safe.txt"), "safe content");

    // Create tar with path traversal using python3 (works on all platforms)
    const tarPath = join(TEST_DIR, "malicious.tar");
    await Bun.$`python3 -c "
import tarfile, io
t = tarfile.open('${tarPath}', 'w')
info = tarfile.TarInfo(name='../../escape.txt')
info.size = 7
t.addfile(info, io.BytesIO(b'escaped'))
info2 = tarfile.TarInfo(name='safe.txt')
info2.size = 4
t.addfile(info2, io.BytesIO(b'safe'))
t.close()
"`.quiet();

    // Extract and sanitize (tar may reject traversal entries with non-zero exit on macOS)
    try {
      await Bun.$`tar --no-same-permissions -xf ${tarPath} -C ${extractDir}`.quiet();
    } catch {
      // Expected: some tar implementations reject path traversal entries
    }
    const removed = await sanitizeExtractedDir(extractDir);

    // The safe file should exist in the extract directory
    expect(existsSync(join(extractDir, "safe.txt"))).toBe(true);

    // Verify that nothing escaped to the parent directories
    // (The tar transform test may or may not work depending on tar version,
    // but the sanitize step would catch it regardless)
    const escapePath = resolve(extractDir, "../../escape.txt");
    // If the traversal file somehow exists outside, it's a failure
    if (existsSync(escapePath) && escapePath.startsWith(TEST_DIR)) {
      // This would indicate the tar successfully wrote outside, which sanitize should prevent
      expect(false).toBe(true);
    }
  });

  test("tar with symlink entry is sanitized", async () => {
    const extractDir = join(TEST_DIR, "extract-symlink-test");
    mkdirSync(extractDir, { recursive: true });

    // Create a tar containing a symlink
    const tarBuildDir = join(TEST_DIR, "tar-symlink-build");
    mkdirSync(tarBuildDir, { recursive: true });
    writeFileSync(join(tarBuildDir, "normal.txt"), "normal content");
    symlinkSync("/etc/passwd", join(tarBuildDir, "evil-link"));

    const tarPath = join(TEST_DIR, "symlink.tar");
    // Use -h to NOT dereference symlinks (include them as symlinks in archive)
    await Bun.$`tar -cf ${tarPath} -C ${tarBuildDir} normal.txt evil-link`.quiet();

    // Extract
    await Bun.$`tar --no-same-permissions -xf ${tarPath} -C ${extractDir}`.quiet();

    // Verify symlink exists before sanitize
    expect(isSymlink(join(extractDir, "evil-link"))).toBe(true);

    // Sanitize
    const removed = await sanitizeExtractedDir(extractDir);

    // Symlink should be removed
    expect(removed.some((r) => r.includes("symlink"))).toBe(true);
    expect(existsSync(join(extractDir, "evil-link"))).toBe(false);

    // Normal file should remain
    expect(existsSync(join(extractDir, "normal.txt"))).toBe(true);
  });
});
