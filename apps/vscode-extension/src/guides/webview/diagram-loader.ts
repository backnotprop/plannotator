import type * as Diagram from "./diagram";

export type { DiagramResult, MermaidCheck } from "./diagram";

let loading: Promise<typeof Diagram> | null = null;

function load(): Promise<typeof Diagram> {
  if (!loading) {
    const url = typeof document === "undefined" ? undefined : document.body?.dataset.pnDiagram;
    loading = url ? (import(/* @vite-ignore */ url) as Promise<typeof Diagram>) : Promise.reject(new Error("The diagram engine is not available here."));
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

export async function renderMermaid(source: string): Promise<Diagram.DiagramResult> {
  try {
    return await (await load()).renderMermaid(source);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err), line: null, unavailable: true };
  }
}

export async function checkMermaid(source: string): Promise<Diagram.MermaidCheck> {
  let engine: typeof Diagram;
  try {
    engine = await load();
  } catch (err) {
    return { ok: false, unavailable: true, message: err instanceof Error ? err.message : String(err) };
  }
  try {
    return await engine.checkMermaid(source);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
