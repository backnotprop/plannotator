import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const appDir = import.meta.dir;

describe("Pi package boundary", () => {
  test("does not ship the mirrored Node server implementation", () => {
    expect(existsSync(path.join(appDir, "server.ts"))).toBe(false);
    expect(existsSync(path.join(appDir, "server"))).toBe(false);
  });

  test("does not package browser HTML assets or server folders", () => {
    const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf-8")) as { files?: string[] };
    const files = pkg.files ?? [];

    expect(files).not.toContain("server.ts");
    expect(files).not.toContain("server/");
    expect(files).not.toContain("plannotator.html");
    expect(files).not.toContain("review-editor.html");
  });

  test("does not keep generated AI/server payloads", () => {
    expect(existsSync(path.join(appDir, "generated", "ai"))).toBe(false);
    expect(existsSync(path.join(appDir, "generated", "agent-review-message.ts"))).toBe(false);
    expect(existsSync(path.join(appDir, "generated", "tour-review.ts"))).toBe(false);
  });
});
