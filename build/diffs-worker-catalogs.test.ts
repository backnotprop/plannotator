import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diffsWorkerCatalogs } from "./diffs-worker-catalogs";

const CATALOGS = ["shiki/langs", "@pierre/highlights/themes/loader", "@pierre/theming/themes"];

/** The module the plugin serves for `id` in the worker build, or null when it leaves `id` alone. */
async function stubFor(id: string): Promise<Record<string, unknown> | null> {
  const plugin = diffsWorkerCatalogs();
  const resolved = plugin.resolveId(id);
  if (resolved == null) return null;
  const code = plugin.load(resolved);
  if (code == null) throw new Error(`no module for ${resolved}`);
  const file = join(mkdtempSync(join(tmpdir(), "diffs-worker-catalog-")), "stub.mjs");
  writeFileSync(file, code);
  return (await import(file)) as Record<string, unknown>;
}

describe("diffsWorkerCatalogs", () => {
  // The worker is built with inlineDynamicImports, so every inlined module runs
  // when the worker starts: a stub that throws on import kills the pool.
  test("each catalog's stub loads, and any use of it throws", async () => {
    for (const id of CATALOGS) {
      const stub = await stubFor(id);
      expect(stub).not.toBeNull();
      for (const name of ["bundledLanguages", "themes"]) {
        const catalog = stub![name] as Record<string, unknown>;
        expect(() => catalog["typescript"]).toThrow("not bundled in Plannotator's highlight worker");
        expect(() => Object.prototype.hasOwnProperty.call(catalog, "typescript")).toThrow("not bundled");
      }
    }
  });

  test("leaves the worker's other imports alone", async () => {
    for (const id of ["shiki/core", "shiki/engine/javascript", "@pierre/highlights", "@pierre/theming", "./worker.js"]) {
      expect(await stubFor(id)).toBeNull();
    }
  });

  // If Pierre renames or drops one of these imports, the stub silently stops
  // applying and the catalogs come back into the worker (~11 MB in the review
  // app's entry chunk). Read the installed worker so a bump says so.
  test("Pierre's worker still imports each catalog it stubs", () => {
    const pkg = dirname(dirname(Bun.resolveSync("@pierre/diffs", join(import.meta.dir, "../packages/ui"))));
    const workerDir = join(pkg, "dist/worker");
    const source = readdirSync(workerDir)
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFileSync(join(workerDir, file), "utf8"))
      .join("\n");
    for (const id of CATALOGS) expect({ id, imported: source.includes(`import("${id}")`) }).toEqual({ id, imported: true });
  });
});
