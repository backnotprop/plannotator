/**
 * The Guides webviews draw Mermaid with the Guide tab's own copy of the
 * diagram engine: `dist/reader/diagram.js`, an entry of the reader's build
 * that shares its Mermaid (and ELK) chunks, loaded only when a diagram is
 * drawn. The webview bundle carries none of it. The host puts the module's
 * URL on the body (`data-pn-diagram`, an extension resource the CSP allows).
 */

import type * as Diagram from "./diagram";

export type { DiagramResult, MermaidCheck } from "./diagram";

let loading: Promise<typeof Diagram> | null = null;

function load(): Promise<typeof Diagram> {
  if (!loading) {
    const url = typeof document === "undefined" ? undefined : document.body?.dataset.pnDiagram;
    loading = url ? (import(/* @vite-ignore */ url) as Promise<typeof Diagram>) : Promise.reject(new Error("The diagram engine is not available here."));
    // A failed load is tried again next time.
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
    // The engine did not load: the diagram stays as its source.
    return { ok: false, message: err instanceof Error ? err.message : String(err), line: null, unavailable: true };
  }
}

/**
 * The builder's render check here. When the engine cannot be loaded the
 * answer is `unavailable` (this webview cannot check), never a refusal of
 * the diagram: only Mermaid's own errors refuse it.
 */
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
