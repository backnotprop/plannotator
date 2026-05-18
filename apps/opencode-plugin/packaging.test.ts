import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const appDir = import.meta.dir;

function listRuntimeTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listRuntimeTsFiles(fullPath));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      result.push(fullPath);
    }
  }
  return result;
}

describe("OpenCode package boundary", () => {
  test("does not package browser HTML assets", () => {
    const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf-8")) as { files?: string[] };
    expect(pkg.files ?? []).not.toContain("plannotator.html");
    expect(pkg.files ?? []).not.toContain("review-editor.html");
  });

  test("does not import or start Plannotator servers in runtime code", () => {
    const runtimeSource = listRuntimeTsFiles(appDir)
      .map((file) => readFileSync(file, "utf-8"))
      .join("\n");

    expect(runtimeSource).not.toMatch(/@plannotator\/server/);
    expect(runtimeSource).not.toMatch(/startPlannotatorServer|startReviewServer|startAnnotateServer/);
  });
});
