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
