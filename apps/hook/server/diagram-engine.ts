/**
 * Code review's diagram engine, embedded in the compiled CLI (see
 * @plannotator/shared/diagram-engine-assets and apps/review/diagram-engine).
 *
 * `build:hook` copies the three files to apps/hook/dist/diagram-engine/. They
 * are reached through literal dynamic imports with `type: "file"`, which
 * `bun build --compile` embeds like the HTML pages and which answer only the
 * embedded file's path; the text is read from it on first need, off the
 * request path (the server's `warm()`). Measured on bun 1.3.14: a
 * `type: "text"` dynamic import of the 4.8 MB Mermaid file took ~2.4 s in a
 * compiled binary, this takes ~5 ms. On bun 1.4.4 both take ~2 ms, but Bun
 * 1.4 stores a `type: "text"` import that is not pure ASCII as UTF-16, twice
 * its size, so `type: "file"` keeps the binary ~5 MB smaller (the pages in
 * index.ts are embedded as files for the same reason). A source checkout
 * without the files keeps working: the import fails, the server advertises no engine, and
 * diagram fences show as code.
 */
import type { DiagramEngineSources } from "@plannotator/shared/diagram-engine-assets";

let pending: Promise<DiagramEngineSources | null> | null = null;

async function read(module: Promise<{ default: unknown }>): Promise<string> {
  const path = (await module).default;
  if (typeof path !== "string") throw new Error("not an embedded file");
  return Bun.file(path).text();
}

export function loadEmbeddedDiagramEngine(): Promise<DiagramEngineSources | null> {
  pending ??= (async () => {
    try {
      const [engine, mermaid, graphviz] = await Promise.all([
        // @ts-ignore - Bun import attribute for an embedded file
        read(import("../dist/diagram-engine/engine.js", { with: { type: "file" } })),
        // @ts-ignore - Bun import attribute for an embedded file
        read(import("../dist/diagram-engine/mermaid.js", { with: { type: "file" } })),
        // @ts-ignore - Bun import attribute for an embedded file
        read(import("../dist/diagram-engine/graphviz.js", { with: { type: "file" } })),
      ]);
      return { engine, mermaid, graphviz };
    } catch {
      return null;
    }
  })();
  return pending;
}
