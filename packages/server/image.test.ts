/**
 * Image Validation Tests
 *
 * Run: bun test packages/server/image.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateImagePath, validateUploadExtension, UPLOAD_DIR } from "./image";
import { handleImage } from "./shared-handlers";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-image-"));
  dirs.push(dir);
  return dir;
}

describe("UPLOAD_DIR", () => {
  test("uses os.tmpdir(), not hardcoded /tmp", () => {
    // On macOS tmpdir() returns something like /var/folders/...
    // On Linux it returns /tmp
    // On Windows it returns C:\Users\...\AppData\Local\Temp
    // The key thing: it should NOT be hardcoded to /tmp/plannotator
    expect(UPLOAD_DIR).toContain("plannotator");
    expect(UPLOAD_DIR.startsWith(tmpdir())).toBe(true);
  });
});

describe("validateImagePath", () => {
  test("accepts supported extensions", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]) {
      const result = validateImagePath(`/tmp/image.${ext}`);
      expect(result.valid).toBe(true);
    }
  });

  test("rejects unsupported extensions", () => {
    expect(validateImagePath("/tmp/file.txt").valid).toBe(false);
    expect(validateImagePath("/tmp/script.js").valid).toBe(false);
    expect(validateImagePath("/tmp/page.html").valid).toBe(false);
  });

  test("rejects files with no extension", () => {
    expect(validateImagePath("/tmp/noextension").valid).toBe(false);
  });

  test("resolves path", () => {
    const result = validateImagePath("relative/image.png");
    expect(result.resolved).toMatch(/^\//); // absolute on POSIX
  });
});

describe("validateUploadExtension", () => {
  test("accepts supported extensions", () => {
    expect(validateUploadExtension("photo.png").valid).toBe(true);
    expect(validateUploadExtension("photo.jpg").valid).toBe(true);
  });

  test("rejects unsupported extensions", () => {
    const result = validateUploadExtension("file.exe");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("defaults to png when no extension", () => {
    const result = validateUploadExtension("noext");
    expect(result.valid).toBe(true);
    expect(result.ext).toBe("png");
  });
});

describe("handleImage", () => {
  test("resolves relative image paths against the session cwd before process cwd", async () => {
    const cwd = tempDir();
    const session = tempDir();
    await Bun.write(join(cwd, "mock.png"), "wrong");
    await Bun.write(join(session, "mock.png"), "right");
    const originalCwd = process.cwd();

    try {
      process.chdir(cwd);
      const response = await handleImage(new Request("http://localhost/api/image?path=mock.png"), session);
      expect(await response.text()).toBe("right");
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("does not fall back to session cwd when an explicit base is supplied", async () => {
    const base = tempDir();
    const session = tempDir();
    const cwd = tempDir();
    await Bun.write(join(session, "mock.png"), "wrong");
    await Bun.write(join(cwd, "mock.png"), "also wrong");
    const originalCwd = process.cwd();

    try {
      process.chdir(cwd);
      const response = await handleImage(
        new Request(`http://localhost/api/image?path=mock.png&base=${encodeURIComponent(base)}`),
        session,
      );

      expect(response.status).toBe(404);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("does not fall back to process cwd when the session cwd misses", async () => {
    const cwd = tempDir();
    const session = tempDir();
    await Bun.write(join(cwd, "mock.png"), "wrong");
    const originalCwd = process.cwd();

    try {
      process.chdir(cwd);
      const response = await handleImage(new Request("http://localhost/api/image?path=mock.png"), session);
      expect(response.status).toBe(404);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
