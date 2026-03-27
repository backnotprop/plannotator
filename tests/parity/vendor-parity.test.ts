/**
 * Vendor Parity Test
 *
 * Ensures every `generated/` module imported by Pi extension source files
 * has a corresponding entry in vendor.sh. Prevents the class of bug where
 * a new shared module is imported but never vendored (#391 pattern).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");
const PI_DIR = join(ROOT, "apps/pi-extension");
const VENDOR_SH = join(PI_DIR, "vendor.sh");

/** Recursively collect all .ts files under a directory, excluding generated/ and node_modules/ */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "generated" || entry === "node_modules") continue;
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/** Extract module names imported from generated/ (e.g. "config" from "../generated/config.js") */
function extractGeneratedImports(filePath: string): string[] {
  const src = readFileSync(filePath, "utf-8");
  const modules: string[] = [];
  const re = /from\s+["']\.\.?\/generated\/(.+?)\.js["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    modules.push(m[1]);
  }
  return modules;
}

/** Parse vendor.sh to extract all module names from the for-loops */
function extractVendoredModules(): Set<string> {
  const src = readFileSync(VENDOR_SH, "utf-8");
  const all = new Set<string>();

  const forLoopRe = /for f in ([^;]+); do\s+src="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = forLoopRe.exec(src)) !== null) {
    const names = m[1].trim().split(/\s+/);
    const srcPath = m[2];
    // Derive the generated/ subdirectory from the source path
    let prefix = "";
    if (srcPath.includes("packages/ai/providers/")) {
      prefix = "ai/providers/";
    } else if (srcPath.includes("packages/ai/")) {
      prefix = "ai/";
    }
    for (const name of names) {
      all.add(prefix + name);
    }
  }
  return all;
}

describe("vendor parity: Pi imports ↔ vendor.sh", () => {
  const piFiles = collectTsFiles(PI_DIR);
  const vendored = extractVendoredModules();

  const allImports = new Set<string>();
  for (const file of piFiles) {
    for (const mod of extractGeneratedImports(file)) {
      allImports.add(mod);
    }
  }

  test("every generated/ import has a vendor.sh entry", () => {
    const missing = [...allImports].filter((mod) => !vendored.has(mod));
    if (missing.length > 0) {
      throw new Error(
        `Pi source files import these generated modules not in vendor.sh:\n` +
          missing.map((m) => `  - generated/${m}.js`).join("\n") +
          `\n\nAdd them to apps/pi-extension/vendor.sh`
      );
    }
  });
});
