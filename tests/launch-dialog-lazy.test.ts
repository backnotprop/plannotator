/**
 * The launch dialog adds nothing to a page's first paint: its component is loaded only when a claim says it shows
 * (packages/ui/components/LaunchAnnouncement.tsx), so no module may import it statically. A static import anywhere in
 * the apps' graph would put it in the Inbox's entry chunk and in every page's startup script.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const sources = execFileSync("git", ["ls-files", "packages", "apps"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((file) => /\.(tsx?|jsx?)$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.endsWith("components/LaunchDialog.tsx"));

describe("the launch dialog loads on demand", () => {
  test("no module imports LaunchDialog statically (types and import() only)", () => {
    const wrong: string[] = [];
    for (const file of sources) {
      const text = readFileSync(resolve(root, file), "utf8");
      if (!text.includes("LaunchDialog")) continue;
      for (const line of text.split("\n")) {
        if (/^\s*import\s+(?!type\b)[^;]*from\s+['"][^'"]*\/LaunchDialog['"]/.test(line) || /^\s*export\s+[^;]*from\s+['"][^'"]*\/LaunchDialog['"]/.test(line)) wrong.push(`${file}: ${line.trim()}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("the host loads it through import()", () => {
    expect(readFileSync(resolve(root, "packages/ui/components/LaunchAnnouncement.tsx"), "utf8")).toMatch(/import\(['"]\.\/LaunchDialog['"]\)/);
  });
});
