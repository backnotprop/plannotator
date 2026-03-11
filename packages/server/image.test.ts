/**
 * Image Validation Tests
 *
 * Run: bun test packages/server/image.test.ts
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { validateImagePath, validateUploadExtension, UPLOAD_DIR } from "./image";

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
