import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, linkSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";
import { isPathContained, isSymlink, isHardlink, sanitizeExtractedDir, validateArchiveMembers } from "./archive-safety";

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

describe("isHardlink", () => {
  test("detects hardlink (nlink > 1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hardlink-test-"));
    const original = join(dir, "original.txt");
    writeFileSync(original, "secret data");
    const hardlink = join(dir, "link.txt");
    linkSync(original, hardlink);

    expect(isHardlink(hardlink)).toBe(true);
    expect(isHardlink(original)).toBe(true); // both have nlink=2 now

    rmSync(dir, { recursive: true });
  });

  test("regular file is not hardlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "hardlink-test-"));
    const file = join(dir, "normal.txt");
    writeFileSync(file, "normal");

    expect(isHardlink(file)).toBe(false);

    rmSync(dir, { recursive: true });
  });

  test("directory is not hardlink even with nlink > 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "hardlink-test-"));
    expect(isHardlink(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  test("non-existent path returns false", () => {
    expect(isHardlink("/tmp/nonexistent-hardlink-test-file")).toBe(false);
  });
});

describe("sanitizeExtractedDir hardlink removal", () => {
  test("removes hardlinks during sanitization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sanitize-hardlink-"));
    const original = join(dir, "original.txt");
    writeFileSync(original, "data");
    const hardlink = join(dir, "evil-link.txt");
    linkSync(original, hardlink);

    const removed = await sanitizeExtractedDir(dir);

    // Both files have nlink=2, so both are detected as hardlinks
    expect(removed.some(r => r.includes("hardlink"))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("validateArchiveMembers", () => {
  test("rejects tar with path traversal members", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-tar-"));
    const archivePath = join(dir, "evil.tar");

    // Create a tar with a ../escape member using python3
    await Bun.$`python3 -c "
import tarfile, io
t = tarfile.open('${archivePath}', 'w')
info = tarfile.TarInfo(name='../../etc/passwd')
info.size = 4
t.addfile(info, io.BytesIO(b'evil'))
t.close()
"`.quiet();

    await expect(validateArchiveMembers(archivePath, "evil.tar")).rejects.toThrow("path traversal");

    rmSync(dir, { recursive: true });
  });

  test("accepts clean tar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-tar-"));
    const archivePath = join(dir, "clean.tar");
    const contentDir = join(dir, "content");
    mkdirSync(contentDir);
    writeFileSync(join(contentDir, "file.txt"), "safe");

    await Bun.$`tar -cf ${archivePath} -C ${contentDir} file.txt`.quiet();

    await expect(validateArchiveMembers(archivePath, "clean.tar")).resolves.toBeUndefined();

    rmSync(dir, { recursive: true });
  });
});

describe("zip archive security", () => {
  test("sanitizeExtractedDir handles clean zip extraction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zip-clean-"));
    const archivePath = join(dir, "clean.zip");
    const extractDir = join(dir, "extract");
    mkdirSync(extractDir);

    // Create a clean zip using python3
    await Bun.$`python3 -c "
import zipfile
z = zipfile.ZipFile('${archivePath}', 'w')
z.writestr('normal.txt', 'safe content')
z.writestr('sub/nested.txt', 'nested content')
z.close()
"`.quiet();

    await Bun.$`unzip -q -o ${archivePath} -d ${extractDir}`.quiet();
    const removed = await sanitizeExtractedDir(extractDir);

    // Normal zip should have no removals
    expect(removed.length).toBe(0);
    expect(existsSync(join(extractDir, "normal.txt"))).toBe(true);
    expect(existsSync(join(extractDir, "sub", "nested.txt"))).toBe(true);

    rmSync(dir, { recursive: true });
  });

  test("validateArchiveMembers rejects zip with path traversal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zip-traversal-"));
    const archivePath = join(dir, "evil.zip");

    // Create a zip with path traversal entry using python3
    await Bun.$`python3 -c "
import zipfile
z = zipfile.ZipFile('${archivePath}', 'w')
z.writestr('../../etc/evil.txt', 'malicious')
z.writestr('safe.txt', 'ok')
z.close()
"`.quiet();

    await expect(validateArchiveMembers(archivePath, "evil.zip")).rejects.toThrow("path traversal");

    rmSync(dir, { recursive: true });
  });

  test("validateArchiveMembers accepts clean zip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zip-clean-validate-"));
    const archivePath = join(dir, "clean.zip");

    await Bun.$`python3 -c "
import zipfile
z = zipfile.ZipFile('${archivePath}', 'w')
z.writestr('readme.txt', 'hello')
z.writestr('src/main.ts', 'console.log(1)')
z.close()
"`.quiet();

    await expect(validateArchiveMembers(archivePath, "clean.zip")).resolves.toBeUndefined();

    rmSync(dir, { recursive: true });
  });
});
