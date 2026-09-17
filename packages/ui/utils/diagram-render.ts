/**
 * The renderer slot: ONE seam between "a diagram kind" and "the engine that
 * turns its source into an svg". `renderDiagram(kind, renderId, source,
 * theme)` looks the kind up in a per-kind map (`mermaid` through the
 * runtime slot in `./mermaid`, `graphviz` through the one in `./graphviz`);
 * the entry loads its engine lazily and hands back the sanitized svg NODE
 * plus the finder that knows that engine's id grammar (`diagramFinder(kind)`
 * hands the viewer the same finder for the pointer and the anchors). A later
 * engine is one entry here behind a lazy import, one finder and tests over a
 * captured svg; nothing in the viewer, the source pane or the comment UI
 * changes.
 *
 * Errors are values: a source that does not parse resolves to
 * `{ ok: false, message, line, runtimeUnavailable: false }`, never a throw,
 * so the canvas keeps the last good render dimmed under the strip. A
 * runtime that could not be LOADED (a chunking host's fetch) resolves with
 * `runtimeUnavailable: true`, which is the one failure a Retry can change:
 * the entry re-attempts the load once after the slot's retry delay before
 * giving up, and the block's Retry re-runs the render with a fresh import.
 *
 * Security: Mermaid runs under MERMAID_CONFIG with `securityLevel: 'strict'`
 * (pinned by components/MermaidBlock.test.ts). The svg it emits is the
 * runtime's output, sanitized by Mermaid's own DOMPurify pass;
 * `sanitizeDiagramSvg` is the belt over that boundary, and it hands the
 * viewer a NODE, never markup: DOMPurify parses the string under the svg
 * profile and returns a DOM fragment, the post-pass walks that fragment, and
 * the canvas mounts the element with `replaceChildren`. No html string
 * crosses into the app DOM anywhere in the viewer. What the pass removes: no
 * script, no event handler attribute, no javascript: or data: reference
 * survives it, and no `<a>` keeps an href: under strict Mermaid disables
 * click CALLBACKS but a `click A "https://..."` binding still wraps the node
 * in an svg `<a href>`, which would turn the pinpoint click on that node
 * into a navigation. The canvas owns every click.
 */
import DOMPurify from 'dompurify';
import type { DiagramKind } from '@plannotator/core/diagram-anchor';
import { MERMAID_FINDER, type DiagramFinder } from './diagram-anchor';
import { GRAPHVIZ_FINDER } from './diagram-anchor-graphviz';
import { getGraphvizRetryDelayMs, loadGraphvizRuntime, type GraphvizRuntime } from './graphviz';
import { loadMathRenderer } from './math';
import { getMermaidRetryDelayMs, loadMermaidRuntime } from './mermaid';
import { hasMermaidMath } from './mermaid-math-slot';
import { applyMermaidTheme, mermaidThemeKey, type MermaidThemeMode } from './mermaidTheme';

export type { DiagramKind } from '@plannotator/core/diagram-anchor';

type Mermaid = Awaited<ReturnType<typeof loadMermaidRuntime>>;

/**
 * The (palette, mode) a render is for: the same pair `useTheme()` resolves
 * for code fences. The mermaid entry passes it to `applyMermaidTheme`, which
 * runs the global `initialize` once per key; the graphviz entry recolors its
 * defaults onto CSS tokens and needs neither. A host without ThemeProvider
 * passes any palette id with the mode it renders in.
 */
export interface DiagramTheme {
  readonly colorTheme: string;
  readonly mode: MermaidThemeMode;
}

export type DiagramRenderError = {
  readonly ok: false;
  readonly message: string;
  readonly line: number | null;
  /** The engine could not be loaded (as opposed to the source not
   * parsing): the one failure a Retry can change. */
  readonly runtimeUnavailable: boolean;
};

export type DiagramRenderResult =
  | {
      readonly ok: true;
      /** The sanitized svg root, ready to mount. The viewer never holds
       * the markup: see the header. */
      readonly svgNode: SVGSVGElement;
      readonly findTarget: DiagramFinder['findTarget'];
    }
  | DiagramRenderError;

interface DiagramRenderer {
  render(renderId: string, source: string, theme: DiagramTheme): Promise<DiagramRenderResult>;
  readonly finder: DiagramFinder;
}

/** Elements that never belong in a rendered diagram. DOMPurify's profiles
 * already drop every one of them; the sweep below is the belt that does not
 * depend on which profile a later config edit turns on. */
const FORBIDDEN_ELEMENTS = 'script, iframe, object, embed, link, meta';

/**
 * The belt over the engine's output (see the header). DOMPurify parses the
 * string under the svg, svg-filter and html profiles and hands back a
 * detached fragment, so nothing executes and no markup reaches the app DOM.
 * `foreignobject` and its html children are added back the way Mermaid's
 * own pass adds them (the same ADD_TAGS, ADD_ATTR and
 * HTML_INTEGRATION_POINTS entries); without them every html label in the
 * diagram would be dropped. The walk afterwards closes what DOMPurify leaves
 * open for an svg: an `<a href>` around a node, and a `data:` reference on
 * an `<image>`.
 *
 * Returns the sanitized svg root, or null when the string carries no svg or
 * there is no document to parse it with.
 */
export function sanitizeDiagramSvg(svg: string): SVGSVGElement | null {
  const root = parseSvg(svg);
  if (root === null) return null;
  scrubDiagramSvg(root);
  return root;
}

/**
 * Step one of the sanitizer: DOMPurify parses the markup under the svg,
 * svg-filter and html profiles and hands back a detached fragment; the svg
 * root is adopted into the page's document so the node the canvas mounts
 * belongs to it. Null when the markup carries no svg root, when there is no
 * document, or when the fragment cannot be adopted.
 */
export function parseDiagramSvg(svg: string): SVGSVGElement | null {
  if (typeof document === 'undefined') return null;
  const fragment = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignobject'],
    ADD_ATTR: ['dominant-baseline'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    RETURN_DOM_FRAGMENT: true,
  });
  const root = fragment.querySelector('svg');
  if (root === null) return null;
  try {
    return document.adoptNode(root) as SVGSVGElement;
  } catch {
    return null;
  }
}

/**
 * Step two, in place on the tree that is about to be mounted: the belt that
 * does not depend on which DOMPurify profile a later config edit turns on.
 * Forbidden elements go, every `<a>` loses its target (svg `<a>` from a
 * click binding, `<a>` in an html label alike — the element stays so the
 * label text survives), every `on*` attribute goes, and a reference
 * attribute keeps only a fragment or an http(s) URL.
 */
export function scrubDiagramSvg(root: SVGSVGElement): void {
  for (const el of Array.from(root.querySelectorAll(FORBIDDEN_ELEMENTS))) el.remove();
  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    anchor.removeAttribute('href');
    anchor.removeAttribute('xlink:href');
  }
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    scrubAttributes(node as Element);
  }
  scrubAttributes(root);
}

function scrubAttributes(el: Element): void {
  for (const attribute of Array.from(el.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value.trim().toLowerCase();
    if (name.startsWith('on')) {
      el.removeAttribute(attribute.name);
      continue;
    }
    if (
      (name === 'href' || name === 'xlink:href' || name === 'src') &&
      !value.startsWith('#') &&
      !value.startsWith('http://') &&
      !value.startsWith('https://') &&
      value !== ''
    ) {
      el.removeAttribute(attribute.name);
    }
  }
}

/** The attribute a widened edge hit path carries; the canvas maps a pointer
 * event on one back to the visible edge beside it. */
export const DIAGRAM_HIT_ATTR = 'data-diagram-hit';
/** The invisible stroke width of an edge hit path. A rendered edge is a 1–2
 * px stroke that the pointer can only catch at random spots (owner
 * feedback); 14 px is a comfortable target without swallowing its
 * neighbours. */
export const EDGE_HIT_STROKE_WIDTH = 14;

/** Every edge element an engine draws: Mermaid's edge paths (flowchart,
 * state transitions, class relations, ER relationship lines) and the
 * sequence diagram's message lines; Graphviz's edge paths. */
const EDGE_SELECTOR = [
  'g.edgePaths > path',
  'path.flowchart-link',
  'path.transition',
  'path.relation',
  'path.relationshipLine',
  'line.messageLine0',
  'line.messageLine1',
  'path.messageLine0',
  'path.messageLine1',
  'g.edge > path',
].join(', ');

/**
 * Give every edge an invisible hit target: a clone of the visible stroke
 * (same geometry, no id, no class, no markers) inserted right AFTER it in
 * the same group, `stroke: transparent`, `fill: none`, `stroke-width: 14`,
 * `pointer-events: stroke`. The visible edge keeps its id, so the finders
 * resolve exactly as before (Graphviz targets the `g.edge` group, which now
 * contains both; Mermaid targets the path, and the canvas maps a hit on
 * the clone to its previous sibling). Idempotent: an edge already followed
 * by a hit path is left alone. Runs after the scrub, on the tree that is
 * about to be mounted, so nothing it adds ever passes through DOMPurify.
 */
export function widenEdgeHitAreas(svg: SVGSVGElement): void {
  const seen = new Set<Element>();
  for (const edge of Array.from(svg.querySelectorAll(EDGE_SELECTOR))) {
    if (seen.has(edge) || edge.hasAttribute(DIAGRAM_HIT_ATTR)) continue;
    seen.add(edge);
    const next = edge.nextElementSibling;
    if (next !== null && next.hasAttribute(DIAGRAM_HIT_ATTR)) continue;
    const hit = edge.cloneNode(false) as SVGElement;
    for (const name of ['id', 'class', 'marker-start', 'marker-mid', 'marker-end', 'style', 'stroke-dasharray']) {
      hit.removeAttribute(name);
    }
    hit.setAttribute(DIAGRAM_HIT_ATTR, '');
    hit.setAttribute('aria-hidden', 'true');
    hit.setAttribute('fill', 'none');
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', String(EDGE_HIT_STROKE_WIDTH));
    hit.setAttribute('pointer-events', 'stroke');
    hit.setAttribute('style', `fill:none;stroke:transparent;stroke-width:${EDGE_HIT_STROKE_WIDTH}px;pointer-events:stroke`);
    edge.after(hit);
  }
}

let parseSvg: (svg: string) => SVGSVGElement | null = parseDiagramSvg;

/**
 * Test hook: stand in for the DOMPurify parse step. happy-dom cannot host
 * DOMPurify (its `DOMParser` lands in a foreign realm and mislabels svg
 * namespaces, and its in-place mode reads `nodeName` through a cached
 * `Node.prototype` getter happy-dom overrides on `Element`), so DOM tests
 * parse through an inert `<template>` instead; `scrubDiagramSvg` still runs
 * on every test render. The real parse is proven in a browser.
 */
export function __setDiagramSvgParserForTests(next: ((svg: string) => SVGSVGElement | null) | undefined): void {
  parseSvg = next ?? parseDiagramSvg;
}

/** Mermaid's parse errors say "Parse error on line N" (the hash carries the
 * line for the parser errors that have one); Graphviz's say "syntax error
 * in line N near '...'". */
function errorLine(error: unknown): number | null {
  if (typeof error === 'object' && error !== null) {
    const hash = (error as { hash?: { line?: unknown; loc?: { first_line?: unknown } } }).hash;
    const line = hash?.line ?? hash?.loc?.first_line;
    if (typeof line === 'number' && Number.isFinite(line)) return line + 1;
  }
  const message = error instanceof Error ? error.message : String(error);
  const m = /line (\d+)/iu.exec(message);
  return m === null ? null : Number(m[1]);
}

function errorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  // Mermaid appends the expected-token dump after the first line; the
  // first line is the human sentence.
  return message.split('\n')[0]?.trim() || fallback;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Load an engine through its slot with ONE automatic re-attempt after a
 * short delay: a transient chunk failure on a chunking host. In a
 * single-file build the first await never rejects, so the second attempt is
 * unreachable there and the success path is unchanged.
 */
async function loadWithRetry<T>(load: () => Promise<T>, delayMs: number): Promise<T> {
  try {
    return await load();
  } catch {
    await wait(delayMs);
    return load();
  }
}

async function renderMermaid(runtime: Mermaid, renderId: string, source: string): Promise<DiagramRenderResult> {
  try {
    const { svg } = await runtime.render(renderId, source);
    const svgNode = sanitizeDiagramSvg(svg);
    if (svgNode === null) {
      return { ok: false, message: 'The diagram could not be rendered.', line: null, runtimeUnavailable: false };
    }
    widenEdgeHitAreas(svgNode);
    return { ok: true, svgNode, findTarget: MERMAID_FINDER.findTarget };
  } catch (error) {
    return {
      ok: false,
      message: errorMessage(error, 'Failed to render diagram'),
      line: errorLine(error),
      runtimeUnavailable: false,
    };
  }
}

const mermaidRenderer: DiagramRenderer = {
  finder: MERMAID_FINDER,
  async render(renderId, source, theme) {
    let runtime: Mermaid;
    try {
      runtime = await loadWithRetry(loadMermaidRuntime, getMermaidRetryDelayMs());
    } catch (error) {
      return {
        ok: false,
        message: errorMessage(error, 'Failed to render diagram'),
        line: null,
        runtimeUnavailable: true,
      };
    }
    // A `$$` label makes Mermaid render KaTeX. On a host that redirects
    // Mermaid's `katex` import to `utils/mermaid-math-slot` the label is
    // typeset through the math slot, which must be filled by then: warm it
    // with the registered loader first. A filled slot resolves at once; a
    // load failure is left to the render, whose error names it.
    if (hasMermaidMath(source)) {
      try {
        await loadMathRenderer();
      } catch {
        // Reported by the render below.
      }
    }
    // Derive every Mermaid theme variable from the page's tokens before each
    // render, so the diagram follows the palette and mode. Keyed on the
    // runtime plus (palette, mode), so the lazy runtime is themed on its
    // first render and re-initialized only when one of the three changes.
    // With no tokens on the page it is a no-op and the static
    // MERMAID_CONFIG (securityLevel strict) applies.
    applyMermaidTheme(runtime, mermaidThemeKey(theme.colorTheme, theme.mode));
    return renderMermaid(runtime, renderId, source);
  },
};

/** A Graphviz default color, as `viz` writes it: a named default or its
 * hex spelling. An author's hex spelling of the same default is
 * indistinguishable from the default and is themed with it. */
function isGraphvizDefault(value: string | null, ...names: string[]): boolean {
  if (value === null) return false;
  const bare = value.trim().toLowerCase();
  return names.includes(bare.startsWith('#') ? bare.slice(1) : bare);
}

const BLACK = ['black', '000000', '000'];
const WHITE = ['white', 'ffffff', 'fff'];
const LIGHTGREY = ['lightgrey', 'lightgray', 'd3d3d3'];

/**
 * Graphviz has no theme system; every color lands as a presentation
 * attribute from the DOT defaults (`stroke="black"`, `fill="none"`, a white
 * page polygon) or from the author's attributes. This pass recolors the
 * DEFAULTS onto the page tokens and leaves every author color alone:
 *   - the page background polygon (the first polygon under `g.graph`,
 *     `fill="white"`) is removed: the canvas is the ground;
 *   - a node or cluster shape with `fill="none"` gets `var(--card)` (an
 *     opaque interior, so the hover ring and the edge routing read), a
 *     black stroke gets `var(--foreground)` on a node and `var(--border)`
 *     on a cluster, a `lightgrey` fill (the `style=filled` default) gets
 *     `var(--muted)`;
 *   - an edge line or arrowhead in black gets `var(--foreground)`;
 *   - text with no fill or a black fill gets `var(--foreground)`.
 * What it does NOT touch: any named or hex color the author set
 * (`fillcolor=gold`, `color=red`), `bgcolor`, font families and sizes,
 * stroke widths and dash patterns. Idempotent.
 */
export function themeGraphvizSvg(svg: SVGSVGElement): void {
  const graph = svg.querySelector(':scope > g.graph');
  const page = graph?.querySelector(':scope > polygon') ?? null;
  if (page !== null && isGraphvizDefault(page.getAttribute('fill'), ...WHITE)) {
    page.remove();
  }
  const shapes = 'polygon, ellipse, circle, path, polyline, rect';
  for (const group of Array.from(svg.querySelectorAll('g.node, g.cluster'))) {
    const cluster = group.classList.contains('cluster');
    for (const shape of Array.from(group.querySelectorAll(`:scope > ${shapes.replaceAll(', ', ', :scope > ')}`))) {
      const fill = shape.getAttribute('fill');
      if (isGraphvizDefault(fill, 'none', 'transparent')) {
        shape.setAttribute('fill', 'var(--card)');
      } else if (isGraphvizDefault(fill, ...LIGHTGREY)) {
        shape.setAttribute('fill', 'var(--muted)');
      }
      if (isGraphvizDefault(shape.getAttribute('stroke'), ...BLACK)) {
        shape.setAttribute('stroke', cluster ? 'var(--border)' : 'var(--foreground)');
      }
    }
  }
  for (const part of Array.from(svg.querySelectorAll('g.edge > path, g.edge > polygon, g.edge > ellipse'))) {
    if (isGraphvizDefault(part.getAttribute('stroke'), ...BLACK)) {
      part.setAttribute('stroke', 'var(--foreground)');
    }
    if (isGraphvizDefault(part.getAttribute('fill'), ...BLACK)) {
      part.setAttribute('fill', 'var(--foreground)');
    }
  }
  for (const text of Array.from(svg.querySelectorAll('text'))) {
    const fill = text.getAttribute('fill');
    if (fill === null || isGraphvizDefault(fill, ...BLACK)) {
      text.setAttribute('fill', 'var(--foreground)');
    }
  }
}

/**
 * The Graphviz entry: `@viz-js/viz` behind the runtime slot,
 * `render(source, { format: "svg" })` as a value (`status: "failure"`
 * carries the messages; nothing throws for a bad graph), the same sanitizer
 * as Mermaid (Graphviz output has no foreignObject, no style, no url()
 * reference, and a DOT `URL=` attribute emits the `<a xlink:href>` the pass
 * strips), then the theme pass. The engine's output ids (`nodeN`) are
 * positional and never prefixed by `renderId`; the finder keys on the DOT
 * name from each `<title>`. The entry passes NO `images` option, so a DOT
 * `image=` attribute is refused by the engine with a warning and emits no
 * `<image>` at all.
 */
const graphvizRenderer: DiagramRenderer = {
  finder: GRAPHVIZ_FINDER,
  async render(_renderId, source) {
    let viz: GraphvizRuntime;
    try {
      viz = await loadWithRetry(loadGraphvizRuntime, getGraphvizRetryDelayMs());
    } catch (error) {
      return {
        ok: false,
        message: errorMessage(error, 'The Graphviz engine could not be loaded.'),
        line: null,
        runtimeUnavailable: true,
      };
    }
    try {
      const result = viz.render(source, { format: 'svg' });
      if (result.status === 'failure') {
        const first = result.errors.find((entry) => entry.level !== 'warning') ?? result.errors[0];
        const message = first?.message.trim() || 'The graph could not be rendered.';
        return { ok: false, message, line: errorLine(message), runtimeUnavailable: false };
      }
      const svgNode = sanitizeDiagramSvg(result.output);
      if (svgNode === null) {
        return { ok: false, message: 'The graph could not be rendered.', line: null, runtimeUnavailable: false };
      }
      themeGraphvizSvg(svgNode);
      widenEdgeHitAreas(svgNode);
      return { ok: true, svgNode, findTarget: GRAPHVIZ_FINDER.findTarget };
    } catch (error) {
      return {
        ok: false,
        message: errorMessage(error, 'Failed to render diagram'),
        line: errorLine(error),
        runtimeUnavailable: false,
      };
    }
  },
};

const RENDERERS: Record<DiagramKind, DiagramRenderer> = {
  mermaid: mermaidRenderer,
  graphviz: graphvizRenderer,
};

/** The finder for a kind, synchronously: the viewer wires the pointer and
 * the anchors to it before the first render lands. */
export function diagramFinder(kind: DiagramKind): DiagramFinder {
  return RENDERERS[kind].finder;
}

/**
 * Render one diagram source. `renderId` is the caller's stable prefix for
 * the element ids; the finder in the result strips it when it matches
 * anchors.
 */
export function renderDiagram(
  kind: DiagramKind,
  renderId: string,
  source: string,
  theme: DiagramTheme,
): Promise<DiagramRenderResult> {
  return RENDERERS[kind].render(renderId, source, theme);
}
