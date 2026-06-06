/**
 * Image Validation Tests
 *
 * Run: bun test packages/server/image.test.ts
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("accepts supported extensions within project root", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]) {
      const result = validateImagePath(`image.${ext}`);
      expect(result.valid).toBe(true);
    }
  });

  test("accepts images within UPLOAD_DIR", () => {
    const result = validateImagePath(join(UPLOAD_DIR, "test.png"));
    expect(result.valid).toBe(true);
  });

  test("rejects unsupported extensions", () => {
    expect(validateImagePath("file.txt").valid).toBe(false);
    expect(validateImagePath("script.js").valid).toBe(false);
    expect(validateImagePath("page.html").valid).toBe(false);
  });

  test("rejects files with no extension", () => {
    expect(validateImagePath("noextension").valid).toBe(false);
  });

  test("resolves path", () => {
    const result = validateImagePath("relative/image.png");
    expect(result.resolved).toMatch(/^\//); // absolute on POSIX
  });

  test("rejects path traversal outside project root", () => {
    const result = validateImagePath("/etc/passwd.png");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("outside project root");
  });

  test("rejects ../ traversal escaping project root", () => {
    const result = validateImagePath("../../../etc/secret.png");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("outside project root");
  });

  test("rejects absolute path outside project root", () => {
    const result = validateImagePath("/tmp/outside/image.png");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("outside project root");
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
