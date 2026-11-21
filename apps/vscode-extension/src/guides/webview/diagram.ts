/**
 * The overview diagram, drawn with Plannotator's diagram engine
 * (`@plannotator/ui`'s `renderDiagram`: Mermaid under `securityLevel:
 * 'strict'`, its output sanitized into a node). Click bindings never reach
 * Mermaid: they are taken out of the source first and attached to the drawn
 * nodes as `data-link`, which the webview's delegated handlers act on.
 */

import { renderDiagram } from "../../../../../packages/ui/utils/diagram-render";
import { splitMermaidClicks } from "../core/adapter";

let renderSeq = 0;

function currentMode(): "light" | "dark" {
  return document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light") ? "light" : "dark";
}

/**
 * `unavailable`: the engine itself could not be loaded here (not a fault of
 * the source), so a render check says nothing about the diagram.
 */
export type DiagramResult = { ok: true; svg: SVGSVGElement } | { ok: false; message: string; line: number | null; unavailable?: boolean };

/** A render check's answer; `unavailable` when this webview could not check it (no engine). */
export type MermaidCheck = { ok: boolean; message?: string; line?: number; unavailable?: boolean };

export async function renderMermaid(source: string): Promise<DiagramResult> {
  const { source: clean, clicks } = splitMermaidClicks(source);
  const id = `pn-guide-diagram-${++renderSeq}`;
  const result = await renderDiagram("mermaid", id, clean, { colorTheme: "vscode", mode: currentMode() });
  if (!result.ok) return { ok: false, message: result.message, line: result.line, ...(result.runtimeUnavailable && { unavailable: true }) };
  const svg = result.svgNode;
  // An agent's diagram never needs pictures: a label's <img> or an svg <image> is dropped,
  // so nothing in a guide fetches from the network (the webview's CSP blocks it too).
  for (const el of Array.from(svg.querySelectorAll("img, image"))) el.remove();
  // Labels are agent text: no element of the drawing may carry the attributes the webview acts
  // on (data-link, data-external, data-popover-*) except the click links attached below.
  for (const el of [svg, ...Array.from(svg.querySelectorAll("*"))]) {
    for (const name of el.getAttributeNames()) if (/^data-(link|external|popover)/i.test(name)) el.removeAttribute(name);
  }
  for (const [nodeId, link] of clicks) {
    const el = findNode(svg, nodeId);
    if (!el) continue;
    el.setAttribute("data-link", link);
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "link");
    el.classList.add("pn-diagram-link");
  }
  return { ok: true, svg };
}

function findNode(svg: SVGSVGElement, nodeId: string): Element | null {
  const esc = CSS.escape(nodeId);
  return (
    svg.querySelector(`g.node[data-id="${esc}"]`) ??
    svg.querySelector(`[data-id="${esc}"]`) ??
    Array.from(svg.querySelectorAll("g.node, g[id]")).find((g) => new RegExp(`(^|-)${escapeRe(nodeId)}-\\d+$`).test(g.id)) ??
    null
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The render check the builder asks for (SPEC 4.4): the same engine, off screen. */
export async function checkMermaid(source: string): Promise<MermaidCheck> {
  try {
    const result = await renderMermaid(source);
    if (result.ok) return { ok: true };
    if (result.unavailable) return { ok: false, unavailable: true, message: result.message };
    return { ok: false, message: result.message, ...(result.line !== null && { line: result.line }) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
