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
 *
 * A label's own HTML never navigates or submits either: Mermaid's label pass
 * drops image maps, forms and their controls (`MERMAID_LABEL_FORBIDDEN_TAGS` /
 * `_ATTRS` in `./mermaid`, a secure key a directive cannot replace), and the
 * post-pass drops them again for a runtime a host set up itself. And no
 * style the diagram carries may pin an element to the window
 * (`position` other than static, relative or absolute), in a `style`
 * attribute or in a rule of its sheet; every mount outside the canvas also
 * confines its diagram (`contain: paint`), so nothing drawn leaves its box.
 */
import DOMPurify from 'dompurify';
import type { TextMeasurer } from 'pele';
import type { DiagramKind } from '@plannotator/core/diagram-anchor';
import { MERMAID_FINDER, type DiagramFinder } from './diagram-anchor';
import { GRAPHVIZ_FINDER } from './diagram-anchor-graphviz';
import { PELE_COMPAT_FINDER, PELE_FINDER } from './diagram-anchor-pele';
import { diagramEngineFor, diagramEngineMode } from './diagram-engine';
import { getGraphvizRetryDelayMs, loadGraphvizRuntime, type GraphvizRuntime } from './graphviz';
import { loadMathRenderer } from './math';
import { getDiagramRemoteLoads } from './diagramRemoteLoadsPolicy';
import { getMermaidRetryDelayMs, loadMermaidRuntime, MERMAID_LABEL_FORBIDDEN_ATTRS, MERMAID_NO_REMOTE_LABEL_MARK } from './mermaid';
import { hasMermaidMath } from './mermaid-math-slot';
import { applyMermaidTheme, mermaidThemeKey, type MermaidThemeMode, type RemoteLoadsMode } from './mermaidTheme';
import { loadPeleRuntime, PELE_IN_BUILD, PELE_OUTPUT_LIMIT, PELE_SOURCE_LIMIT, peleFonts, peleSvgId, renderPeleSource } from './pele';
import { finishPeleLabels, needsPeleLabels, pageMathTypesetter, peleLabelMeasurer, preparePeleLabels, restorePeleLabelMessage, type PreparedPeleLabels } from './pele-labels';
import { peleAuthorColors } from './peleAuthorTheme';
import { clampPeleStyles } from './peleStyleClamp';
import { applyPeleThemeVariables, peleShadowCss, readPeleThemeVariables } from './peleTheme';

export type { DiagramKind } from '@plannotator/core/diagram-anchor';

type Mermaid = Awaited<ReturnType<typeof loadMermaidRuntime>>;

/**
 * The (palette, mode) a render is for: the same pair `useTheme()` resolves
 * for code fences, plus the node shadow amount the user chose. The mermaid
 * entry passes them to `applyMermaidTheme`, which runs the global `initialize`
 * once per key; the graphviz entry recolors its defaults onto CSS tokens and
 * needs neither. A host without ThemeProvider passes any palette id with the
 * mode it renders in.
 */
export interface DiagramTheme {
  readonly colorTheme: string;
  readonly mode: MermaidThemeMode;
  /**
   * Node drop shadow strength, 0..1 (see `mermaidTheme.buildMermaidShadow`).
   * Absent means the shipped default, so a host that builds its own
   * `DiagramTheme` renders exactly what Plannotator renders.
   */
  readonly shadowAmount?: number;
}

export type DiagramRenderError = {
  readonly ok: false;
  readonly message: string;
  readonly line: number | null;
  /** The engine could not be loaded (as opposed to the source not
   * parsing): the one failure a Retry can change. */
  readonly runtimeUnavailable: boolean;
  /** A part of the engine loaded on demand (Mermaid's chunk for one diagram
   * type) did not arrive, after the one automatic re-attempt. Not the
   * source's fault, and not one a Retry can change in Safari, which keeps a
   * failed module fetch for the page: the block offers Reload. */
  readonly chunkFailed?: boolean;
  /** The host's check (`DiagramRenderOptions.accept`) refused the drawn svg before it reached the page: the block
   * shows the source instead. */
  readonly refused?: boolean;
  /** Pele has no renderer for the source's diagram type (only when the engine switch sends a fence to Pele). */
  readonly unsupported?: boolean;
};

/**
 * Opt-in, per render: `accept` is shown the drawn svg after the sanitizer's parse and before the root is adopted into
 * the page (in DOMPurify's inert document, so nothing it references has loaded). False: the svg is never mounted and
 * the result is `refused`. Absent: every render is exactly as before.
 */
export interface DiagramRenderOptions {
  readonly accept?: (svg: SVGSVGElement) => boolean;
}

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
  render(renderId: string, source: string, theme: DiagramTheme, options?: DiagramRenderOptions): Promise<DiagramRenderResult>;
  readonly finder: DiagramFinder;
}

/** Elements that never belong in a rendered diagram. DOMPurify's profiles
 * already drop every one of them; the sweep below is the belt that does not
 * depend on which profile a later config edit turns on. The MathML ones:
 * `mglyph` loads an image, `maction` is a link or status action, and
 * `annotation-xml` can hold html; a KaTeX label needs none of them. */
const FORBIDDEN_ELEMENTS = 'script, iframe, object, embed, link, meta, mglyph, maction, annotation-xml';

/**
 * The belt over the engine's output (see the header). DOMPurify parses the
 * string under the svg, svg-filter, html and MathML profiles and hands back a
 * detached fragment, so nothing executes and no markup reaches the app DOM.
 * `foreignobject` and its html children are added back the way Mermaid's
 * own pass adds them (the same ADD_TAGS, ADD_ATTR and
 * HTML_INTEGRATION_POINTS entries); without them every html label in the
 * diagram would be dropped. The walk afterwards closes what DOMPurify leaves
 * open for an svg: an `<a href>` around a node, a `data:` reference on
 * an `<image>`, and any link or source on a MathML element.
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
 * svg-filter, html and MathML profiles and hands back a detached fragment; the svg
 * root is adopted into the page's document so the node the canvas mounts
 * belongs to it. Null when the markup carries no svg root, when there is no
 * document, or when the fragment cannot be adopted.
 */
export function parseDiagramSvg(svg: string): SVGSVGElement | null {
  const root = parseDiagramSvgDetached(svg);
  if (root === null) return null;
  try {
    return document.adoptNode(root) as SVGSVGElement;
  } catch {
    return null;
  }
}

/** The parse alone: the svg root still in DOMPurify's inert document, not adopted into the page. */
function parseDiagramSvgDetached(svg: string): SVGSVGElement | null {
  if (typeof document === 'undefined') return null;
  const fragment = DOMPurify.sanitize(svg, {
    // `mathMl`: a `$$...$$` label is KaTeX MathML inside the html label;
    // without the profile DOMPurify drops the `<math>` with its content and
    // the node draws empty. `mglyph` is MathML's image element: forbidden.
    USE_PROFILES: { svg: true, svgFilters: true, html: true, mathMl: true },
    FORBID_TAGS: ['mglyph'],
    ADD_TAGS: ['foreignobject'],
    ADD_ATTR: ['dominant-baseline'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    RETURN_DOM_FRAGMENT: true,
  });
  return fragment.querySelector('svg');
}

const REFUSED = 'refused' as const;

/**
 * `sanitizeDiagramSvg` with a host's `accept` asked first, on the parsed root before it is adopted into the page.
 * (A test's stand-in parser adopts as it parses; happy-dom loads nothing.)
 */
function sanitizeAcceptedDiagramSvg(svg: string, accept: (svg: SVGSVGElement) => boolean): SVGSVGElement | null | typeof REFUSED {
  let root: SVGSVGElement | null;
  if (parseSvg === parseDiagramSvg) {
    const detached = parseDiagramSvgDetached(svg);
    if (detached === null) return null;
    if (!accept(detached)) return REFUSED;
    try {
      root = document.adoptNode(detached) as SVGSVGElement;
    } catch {
      return null;
    }
  } else {
    root = parseSvg(svg);
    if (root === null) return null;
    if (!accept(root)) return REFUSED;
  }
  scrubDiagramSvg(root);
  return root;
}

const REFUSED_RESULT: DiagramRenderError = { ok: false, message: 'The diagram is shown as its source.', line: null, runtimeUnavailable: false, refused: true };

/** The sanitized root, through `accept` when the host gave one. */
function sanitizeFor(svg: string, options: DiagramRenderOptions | undefined): SVGSVGElement | null | typeof REFUSED {
  return options?.accept ? sanitizeAcceptedDiagramSvg(svg, options.accept) : sanitizeDiagramSvg(svg);
}

/**
 * What an html label may not hold once drawn, the belt under Mermaid's own
 * label pass (`MERMAID_LABEL_FORBIDDEN_TAGS` in `./mermaid`), for a runtime a
 * host initialized without that config: what navigates or submits when
 * clicked. Removed: the empty ones. Unwrapped (the element goes, its text
 * stays): the rest.
 */
const NAVIGATING_ELEMENTS = 'input, area, base';
const UNWRAPPED_ELEMENTS = 'form, button, select, option, optgroup, datalist, textarea, map';

/** Attributes that navigate or submit (`MERMAID_LABEL_FORBIDDEN_ATTRS`), removed from every element. */
const NAVIGATING_ATTRIBUTES = new Set(MERMAID_LABEL_FORBIDDEN_ATTRS);

/**
 * Step two, in place on the tree that is about to be mounted: the belt that
 * does not depend on which DOMPurify profile a later config edit turns on.
 * Forbidden elements go, every `<style>` keeps only rules scoped under the
 * svg's own root id (`scopeDiagramCss`), every `<a>` loses its target (svg `<a>` from a
 * click binding, `<a>` in an html label alike — the element stays so the
 * label text survives), every `on*` attribute goes, a reference
 * attribute keeps only a fragment or an http(s) URL, what navigates or
 * submits goes (an image map, a form and its controls, `action`,
 * `formaction`, `ping`, `target`, `usemap`), and a `position` other than
 * static, relative or absolute goes from every `style` attribute and every
 * kept rule (`keepContainedDeclarations`). A diagram with none of these
 * comes out exactly as before. With `configurePlannotatorUI({ diagramRemoteLoads: false })`
 * every reference and declaration that loads from another host goes as well
 * (`keepLocalAttributes`, `scopeDiagramCss`'s `remoteLoads`).
 */
export function scrubDiagramSvg(root: SVGSVGElement): void {
  const remoteLoads = getDiagramRemoteLoads();
  for (const el of Array.from(root.querySelectorAll(FORBIDDEN_ELEMENTS))) el.remove();
  for (const el of Array.from(root.querySelectorAll(NAVIGATING_ELEMENTS))) el.remove();
  for (const el of Array.from(root.querySelectorAll(UNWRAPPED_ELEMENTS)).reverse()) el.replaceWith(...Array.from(el.childNodes));
  // A `<style>` inside the svg is a page stylesheet once mounted: it can
  // restyle elements OUTSIDE the diagram and fetch (`@import`, `url(`).
  // Mermaid needs its own scoped sheet, so style elements are not dropped
  // wholesale; each keeps only rules scoped under the svg's root id.
  const rootId = root.getAttribute('id') ?? '';
  for (const style of Array.from(root.querySelectorAll('style'))) {
    const kept = scopeDiagramCss(style.textContent ?? '', rootId, { remoteLoads });
    if (kept === '') style.remove();
    else style.textContent = kept;
  }
  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    anchor.removeAttribute('href');
    anchor.removeAttribute('xlink:href');
  }
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    scrubAttributes(node as Element, remoteLoads);
  }
  scrubAttributes(root, remoteLoads);
}

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

function scrubAttributes(el: Element, remoteLoads: boolean): void {
  if (!remoteLoads) keepLocalAttributes(el);
  // A math label (KaTeX MathML) carries no link and loads nothing; an `href`
  // on a MathML element is a link in Firefox, so a MathML element keeps none.
  const isMath = el.namespaceURI === MATHML_NS;
  for (const attribute of Array.from(el.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value.trim().toLowerCase();
    if (name.startsWith('on') || (isMath && (name === 'href' || name === 'xlink:href' || name === 'src'))) {
      el.removeAttribute(attribute.name);
      continue;
    }
    if (NAVIGATING_ATTRIBUTES.has(name)) {
      el.removeAttribute(attribute.name);
      continue;
    }
    // With nothing loading from another host the references were already
    // narrowed to a `#fragment` or a `data:` picture (`keepLocalAttributes`),
    // and a `data:` picture is kept so it draws.
    if (
      remoteLoads &&
      (name === 'href' || name === 'xlink:href' || name === 'src') &&
      !value.startsWith('#') &&
      !value.startsWith('http://') &&
      !value.startsWith('https://') &&
      value !== ''
    ) {
      el.removeAttribute(attribute.name);
      continue;
    }
    if (name === 'style') {
      const kept = keepContainedDeclarations(attribute.value);
      if (kept === null) el.removeAttribute(attribute.name);
      else if (kept !== attribute.value) el.setAttribute(attribute.name, kept);
    }
  }
}

// ---------------------------------------------------------------------------
// Diagrams that load nothing from another host (`diagramRemoteLoads: false`)
// ---------------------------------------------------------------------------

/** Attributes whose value is a reference the browser loads (or follows). */
const REFERENCE_ATTRIBUTES = new Set(['src', 'href', 'xlink:href', 'poster', 'background', 'lowsrc', 'dynsrc']);
/** Lists of references: never kept when nothing may load from another host. */
const REFERENCE_LIST_ATTRIBUTES = new Set(['srcset', 'imagesrcset']);
/** Attributes that are words, never read as CSS or a reference. */
const TEXT_ATTRIBUTES = new Set(['alt', 'title', 'id', 'class', 'name', 'lang', 'dir', 'role']);

/** A `data:` picture a browser draws without loading anything (svg+xml is not one: an svg document can reference). */
const LOCAL_PICTURE = /^data:image\/(?:png|jpeg|gif|webp|avif)[;,]/u;

/**
 * A reference that names nothing on another host: a `#fragment`, or a `data:`
 * picture. Read the way a browser reads a URL attribute: leading and trailing
 * C0 controls and spaces dropped, tabs and line breaks anywhere ignored.
 */
export function isLocalReference(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const url = value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/gu, '').replace(/[\t\n\r]/gu, '').toLowerCase();
  return url.startsWith('#') || LOCAL_PICTURE.test(url);
}

/** CSS functions that load, with or without a vendor prefix. */
const CSS_LOADERS = /(?:^|[^a-z0-9_-])(?:-[a-z]+-)?(?:image-set|image|cross-fade|src|element|paint)\(/u;

/**
 * Whether CSS text loads anything: a `url(` that is not a `#fragment` (a
 * `data:` one included), any other loading function, `@import`, or a `src:`
 * descriptor. Escapes are decoded first, so `u\72l(` and `\75 rl(` are
 * `url(`; anything after `url(` other than `#` counts, however its address
 * is spelled.
 */
export function cssLoads(text: string): boolean {
  // Comments are left in: a `url(` inside one is counted too (never a miss), and `/*` inside a string is no comment.
  const css = decodeCssEscapes(text).toLowerCase();
  if (css.includes('@import') || CSS_LOADERS.test(css) || /(?:^|[;{\s])src\s*:/u.test(css)) return true;
  for (let at = css.indexOf('url('); at !== -1; at = css.indexOf('url(', at + 4)) {
    const arg = css.slice(at + 4).replace(/^[\s\u0000-\u001f]+/u, '').replace(/^["']/u, '');
    if (!arg.startsWith('#')) return true;
  }
  return false;
}

/**
 * With nothing allowed to load from another host: every reference keeps only
 * a `#fragment` or a `data:` picture, a reference list goes, a `style` loses
 * each declaration that loads, and any other attribute whose value loads as
 * CSS (`fill="url(…)"`, `filter`, `mask`, `cursor`) goes.
 */
function keepLocalAttributes(el: Element): void {
  for (const attribute of Array.from(el.attributes)) {
    const name = attribute.name.toLowerCase();
    if (REFERENCE_LIST_ATTRIBUTES.has(name) || (REFERENCE_ATTRIBUTES.has(name) && !isLocalReference(attribute.value))) {
      el.removeAttribute(attribute.name);
    } else if (name === 'style') {
      const kept = keepDeclarations(attribute.value, cssLoads);
      if (kept === null) el.removeAttribute(attribute.name);
      else if (kept !== attribute.value) el.setAttribute(attribute.name, kept);
    } else if (!TEXT_ATTRIBUTES.has(name) && !name.startsWith('data-') && !name.startsWith('aria-') && !REFERENCE_ATTRIBUTES.has(name) && cssLoads(attribute.value)) {
      el.removeAttribute(attribute.name);
    }
  }
}

/** Set by the hook whenever it sees a marked config: how `probeLabelHook` knows it reached Mermaid. */
let labelHookSeen = false;

/**
 * The attribute hook Mermaid's own label pass runs when nothing may load from
 * another host: the label config carries MERMAID_NO_REMOTE_LABEL_MARK (see
 * `mermaidConfigForRemoteLoads`), and the hook applies `keepLocalAttributes`'
 * rules to each attribute of a label before Mermaid puts it in the live page.
 * Any other sanitize call (no mark) is left alone.
 */
const noRemoteLabelHook = (_node: Element, data: { attrName: string; attrValue: string; keepAttr: boolean }, config: unknown): void => {
  if ((config as Record<string, unknown> | undefined)?.[MERMAID_NO_REMOTE_LABEL_MARK] !== true) return;
  labelHookSeen = true;
  const name = data.attrName;
  if (REFERENCE_LIST_ATTRIBUTES.has(name) || (REFERENCE_ATTRIBUTES.has(name) && !isLocalReference(data.attrValue))) {
    data.keepAttr = false;
  } else if (name === 'style') {
    const kept = keepDeclarations(data.attrValue, cssLoads);
    if (kept === null) data.keepAttr = false;
    else data.attrValue = kept;
  } else if (!TEXT_ATTRIBUTES.has(name) && !name.startsWith('data-') && !name.startsWith('aria-') && cssLoads(data.attrValue)) {
    data.keepAttr = false;
  }
};

let labelHookEverInstalled = false;

/**
 * Put the hook on the DOMPurify this module imports, before each render with
 * the option off (never otherwise). Re-added every time, since a host's own
 * code may have removed it (`removeHook`, `removeAllHooks`); when it had gone
 * missing, every runtime's probe is run again. True when it was in place.
 */
export function installNoRemoteLabelHook(): boolean {
  const wasThere = DOMPurify.removeHook('uponSanitizeAttribute', noRemoteLabelHook) !== undefined;
  DOMPurify.addHook('uponSanitizeAttribute', noRemoteLabelHook);
  const intact = wasThere || !labelHookEverInstalled;
  labelHookEverInstalled = true;
  return intact;
}

/** Per runtime: whether its label pass runs the hook (one probe render each, shared by concurrent renders; reset when the hook had been removed). */
let labelHookReach = new WeakMap<Mermaid, Promise<boolean>>();

/**
 * Whether Mermaid's label pass sanitizes with this module's DOMPurify (so the
 * hook runs): one tiny render with an attribute in a label, once per runtime,
 * with the no-remote config already applied. A host bundle with two copies of
 * DOMPurify answers false, and the label pass falls back to dropping every
 * picture, reference and style in a label.
 */
async function probeLabelHook(runtime: Mermaid, themeKey: string): Promise<boolean> {
  applyMermaidTheme(runtime, themeKey, undefined, 'local');
  labelHookSeen = false;
  const probeId = 'pn-label-hook-probe';
  try {
    await runtime.render(probeId, 'flowchart LR\n  P["<b title=probe>p</b>"]');
  } catch {
    // The answer is whether the hook ran, not whether the probe drew.
  } finally {
    removeMermaidLeftovers(probeId);
  }
  return labelHookSeen;
}

/**
 * The runtime's config for the policy before a render, when diagrams may not
 * load from other hosts: the no-remote label pass, checked once per runtime
 * to reach it (`'local'`), else its fallback (`'local-fallback'`).
 */
async function remoteLoadsMode(runtime: Mermaid, themeKey: string): Promise<RemoteLoadsMode> {
  if (!installNoRemoteLabelHook()) labelHookReach = new WeakMap();
  let reach = labelHookReach.get(runtime);
  if (reach === undefined) {
    reach = probeLabelHook(runtime, themeKey);
    labelHookReach.set(runtime, reach);
  }
  return (await reach) ? 'local' : 'local-fallback';
}

/** The only `position` values a diagram's styles may set: none of them takes an element out of its diagram's box. */
const CONTAINED_POSITIONS = new Set(['static', 'relative', 'absolute']);

/**
 * Split a declaration list where a browser would, on every top-level `;`,
 * with comments read as a space. A split here is never missed: a quote or a
 * bracket is tracked as the CSS tokenizer does (a string ends at a newline,
 * an escape outside a string takes the next character), and any closer
 * closes, so this splits at least where the browser does.
 */
function splitDeclarations(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote !== '') {
      if (ch === '\\') {
        current += ch + (text[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (ch === quote || ch === '\n' || ch === '\r' || ch === '\f') quote = '';
      current += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 1;
      current += ' ';
      continue;
    }
    if (ch === '\\' && text[i + 1] !== undefined && !/[\n\r\f]/u.test(text[i + 1] as string)) {
      current += ch + (text[i + 1] as string);
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * A declaration that could take its element out of the diagram: a
 * `position` (escapes decoded, any case) whose value is not one of
 * CONTAINED_POSITIONS (`fixed`, `sticky`, `var(--p)`, `inherit`, … all
 * refused), or a nested block (a nested rule in a sheet).
 */
function declarationEscapes(declaration: string): boolean {
  if (/[{}]/u.test(declaration.replace(/"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/gu, '""'))) return true;
  const colon = declaration.indexOf(':');
  if (colon === -1) return false;
  if (decodeCssEscapes(declaration.slice(0, colon)).trim().toLowerCase() !== 'position') return false;
  const value = decodeCssEscapes(declaration.slice(colon + 1)).replace(/!\s*important\s*$/iu, '').trim().toLowerCase();
  return !CONTAINED_POSITIONS.has(value);
}

/**
 * A declaration list (a `style` attribute, a rule's body) without the
 * declarations that could take an element out of the diagram. The text comes
 * back unchanged, byte for byte, when there are none; null when nothing is left.
 */
export function keepContainedDeclarations(text: string): string | null {
  return keepDeclarations(text, declarationEscapes);
}

/**
 * A declaration list without the declarations `refused` names, split the way
 * a browser splits it (`splitDeclarations`). The text comes back unchanged,
 * byte for byte, when none is refused; null when nothing is left.
 */
function keepDeclarations(text: string, refused: (declaration: string) => boolean): string | null {
  const declarations = splitDeclarations(text);
  if (!declarations.some(refused)) return text;
  const kept = declarations
    .filter((declaration) => !refused(declaration))
    .map((declaration) => declaration.trim())
    .filter(Boolean);
  return kept.length === 0 ? null : kept.join('; ');
}

/** The attribute an edge's widened hit path carries (its value is the
 * edge's index in the layer); `diagramHitSource` maps one back to the
 * visible edge it stands for. */
export const DIAGRAM_HIT_ATTR = 'data-diagram-hit';
/** The one group, appended LAST in the svg root, that holds every hit path. */
export const DIAGRAM_HIT_LAYER_ATTR = 'data-diagram-hit-layer';
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
  // Pele (`diagram-engine.ts`): its edge groups; a marker path is the arrowhead.
  'g.pele-edge > path:not(.pele-marker)',
].join(', ');

/** The geometry a hit path keeps from its edge; everything else (id, class,
 * every `data-*`, markers, inline style, dash pattern) is left behind, so a
 * host's `[data-id="L_A_B_0"]` still matches exactly one element. */
const HIT_GEOMETRY_ATTRS = ['d', 'x1', 'y1', 'x2', 'y2', 'points'];

const hitSources = new WeakMap<Element, Element>();

/** The visible edge a hit path stands for, or null for any other element. */
export function diagramHitSource(el: Element): Element | null {
  return hitSources.get(el) ?? null;
}

/** The transform list that places `el` in the svg root's user space: every
 * ancestor's `transform` attribute, outermost first, then the element's
 * own. An svg transform list composes left to right, so joining the
 * attribute strings IS the composed transform — no layout needed, which is
 * what lets this run on the detached node the slot hands over. */
function transformToRoot(el: Element, root: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = el; node !== null && node !== root; node = node.parentElement) {
    const transform = node.getAttribute('transform');
    if (transform !== null && transform.trim() !== '') parts.unshift(transform.trim());
  }
  return parts.join(' ');
}

/**
 * Give every edge an invisible hit target, in ONE layer appended last in
 * the svg root. A sibling clone is not enough: an edge's own LABEL box is
 * painted after the edge paths and covers it exactly where a person clicks
 * an edge, and a nested subgraph's cluster rect covers a parent edge the
 * same way. Each hit path is a bare element of the edge's tag with only its
 * geometry, a `transform` that re-creates the ancestors' placement,
 * `stroke: transparent`, `fill: none`, `stroke-width: 14` (set `!important`
 * so no inherited or scoped rule can narrow it) and `pointer-events:
 * stroke`. The layer sits over the nodes too, so the canvas resolves a click
 * by priority over everything under the pointer (node, then edge, then
 * cluster), never by the topmost element alone. Idempotent; runs after the
 * scrub, on the tree about to be mounted, so nothing it adds passes through
 * DOMPurify.
 */
export function widenEdgeHitAreas(svg: SVGSVGElement): void {
  const doc = svg.ownerDocument;
  svg.querySelector(`:scope > [${DIAGRAM_HIT_LAYER_ATTR}]`)?.remove();
  const edges = Array.from(new Set(Array.from(svg.querySelectorAll(EDGE_SELECTOR))));
  if (edges.length === 0) return;
  const layer = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
  layer.setAttribute(DIAGRAM_HIT_LAYER_ATTR, '');
  layer.setAttribute('aria-hidden', 'true');
  edges.forEach((edge, index) => {
    const hit = doc.createElementNS('http://www.w3.org/2000/svg', edge.tagName.toLowerCase()) as SVGElement;
    for (const name of HIT_GEOMETRY_ATTRS) {
      const value = edge.getAttribute(name);
      if (value !== null) hit.setAttribute(name, value);
    }
    const transform = transformToRoot(edge, svg);
    if (transform !== '') hit.setAttribute('transform', transform);
    hit.setAttribute(DIAGRAM_HIT_ATTR, String(index));
    hit.setAttribute('fill', 'none');
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', String(EDGE_HIT_STROKE_WIDTH));
    hit.setAttribute('pointer-events', 'stroke');
    const style = hit.style;
    if (style) {
      style.setProperty('fill', 'none', 'important');
      style.setProperty('stroke', 'transparent', 'important');
      style.setProperty('stroke-width', `${EDGE_HIT_STROKE_WIDTH}px`, 'important');
      style.setProperty('stroke-dasharray', 'none', 'important');
      style.setProperty('marker-start', 'none', 'important');
      style.setProperty('marker-end', 'none', 'important');
      style.setProperty('pointer-events', 'stroke', 'important');
    }
    hitSources.set(hit, edge);
    layer.appendChild(hit);
  });
  svg.appendChild(layer);
}

/** CSS functions that fetch. `url(#fragment)` is the one reference kept. */
const CSS_FETCHERS = /(?:^|[^a-z-])(?:image-set|image|src|cross-fade|paint|element)\(/iu;

/** Resolve CSS escapes (`u\72l(` IS `url(` to a browser) so the checks
 * below read what the engine would. */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\([0-9a-f]{1,6})\s?|\\(.)/giu, (_m, hex: string | undefined, ch: string | undefined) =>
    hex !== undefined ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16) || 0xfffd, 0x10ffff)) : (ch ?? ''),
  );
}

function cssFetches(block: string): boolean {
  const decoded = decodeCssEscapes(block).toLowerCase();
  if (decoded.includes('@import')) return true;
  if (CSS_FETCHERS.test(decoded)) return true;
  for (let at = decoded.indexOf('url('); at !== -1; at = decoded.indexOf('url(', at + 4)) {
    const arg = decoded.slice(at + 4).trimStart().replace(/^["']/u, '');
    if (!arg.startsWith('#')) return true;
  }
  return false;
}

/** Split on top-level commas (not inside parens, brackets or strings). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of list) {
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/**
 * Keep only what a diagram's own stylesheet may say. Mermaid scopes every
 * rule it emits under the svg's root id (`#<renderId> .node rect{…}`) plus
 * its `@keyframes`; that is exactly what survives. Dropped: `@import`, any
 * rule that fetches (`url(` that is not a `#fragment`, `image-set(`, …),
 * any rule with a selector NOT scoped under `#<rootId>` (which could
 * restyle the page around the diagram), and every at-rule but `@keyframes`
 * and the grouping rules, which are filtered recursively. A brace-matching
 * pass over the text: a detached `<style>` has no CSSOM to ask.
 */
export function scopeDiagramCss(css: string, rootId: string, options: { remoteLoads?: boolean } = {}): string {
  const remoteLoads = options.remoteLoads ?? true;
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const scoped = (selector: string): boolean => {
    if (rootId === '') return false;
    const decoded = decodeCssEscapes(selector).trim();
    if (!decoded.startsWith(`#${rootId}`)) return false;
    const next = decoded[rootId.length + 1];
    return next === undefined || !/[\w-]/u.test(next);
  };
  let out = '';
  let i = 0;
  while (i < text.length) {
    // The prelude runs to the first top-level `{` or `;`.
    let j = i;
    let quote = '';
    while (j < text.length) {
      const ch = text[j] as string;
      if (quote !== '') {
        if (ch === '\\') j += 1;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{' || ch === ';') break;
      j += 1;
    }
    const prelude = text.slice(i, j).trim();
    if (j >= text.length) break;
    if (text[j] === ';') {
      // A statement at-rule (`@import …;`, `@charset`, `@namespace`): dropped.
      i = j + 1;
      continue;
    }
    // The block runs to its matching `}`.
    let depth = 0;
    let k = j;
    quote = '';
    for (; k < text.length; k += 1) {
      const ch = text[k] as string;
      if (quote !== '') {
        if (ch === '\\') k += 1;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = text.slice(j + 1, k);
    i = k + 1;
    if (prelude === '') continue;
    if (prelude.startsWith('@')) {
      const name = /^@([\w-]+)/u.exec(prelude)?.[1]?.toLowerCase() ?? '';
      if (/^(?:-\w+-)?keyframes$/u.test(name)) {
        if (!cssFetches(prelude) && !cssFetches(body) && (remoteLoads || (!cssLoads(prelude) && !cssLoads(body)))) out += `${prelude}{${body}}`;
      } else if (name === 'media' || name === 'supports' || name === 'container' || name === 'layer') {
        if (cssFetches(prelude) || (!remoteLoads && cssLoads(prelude))) continue;
        const inner = scopeDiagramCss(body, rootId, options);
        if (inner !== '') out += `${prelude}{${inner}}`;
      }
      continue;
    }
    if (cssFetches(body)) continue;
    const selectors = splitSelectors(prelude);
    if (selectors.length === 0 || !selectors.every(scoped)) continue;
    const kept = remoteLoads ? keepContainedDeclarations(body) : keepDeclarations(body, (declaration) => declarationEscapes(declaration) || cssLoads(declaration));
    if (kept !== null) out += `${prelude}{${kept}}`;
  }
  return out;
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

/**
 * What a browser says when a lazily imported chunk does not arrive: Chromium,
 * WebKit (Safari, every iPad browser), Firefox, and Vite's CSS preload. The
 * last is WebKit's words when the chunk's request was redirected to another
 * origin: a sign-in proxy in front of the Inbox (Cloudflare Access) whose
 * session lapsed answers every request with a redirect to its login page.
 */
const CHUNK_LOAD_FAILURE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Cross-origin script load denied/i;

function isChunkLoadFailure(error: unknown): boolean {
  return CHUNK_LOAD_FAILURE.test(error instanceof Error ? error.message : String(error));
}

/**
 * Mermaid loads each diagram type (sequence, flowchart, its ELK layout, ...)
 * as a chunk of its own on that type's first render, after the runtime
 * itself has loaded. Such a chunk failing (a dropped request, or a tab older
 * than the server's build, whose chunk names are gone) is a load failure, not
 * a fault in the source: it gets one automatic re-attempt (Mermaid keeps no
 * failed load; Chromium and Firefox fetch again), and if that fails too, the
 * result says `chunkFailed` and the block shows the source under the quiet
 * Reload line. Not a Retry: WebKit keeps a failed module fetch that a
 * modulepreload link started (Vite adds one) for the life of the page, so
 * only a reload fetches it again.
 */
async function renderMermaid(runtime: Mermaid, renderId: string, source: string, options?: DiagramRenderOptions): Promise<DiagramRenderResult> {
  try {
    return await renderMermaidOnce(runtime, renderId, source, options);
  } catch (error) {
    if (!isChunkLoadFailure(error)) return mermaidFailure(error, false);
  }
  await wait(getMermaidRetryDelayMs());
  try {
    return await renderMermaidOnce(runtime, renderId, source, options);
  } catch (error) {
    return mermaidFailure(error, isChunkLoadFailure(error));
  }
}

function mermaidFailure(error: unknown, chunkFailed: boolean): DiagramRenderResult {
  return {
    ok: false,
    message: errorMessage(error, 'Failed to render diagram'),
    line: chunkFailed ? null : errorLine(error),
    runtimeUnavailable: false,
    ...(chunkFailed ? { chunkFailed: true } : {}),
  };
}

/**
 * Mermaid renders into a temporary `<div id="d{id}">` (an `<iframe
 * id="i{id}">` when sandboxed) that it appends to `document.body`. When the
 * source does not parse, or a diagram-type chunk does not load (Mermaid
 * reports both as a parse failure), it draws its own "Syntax error in text"
 * graphic there and throws WITHOUT removing it; a draw error does the same.
 * Each render has its own id, so nothing ever removed it: every failed render
 * left that graphic at the bottom of the page, under the app, one more per
 * re-render (a theme change). The block shows the failure itself, so the
 * temporary nodes go after every failed render.
 */
function removeMermaidLeftovers(renderId: string): void {
  if (typeof document === 'undefined') return;
  document.getElementById(`d${renderId}`)?.remove();
  document.getElementById(`i${renderId}`)?.remove();
}

/** One render; a throw (a parse error, a chunk that did not load) is the caller's. */
async function renderMermaidOnce(runtime: Mermaid, renderId: string, source: string, options?: DiagramRenderOptions): Promise<DiagramRenderResult> {
  let svg: string;
  try {
    ({ svg } = await runtime.render(renderId, source));
  } catch (error) {
    removeMermaidLeftovers(renderId);
    throw error;
  }
  const svgNode = sanitizeFor(svg, options);
  if (svgNode === REFUSED) return REFUSED_RESULT;
  if (svgNode === null) {
    return { ok: false, message: 'The diagram could not be rendered.', line: null, runtimeUnavailable: false };
  }
  widenEdgeHitAreas(svgNode);
  keepMathLabelsInPlace(svgNode);
  return { ok: true, svgNode, findTarget: MERMAID_FINDER.findTarget };
}

/**
 * A `$$...$$` label is KaTeX's MathML in a `<span class="katex">` inside the
 * label's `<foreignObject>`, and KaTeX's stylesheet makes that span
 * `position: relative`. WebKit (Safari) paints positioned html inside a
 * `<foreignObject>` without the svg's placement: the formula showed at the
 * diagram's top-left corner and its node stayed empty. Mermaid asks KaTeX for
 * MathML only, so nothing inside the span is positioned against it, and
 * `static` draws the same in every other browser. Runs after the scrub, which
 * keeps a `static` position anyway (`keepContainedDeclarations`).
 */
function keepMathLabelsInPlace(svg: SVGSVGElement): void {
  for (const wrapper of Array.from(svg.querySelectorAll('.katex'))) {
    (wrapper as HTMLElement).style?.setProperty('position', 'static');
  }
}

const mermaidRenderer: DiagramRenderer = {
  finder: MERMAID_FINDER,
  async render(renderId, source, theme, options) {
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
    // runtime plus (palette, mode, shadow amount), so the lazy runtime is
    // themed on its first render and re-initialized only when one changes.
    // With no tokens on the page it is a no-op and the static
    // MERMAID_CONFIG (securityLevel strict) applies.
    //
    // With `configurePlannotatorUI({ diagramRemoteLoads: false })`, read here
    // at each render, the runtime is initialized with the no-remote label
    // pass (`remoteLoadsMode`); otherwise exactly as before.
    const themeKey = mermaidThemeKey(theme.colorTheme, theme.mode, theme.shadowAmount);
    applyMermaidTheme(runtime, themeKey, undefined, getDiagramRemoteLoads() ? 'remote' : await remoteLoadsMode(runtime, themeKey));
    return renderMermaid(runtime, renderId, source, options);
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
  async render(_renderId, source, _theme, options) {
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
      const svgNode = sanitizeFor(result.output, options);
      if (svgNode === REFUSED) return REFUSED_RESULT;
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

/**
 * The Pele entry (`./pele`, lazy): the same sanitizer and hit layer as
 * Mermaid, then Pele's colour variables from the page's palette
 * (`peleTheme.ts`) on the svg root. Pele draws no `<a>` and no `<image>`
 * (links and images are off), and its own sheet is inline `style`
 * attributes, so the scoped-`<style>` pass has nothing to keep.
 */
async function renderPele(renderId: string, source: string, theme: DiagramTheme, options?: DiagramRenderOptions): Promise<DiagramRenderResult> {
  let runtime: Awaited<ReturnType<typeof loadPeleRuntime>>;
  try {
    runtime = await loadWithRetry(loadPeleRuntime, getMermaidRetryDelayMs());
  } catch (error) {
    return { ok: false, message: errorMessage(error, 'The Pele engine could not be loaded.'), line: null, runtimeUnavailable: true };
  }
  if (source.length > PELE_SOURCE_LIMIT) {
    return { ok: false, message: `Diagram source exceeds the ${PELE_SOURCE_LIMIT.toLocaleString()} character limit.`, line: null, runtimeUnavailable: false };
  }
  let supported = false;
  try {
    supported = await runtime.supports(source);
  } catch {
    supported = false;
  }
  if (!supported) {
    return { ok: false, message: 'Pele does not draw this diagram type.', line: null, runtimeUnavailable: false, unsupported: true };
  }
  // Math and styled text in labels (`pele-labels.ts`): the source Pele draws, then its svg finished. Inside the
  // try: a step that throws is this fence's error (so 'pele-where-safe' falls back), never a rejected render.
  let labels: PreparedPeleLabels | null = null;
  try {
    const fonts = peleFonts();
    if (needsPeleLabels(source)) {
      const typesetter = hasMermaidMath(source) ? await pageMathTypesetter(fonts.sans) : null;
      labels = preparePeleLabels(source, typesetter);
    }
    const prepared = labels;
    let measurer: TextMeasurer | undefined;
    const result = await renderPeleSource(runtime, prepared?.text ?? source, renderId, fonts, prepared === null ? undefined : (base) => (measurer = peleLabelMeasurer(base, prepared)));
    const markup = result.svg.length > PELE_OUTPUT_LIMIT || prepared === null ? result.svg : finishPeleLabels(result.svg, prepared, measurer ?? peleLabelMeasurer(undefined, prepared));
    // Again after the formulas are in: their MathML is not part of what Pele measured.
    if (markup.length > PELE_OUTPUT_LIMIT) {
      return { ok: false, message: `Rendered diagram exceeds the ${PELE_OUTPUT_LIMIT.toLocaleString()} character limit.`, line: null, runtimeUnavailable: false };
    }
    const svgNode = sanitizeFor(markup, options);
    if (svgNode === REFUSED) return REFUSED_RESULT;
    if (svgNode === null) {
      return { ok: false, message: 'The diagram could not be rendered.', line: null, runtimeUnavailable: false };
    }
    svgNode.id = peleSvgId(renderId);
    scrubFetchingStyles(svgNode);
    // An author's sizes (`stroke-dasharray:0.0001`, `stroke-width:9999px`) held to sane ranges (`peleStyleClamp.ts`).
    clampPeleStyles(svgNode);
    const personColors = readPeleThemeVariables(theme.mode);
    // The colours an author spells out, over the person's palette; never a theme name, never a panel (`peleAuthorTheme.ts`).
    const author = peleAuthorColors(source, personColors);
    applyPeleThemeVariables(svgNode, author?.vars ?? personColors);
    if (author !== null && author.rules.length > 0) {
      const sheet = svgNode.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style');
      sheet.textContent = scopeDiagramCss(author.rules.map((r) => `#${svgNode.id} ${r.selector}{${r.property}:${r.value}}`).join(' '), svgNode.id);
      if (sheet.textContent !== '') svgNode.prepend(sheet);
    }
    // The Diagram Shadow setting: one rule scoped under this svg (built here, after the sanitizer, from numbers only).
    const shadow = peleShadowCss(svgNode, theme.mode, theme.shadowAmount);
    if (shadow !== null) {
      const sheet = svgNode.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style');
      sheet.textContent = scopeDiagramCss(shadow, svgNode.id);
      if (sheet.textContent !== '') svgNode.prepend(sheet);
    }
    widenEdgeHitAreas(svgNode);
    return { ok: true, svgNode, findTarget: PELE_FINDER.findTarget };
  } catch (error) {
    return { ok: false, message: restorePeleLabelMessage(errorMessage(error, 'Failed to render diagram'), labels), line: peleErrorLine(error), runtimeUnavailable: false };
  }
}

/** Pele writes its styling, an author's `style` and `classDef` included, as
 * inline `style` attributes: one that fetches (`url(https://…)`) goes. */
function scrubFetchingStyles(root: SVGSVGElement): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('[style]'))]) {
    const style = el.getAttribute('style');
    if (style !== null && cssFetches(style)) el.removeAttribute('style');
  }
}

/** Pele's errors carry a one-based `line` (0 when it has none). */
function peleErrorLine(error: unknown): number | null {
  const line = typeof error === 'object' && error !== null ? (error as { line?: unknown }).line : undefined;
  return typeof line === 'number' && Number.isFinite(line) && line > 0 ? line : null;
}

/**
 * Mermaid-syntax fences when the engine switch is not `'mermaid'`
 * (`diagram-engine.ts`). The finder reads whichever grammar the displayed
 * svg has, so a fence that fell back to Mermaid keeps Mermaid's part
 * comments. In `'pele-where-safe'` a Pele failure that is not a host's
 * refusal is drawn by Mermaid instead.
 */
const engineSwitchRenderer: DiagramRenderer = {
  finder: PELE_COMPAT_FINDER,
  async render(renderId, source, theme, options) {
    const mode = diagramEngineMode();
    if (diagramEngineFor(source, { mode }).engine === 'mermaid') return mermaidRenderer.render(renderId, source, theme, options);
    const result = await renderPele(renderId, source, theme, options);
    if (result.ok === true || result.refused === true || mode !== 'pele-where-safe') return result;
    return mermaidRenderer.render(renderId, source, theme, options);
  },
};

/**
 * The engine switch's renderer, when Pele is part of the build
 * (`PELE_IN_BUILD`, false while `DIAGRAM_ENGINE_MODE` is `'mermaid'`). A
 * conditional on that constant, so a shipped build drops the switch and all
 * of Plannotator's Pele code behind it (`renderPele`, the Pele finders,
 * `peleTheme`), not only Pele's library.
 */
let engineSwitch: DiagramRenderer | undefined = PELE_IN_BUILD ? engineSwitchRenderer : undefined;

/** Test hook: route Mermaid fences through the engine switch, as a build
 * with Pele in it does (`test-setup/pele.ts`); `undefined` restores the
 * build's own choice. */
export function __setPeleInBuildForTests(on: boolean | undefined): void {
  engineSwitch = (on ?? PELE_IN_BUILD) ? engineSwitchRenderer : undefined;
}

/** The renderer for a kind. With the switch on `'mermaid'` (the shipped
 * value) a Mermaid fence gets exactly the Mermaid entry above. */
function rendererFor(kind: DiagramKind): DiagramRenderer {
  if (kind === 'graphviz') return graphvizRenderer;
  return engineSwitch === undefined || diagramEngineMode() === 'mermaid' ? mermaidRenderer : engineSwitch;
}

/** The finder for a kind, synchronously: the viewer wires the pointer and
 * the anchors to it before the first render lands. */
export function diagramFinder(kind: DiagramKind): DiagramFinder {
  return rendererFor(kind).finder;
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
  options?: DiagramRenderOptions,
): Promise<DiagramRenderResult> {
  return rendererFor(kind).render(renderId, source, theme, options);
}
