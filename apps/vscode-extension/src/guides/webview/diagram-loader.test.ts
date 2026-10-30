/**
 * The webviews draw Mermaid with the reader build's `diagram.js`, imported
 * from the URL the host puts on the body; without one, a diagram stays as its
 * source (a failure, never a throw).
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const hasDom = typeof document !== "undefined";
const dir = mkdtempSync(join(tmpdir(), "pn-diagram-loader-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  if (hasDom) delete document.body.dataset.pnDiagram;
});

describe.skipIf(!hasDom)("the webviews' diagram engine, loaded when a diagram is drawn", () => {
  it("is imported from the host's URL, once", async () => {
    const mod = join(dir, "diagram.mjs");
    writeFileSync(mod, `globalThis.__loads = (globalThis.__loads ?? 0) + 1;
export async function renderMermaid(source) { return { ok: false, message: "drawn " + source, line: null }; }
export async function checkMermaid(source) { return { ok: true }; }`);
    document.body.dataset.pnDiagram = pathToFileURL(mod).href;
    const { renderMermaid, checkMermaid } = await import("./diagram-loader");
    expect(await renderMermaid("graph TD; A-->B")).toEqual({ ok: false, message: "drawn graph TD; A-->B", line: null });
    expect(await checkMermaid("graph TD; A-->B")).toEqual({ ok: true });
    expect((globalThis as { __loads?: number }).__loads).toBe(1);
  });
});

describe.skipIf(!hasDom)("without the engine", () => {
  it("a diagram is a failure, not a throw; the render check says it could not check (never a refusal)", async () => {
    // A fresh copy of the module (no cached load).
    const fresh = (await import(`./diagram-loader?fresh=${Date.now()}`)) as typeof import("./diagram-loader");
    const r = await fresh.renderMermaid("graph TD; A-->B");
    expect(r).toMatchObject({ ok: false, unavailable: true });
    expect(await fresh.checkMermaid("x")).toMatchObject({ ok: false, unavailable: true });
  });

  it("an engine URL that does not import is not available either; the engine's own error is a refusal", async () => {
    // A folder of its own: Bun keeps a folder's listing from its first import.
    const own = mkdtempSync(join(dir, "erroring-"));
    const engine = join(own, "erroring.mjs");
    writeFileSync(engine, `export async function renderMermaid() { return { ok: false, message: "x", line: null }; }
export async function checkMermaid() { return { ok: false, message: "Parse error on line 2", line: 2 }; }`);
    document.body.dataset.pnDiagram = pathToFileURL(join(dir, "missing.mjs")).href;
    const missing = (await import(`./diagram-loader?missing=${Date.now()}`)) as typeof import("./diagram-loader");
    expect(await missing.checkMermaid("graph TD; A-->B")).toMatchObject({ ok: false, unavailable: true });
    document.body.dataset.pnDiagram = pathToFileURL(engine).href;
    const real = (await import(`./diagram-loader?erroring=${Date.now()}`)) as typeof import("./diagram-loader");
    expect(await real.checkMermaid("graph TD; A-->")).toEqual({ ok: false, message: "Parse error on line 2", line: 2 });
  });
});
