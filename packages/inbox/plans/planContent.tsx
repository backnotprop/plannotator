/**
 * What a plan's own words may do when drawn in the window (the document and the diff alike). A plan is an agent's
 * text, so:
 * - pictures: only one written into the plan (`data:image/…`) shows; any other (`https:`, a path on the agent's
 *   computer) is a quiet placeholder with its alt text, never fetched, so opening a plan or its diff tells no
 *   third party you read it;
 * - links: an http(s) link opens in a new tab (the renderer's own rule); a relative path or any other scheme
 *   (`mailto:`, an editor's) is inert text with its target as a tooltip, so a click never takes the Inbox tab away;
 *   an in-page `#anchor` still scrolls the plan;
 * - diagrams: a Mermaid fence whose source could load something (`mermaidMayLoad`) is shown as its source, not drawn;
 *   and any diagram whose drawn svg could load from another host or document (`acceptPlanDiagramSvg`, checked before
 *   it reaches the page) is shown as its source too.
 */
import { useMemo, type ReactNode } from 'react';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import { LocalLinkContext, LocalLinkMatchContext, type LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import { isMermaidLanguage } from '@plannotator/ui/components/diagramLanguages';
import { DiagramSvgAcceptContext } from '@plannotator/ui/components/diagramSvgAccept';
import type { Block } from '@plannotator/ui/types';

export const resolvePlanImage: ImageResolver = (src) => (/^data:image\//i.test(src.trim()) ? { kind: 'src', src } : { kind: 'unavailable', title: src });

/** Every link but a web one and an in-page anchor. */
export const isInertPlanLink = (href: string): boolean => {
  const target = href.trim();
  return target !== '' && !target.startsWith('#') && !target.startsWith('//') && !/^https?:/i.test(target);
};

export const resolvePlanLink: LocalLinkResolver = (href) => ({ kind: 'unavailable', title: href });

/**
 * Whether a Mermaid source could reach another host (or take the tab away) when drawn or clicked. Decided by class,
 * not by Mermaid feature. A fetch to another host needs an absolute address once everything is decoded: a scheme
 * (`https:`, with or without `//`: `https:host/x` resolves to `host`) or `//`. Every way to spell one indirectly, and
 * every place one could hide, is refused whole:
 * - a backslash (YAML, JSON and CSS escapes; a URL reads `\` as `/`);
 * - an HTML character reference: `&#` anywhere, or `&` and a letter, with or without the final `;` (an HTML parser
 *   decodes `&#58` too). `A & B` (Mermaid's join, with spaces) still draws; `A&B` shows as source;
 * - Mermaid's own `#…;` (it writes `&…;` into the SVG) when it can decode to ASCII: a number below 128 or a name not
 *   made only of hex digits (so colours like `color:#fff;` still draw), except `#quot;`, Mermaid's quote escape;
 * - HTML in a label: `<` and a letter, `/`, `!` or `?`, except `<br>` (`<br/>`, `<br />`) and a class diagram's
 *   `<<interface>>`. No list of attributes that load (`background`, `src`, …) to keep up to date.
 * A URL parser drops tabs and line breaks inside an address (`ht⇥tps:`), so those are removed before looking.
 * Percent-encoding and fullwidth characters cannot make a scheme or `//`. On top: a picture or link key (`img`, `src`,
 * `href`, quoted or not, then `:` or `=`), CSS that fetches (`url(`, `@import`), and any `click` line.
 */
const REMOTE_ADDRESS = /(?:https?|ftp|wss?):|\/\/|\\/i;
const HTML_REFERENCE = /&#|&[a-z]/i;
const MERMAID_REFERENCE = /#\+?(\w+);/g;
const HTML_TAG = /<(?!br\s*\/?\s*>)[a-z/!?]/i;
const CLASS_ANNOTATION = /<<[a-z]+>>/gi;
const MAY_LOAD_FEATURE = /url\s*\(|@import|["']?\b(?:img|src|href)\b["']?\s*[:=]|^\s*click\b/im;

function decodesToAscii(name: string): boolean {
  if (name === 'quot') return false;
  if (/^\d+$/.test(name)) return Number(name) < 128;
  if (/^x[0-9a-f]+$/i.test(name)) return parseInt(name.slice(1), 16) < 128;
  return !/^[0-9a-f]+$/i.test(name);
}

/** The classes alone: an absolute address, a way to spell one indirectly, or HTML that could carry one. */
export function mermaidMayReachAnotherHost(source: string): boolean {
  // Mermaid's own placeholders first, decoded across the whole SVG it writes (`decodeEntities`): `ﬂ°°` is `&#`, `ﬂ°` is
  // `&`, `¶ß` is `;`. A plan may type them itself.
  const flat = source.replace(/ﬂ°°/g, '&#').replace(/ﬂ°/g, '&').replace(/¶ß/g, ';').replace(/[\t\n\r]/g, '');
  if (REMOTE_ADDRESS.test(flat) || HTML_REFERENCE.test(flat) || HTML_TAG.test(flat.replace(CLASS_ANNOTATION, ''))) return true;
  for (const match of flat.matchAll(MERMAID_REFERENCE)) if (decodesToAscii(match[1]!)) return true;
  return false;
}

export const mermaidMayLoad = (source: string): boolean => mermaidMayReachAnotherHost(source) || MAY_LOAD_FEATURE.test(source);

/** A plan's blocks with every Mermaid fence that `mermaidMayLoad` drawn as its plain source instead of a diagram. */
export function planBlocks(blocks: Block[]): Block[] {
  return blocks.map((block) => (block.type === 'code' && isMermaidLanguage(block.language) && mermaidMayLoad(block.content) ? { ...block, language: 'text' } : block));
}

/**
 * The backstop after Mermaid (or Graphviz) has drawn, independent of its syntax: the drawn svg, parsed but not yet in
 * the page, is refused (shown as its source) when anything in it could load from another host or another document:
 * - a reference attribute (`href`, `xlink:href`, `src`, `srcset`, `background`, `poster`, `data`, …) that resolves,
 *   against this page, to another origin (`data:` and same-document `#id` are fine);
 * - on an element that loads what it names (`<image>`, `<img>`, `<use>`, `<feImage>`, `<iframe>`, `<object>`, …), any
 *   reference that is not `#id` or `data:`;
 * - CSS, in a `style` attribute, a presentation attribute or a `<style>`, with `url(` to anything but `#id` or
 *   `data:`, any `@import`, `image-set(`-like loaders, or a backslash (a CSS escape).
 * Mermaid's own markers (`marker-end="url(#arrowhead)"`) and same-document links pass.
 */
const REFERENCE_ATTRIBUTES = new Set(['href', 'xlink:href', 'src', 'srcset', 'background', 'poster', 'data', 'action', 'formaction', 'lowsrc', 'dynsrc', 'longdesc', 'cite', 'codebase', 'archive', 'manifest', 'icon', 'ping']);
const LOADING_ELEMENTS = new Set(['image', 'img', 'use', 'feimage', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'track', 'script', 'link', 'input', 'picture', 'frame']);
const CSS_LOADER = /@import|\\|image-set\s*\(|\bimage\s*\(|cross-fade\s*\(|\bsrc\s*\(|\bpaint\s*\(|\belement\s*\(/i;
const CSS_URL = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

const inDocument = (value: string): boolean => {
  const target = value.trim();
  return target === '' || target.startsWith('#') || /^data:/i.test(target);
};

function anotherOrigin(value: string): boolean {
  if (inDocument(value)) return false;
  const page = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  try {
    return new URL(value.trim(), page).origin !== new URL(page).origin;
  } catch {
    return true;
  }
}

function cssLoads(text: string): boolean {
  if (CSS_LOADER.test(text)) return true;
  for (const match of text.matchAll(CSS_URL)) if (!inDocument(match[2]!)) return true;
  // A `url(` the pattern above could not read (unbalanced, odd quoting) is refused too.
  return (text.match(/url\s*\(/gi)?.length ?? 0) !== [...text.matchAll(CSS_URL)].length;
}

export function acceptPlanDiagramSvg(svg: SVGSVGElement): boolean {
  for (const el of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    const tag = el.localName.toLowerCase();
    if (tag === 'style' && cssLoads(el.textContent ?? '')) return false;
    for (const attribute of Array.from(el.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (REFERENCE_ATTRIBUTES.has(name) || name.endsWith(':href')) {
        const targets = name === 'srcset' ? value.split(',').map((candidate) => candidate.trim().split(/\s+/, 1)[0] ?? '') : [value];
        for (const target of targets) {
          if (anotherOrigin(target)) return false;
          if (LOADING_ELEMENTS.has(tag) && !inDocument(target)) return false;
        }
      } else if ((name === 'style' || /url\s*\(|\\/i.test(value)) && cssLoads(value)) {
        return false;
      }
    }
  }
  return true;
}

/** The rules above for everything drawn inside (the Viewer takes `resolvePlanLink` as its own prop as well). */
export function PlanContentRules({ children }: { children: ReactNode }) {
  return (
    <ImageResolverContext.Provider value={resolvePlanImage}>
      <LocalLinkMatchContext.Provider value={isInertPlanLink}>
        <LocalLinkContext.Provider value={resolvePlanLink}>
          <DiagramSvgAcceptContext.Provider value={acceptPlanDiagramSvg}>{children}</DiagramSvgAcceptContext.Provider>
        </LocalLinkContext.Provider>
      </LocalLinkMatchContext.Provider>
    </ImageResolverContext.Provider>
  );
}

/**
 * An HTML page of a plan (an `html` document or artifact) runs nothing and loads nothing: it is drawn in a frame with
 * every sandbox flag (no script, an opaque origin, no automatic refresh, no popups, no navigating the window) under its
 * own policy, written before anything of its own, that allows only its inline styles and pictures written into it
 * (`data:`); its links go nowhere (`linksGoNowhere`).
 */
export const PLAN_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

/** Links that ask the browser to reach a host before anything is opened (no policy reliably covers them). */
const RESOURCE_HINTS = 'link[rel~="dns-prefetch" i], link[rel~="preconnect" i], link[rel~="prefetch" i], link[rel~="prerender" i], link[rel~="preload" i], link[rel~="modulepreload" i]';

/**
 * A click on a link never takes the frame anywhere. Every link and image-map area opens a new window instead
 * (`target="_blank"`, its own `target` and the page's own `<base>` dropped), and a frame without `allow-popups` opens
 * none: the click does nothing. A link with no target follows the `<base target="_blank">` written first. Resource
 * hints (`dns-prefetch`, `preconnect`, …) are dropped, so a page never tells another host it was drawn, and so is a
 * `<meta http-equiv="refresh">` (the sandbox already stops it; the page does not depend on that alone). `still`: a
 * face on the Spaces home (`stillPage`; the selectors it hides go into `hidden`). Read in an inert document
 * (DOMParser runs and loads nothing); where there is none, the page is left as written.
 */
function linksGoNowhere(html: string, still = false, hidden: string[] = []): string {
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const base of doc.querySelectorAll('base')) base.remove();
  for (const link of doc.querySelectorAll('a, area, form')) link.setAttribute('target', '_blank');
  for (const hint of doc.querySelectorAll(RESOURCE_HINTS)) hint.remove();
  for (const meta of doc.querySelectorAll('meta[http-equiv]')) if (/^\s*refresh\s*$/i.test(meta.getAttribute('http-equiv') ?? '')) meta.remove();
  if (still) hidden.push(...stillPage(doc));
  return doc.documentElement.outerHTML;
}

const POLICY_HEAD = `<meta http-equiv="Content-Security-Policy" content="${PLAN_HTML_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off"><base target="_blank">`;

export function planHtmlSrcdoc(html: string): string {
  // Always first, never after a `<head>` found by a pattern (one written inside a comment would swallow it): the
  // parser opens the head for it, and the page's own `<html>` and `<head>` after it only join that one.
  return `${POLICY_HEAD}${linksGoNowhere(html)}`;
}

/**
 * A face's first cascade layer, named at random for each face (so a page cannot write into it, or into a sublayer of
 * it): its `!important` wins over every rule of the page's own style sheets, layered or not, so nothing animates or
 * transitions. A `style` attribute ranks above every layer, so `stillPage` rewrites each one through the CSSOM.
 * `hidden`: the selectors of the page's rules that loop forever (a loading ring), hidden in the same layer: a still
 * page shows what it shows when it has finished, never a ring stopped mid-turn.
 */
function stillStyle(hidden: readonly string[] = []): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const name = `still-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  // One rule each (one the browser cannot read drops only itself); a selector that could end the style element is none.
  const hide = hidden
    .filter((s) => !s.includes('<') && !/[{};]/.test(s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')))
    .map((s) => `${s}{visibility:hidden!important}`)
    .join('');
  return `<style>@layer ${name}{*,*::before,*::after,*::marker{animation:none!important;transition:none!important;scroll-behavior:auto!important}${hide}}</style>`;
}

/**
 * An HTML page as a face on the Spaces home (approval "plans-home": "Idle page: nothing moves. Reduced motion: nothing
 * moves."): the plan page's frame rules (`planHtmlSrcdoc`), plus no motion (`stillPage`), plus its own still layer.
 * The page is read and written again until it reads back the same (a page whose markup parses differently the second
 * time, so a rule could have missed a part, settles in a round or two); one that does not settle has no face: null.
 */
export function planFaceSrcdoc(html: string): string | null {
  if (typeof DOMParser === 'undefined') return null;
  let page = linksGoNowhere(html, true);
  for (let round = 0; round < 3; round++) {
    const hidden: string[] = [];
    const again = linksGoNowhere(page, true, hidden);
    if (again === page) return `${POLICY_HEAD}${stillStyle(hidden)}${page}`;
    page = again;
  }
  return null;
}

/** Whether an animation's iteration count (one or a list) loops forever. */
const loopsForever = (count: string) => /\binfinite\b/i.test(count);

/**
 * The selectors of a style sheet's rules that animate forever, read through the CSSOM (a constructed sheet: it loads
 * nothing; a page that will not parse gives none), as the CSSOM writes them back.
 */
function foreverSelectors(css: string): string[] {
  if (typeof CSSStyleSheet === 'undefined') return [];
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of [...rules]) {
      const style = (rule as CSSStyleRule).style;
      const selector = (rule as CSSStyleRule).selectorText;
      if (style && typeof selector === 'string' && selector && loopsForever(style.getPropertyValue('animation-iteration-count') || style.getPropertyValue('animation'))) {
        out.push(selector);
      }
      const inner = (rule as CSSGroupingRule).cssRules;
      if (inner) walk(inner);
    }
  };
  try {
    walk(sheet.cssRules);
  } catch {
    return out;
  }
  return out;
}

/** A transparent still pixel: what a moving picture becomes in a face (its size and place kept). */
const STILL_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Elements that draw another document (none of our rules would reach inside it): a face has none. */
const NESTED_DOCUMENTS = 'iframe, frame, frameset, object, embed, portal, fencedframe';
/** SVG's own animation elements, by local name (lower case). */
const SVG_MOTION = new Set(['animate', 'animatetransform', 'animatemotion', 'animatecolor', 'set', 'discard']);

/**
 * No motion in a face's page: no nested document; a `<template>` that would become a shadow tree (our layer does not
 * reach into one) stays an inert template; a `<marquee>` a plain block; SVG animation elements gone; an indeterminate
 * `<progress>` stopped; no `autoplay`; every `style` attribute rewritten through the CSSOM (so a comment, an escape or
 * `!important` in it changes nothing) with motion off and moving pictures stilled; each `<style>` with its moving
 * pictures stilled (`stillCss`); every attribute that is a moving `data:` picture the still pixel; no `srcset` or
 * `<picture>` source (each could move).
 */
function stillPage(doc: Document): string[] {
  const hidden: string[] = [];
  for (const el of [...doc.querySelectorAll(NESTED_DOCUMENTS)]) el.remove();
  for (const template of doc.querySelectorAll('template')) {
    template.removeAttribute('shadowrootmode');
    template.removeAttribute('shadowroot');
  }
  for (const marquee of [...doc.querySelectorAll('marquee')]) {
    const block = doc.createElement('div');
    for (const attr of ['class', 'id', 'style', 'dir', 'lang', 'title']) {
      const value = marquee.getAttribute(attr);
      if (value !== null) block.setAttribute(attr, value);
    }
    block.append(...marquee.childNodes);
    marquee.replaceWith(block);
  }
  for (const el of [...doc.querySelectorAll('*')]) {
    if (!SVG_MOTION.has(el.localName.toLowerCase())) continue;
    // An SVG that turns forever is a loading ring: hidden whole, not stopped mid-turn.
    if (/indefinite/i.test(`${el.getAttribute('repeatCount') ?? ''} ${el.getAttribute('repeatDur') ?? ''}`)) el.closest('svg')?.setAttribute('visibility', 'hidden');
    el.remove();
  }
  for (const bar of doc.querySelectorAll('progress:not([value])')) bar.setAttribute('value', '0');
  for (const el of doc.querySelectorAll('[autoplay]')) el.removeAttribute('autoplay');
  for (const el of doc.querySelectorAll('[style]')) stillInlineStyle(el);
  for (const sheet of doc.querySelectorAll('style')) {
    const css = sheet.textContent ?? '';
    hidden.push(...foreverSelectors(css));
    const kept = stillCss(css);
    if (kept !== css) sheet.textContent = kept ?? '';
  }
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (attr.name !== 'style' && /^\s*data:image\//i.test(attr.value) && isMovingDataImage(attr.value)) el.setAttribute(attr.name, STILL_PIXEL);
    }
  }
  for (const el of doc.querySelectorAll('[srcset]')) el.removeAttribute('srcset');
  for (const source of doc.querySelectorAll('picture > source')) source.remove();
  return hidden;
}

/**
 * One `style` attribute, through the CSSOM: its animation and transition properties removed and set to none with
 * `!important` (the attribute then holds the parsed declarations, so nothing written to dodge a pattern is left), and
 * its moving pictures stilled. With no CSSOM for the element, or a picture hidden from `stillCss`, the attribute goes.
 */
function stillInlineStyle(el: Element): void {
  const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  if (!style || typeof style.setProperty !== 'function') {
    el.removeAttribute('style');
    return;
  }
  const names: string[] = [];
  for (let i = 0; i < style.length; i++) names.push(style.item(i));
  // An element that animates forever (a loading ring) is hidden: a still page is a finished one.
  if (loopsForever(style.getPropertyValue('animation-iteration-count') || style.getPropertyValue('animation'))) style.setProperty('visibility', 'hidden', 'important');
  for (const name of names) if (/animation|transition/i.test(name)) style.removeProperty(name);
  style.setProperty('animation', 'none', 'important');
  style.setProperty('transition', 'none', 'important');
  const css = el.getAttribute('style') ?? '';
  const kept = stillCss(css);
  if (kept === null) el.removeAttribute('style');
  else if (kept !== css) el.setAttribute('style', kept);
}

/** CSS's own escapes undone (`\61` and `\a` are both "a"; an escaped line break is nothing). */
function unescapeCss(text: string): string {
  return text.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|([\s\S]))/gi, (_, hex: string | undefined, _nl: string | undefined, char: string | undefined) => {
    if (hex) {
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
    }
    return char ?? '';
  });
}

const DATA_IMAGE = /data:image\//gi;
const countDataImages = (text: string) => text.match(DATA_IMAGE)?.length ?? 0;

/**
 * CSS with each moving `data:` picture (in a string, so `image-set("data:…")` too, or in an unquoted `url(…)`) made the
 * still pixel. Read token by token: comments skipped, a string or URL read whole with its escapes undone. Then checked:
 * a `data:` picture this read did not see (an escaped `u\72l(…)`, say) means the CSS hides one: null (none of it).
 */
function stillCss(css: string): string | null {
  let out = '';
  let seen = 0;
  let i = 0;
  const still = (body: string) => {
    const url = unescapeCss(body).trim();
    seen += countDataImages(url);
    return /^data:image\//i.test(url) && isMovingDataImage(url);
  };
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      const body = css.slice(i + 1, Math.min(j, css.length));
      out += still(body) ? `${ch}${STILL_PIXEL}${ch}` : css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if ((ch === 'u' || ch === 'U') && /^url\(/i.test(css.slice(i, i + 4)) && !/[\w-]/.test(css[i - 1] ?? '')) {
      let j = i + 4;
      while (j < css.length && /\s/.test(css[j]!)) j++;
      if (css[j] === '"' || css[j] === "'") {
        out += css.slice(i, j);
        i = j;
        continue;
      }
      let k = j;
      while (k < css.length && css[k] !== ')') k += css[k] === '\\' ? 2 : 1;
      const body = css.slice(j, Math.min(k, css.length));
      out += still(body) ? `url(${STILL_PIXEL})` : css.slice(i, k + 1);
      i = k + 1;
      continue;
    }
    out += ch;
    i++;
  }
  const all = countDataImages(unescapeCss(css.replace(/\/\*[\s\S]*?(\*\/|$)/g, '')));
  return all > seen ? null : out;
}

/** A GIF's number of frames (counted to 2), or -1 when it cannot be read. */
function gifFrames(b: string): number {
  if (!/^GIF8[79]a/.test(b)) return -1;
  const at = (i: number) => b.charCodeAt(i);
  const table = (flags: number) => (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  const blocks = (i: number) => {
    while (i < b.length && at(i) !== 0) i += at(i) + 1;
    return i + 1;
  };
  let i = 13 + table(at(10));
  let frames = 0;
  while (i < b.length) {
    const c = at(i);
    if (c === 0x3b) return frames;
    if (c === 0x21) {
      i = blocks(i + 2);
    } else if (c === 0x2c) {
      if (++frames > 1) return frames;
      i = blocks(i + 10 + table(at(i + 9)) + 1);
    } else return -1;
  }
  return frames;
}

/** An SVG that moves by itself: any animation in it (after its own escapes), an entity (it could add one), or a moving
 * picture inside it. */
function svgMoves(text: string, depth: number): boolean {
  if (/<!ENTITY/i.test(text)) return true;
  const plain = unescapeCss(
    text
      .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16) || 0xfffd, 0x10ffff)))
      .replace(/&#([0-9]+);?/g, (_, d: string) => String.fromCodePoint(Math.min(parseInt(d, 10) || 0xfffd, 0x10ffff))),
  ).replace(/\/\*[\s\S]*?(\*\/|$)/g, '');
  if (/<([\w.-]+:)?(animate|animateTransform|animateMotion|animateColor|set)\b/i.test(plain)) return true;
  if (/keyframes|animation[\w-]*\s*:|transition[\w-]*\s*:/i.test(plain)) return true;
  for (const inner of plain.match(/data:image\/[^"'()\s<>]+/gi) ?? []) {
    if (depth >= 2 || isMovingDataImage(inner, depth + 1)) return true;
  }
  return false;
}

/**
 * A `data:` picture that moves by itself: a GIF with more than one frame (or one that cannot be read), a WebP with an
 * `ANIM` chunk, an APNG (`acTL`), an AVIF sequence (`avis`), or an SVG that moves (`svgMoves`). A body that cannot be
 * decoded counts as moving. Anything not a `data:` picture: false.
 */
export function isMovingDataImage(url: string, depth = 0): boolean {
  const match = /^\s*data:image\/([a-z0-9.+-]+)((?:;[^,]*)?),(.*)$/is.exec(url);
  if (!match) return false;
  const type = match[1]!.toLowerCase();
  let bytes: string;
  if (/;base64/i.test(match[2]!)) {
    try {
      bytes = atob(match[3]!.replace(/\s+/g, '').replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
    } catch {
      return true;
    }
  } else {
    // Byte by byte, never failing (a bare "%" in an SVG's `width='100%'` is just a "%").
    bytes = match[3]!.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
  if (type === 'svg+xml' || type === 'svg') return svgMoves(bytes, depth);
  if (type === 'gif') return gifFrames(bytes) !== 1;
  if (type === 'webp') return bytes.includes('ANIM');
  if (type === 'png' || type === 'apng') return bytes.includes('acTL');
  if (type === 'avif' || type === 'avif-sequence') return bytes.slice(0, 64).includes('avis');
  // Types that never move; any other (JPEG XL, a type this list does not know) counts as moving.
  return !/^(jpeg|jpg|pjpeg|bmp|x-icon|vnd\.microsoft\.icon)$/.test(type);
}

export function PlanHtmlFrame({ html, title }: { html: string; title: string }) {
  const srcDoc = useMemo(() => planHtmlSrcdoc(html), [html]);
  return <iframe className="ib-plan-htmlframe" title={title} srcDoc={srcDoc} sandbox="" referrerPolicy="no-referrer" data-plan-html-frame="" />;
}
