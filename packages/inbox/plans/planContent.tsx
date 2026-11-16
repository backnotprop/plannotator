/**
 * What a plan's own words may do when drawn in the window (the document and the diff alike). A plan is an agent's
 * text, so:
 * - pictures: only one written into the plan (`data:image/…`) shows; any other (`https:`, a path on the agent's
 *   computer) is a quiet placeholder with its alt text, never fetched, so opening a plan or its diff tells no
 *   third party you read it;
 * - links: an http(s) link opens in a new tab (the renderer's own rule); a relative path or any other scheme
 *   (`mailto:`, an editor's) is inert text with its target as a tooltip, so a click never takes the Inbox tab away;
 *   an in-page `#anchor` still scrolls the plan;
 * - diagrams: a Mermaid fence whose source could load something (`mermaidMayLoad`) is shown as its source, not drawn.
 */
import type { ReactNode } from 'react';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import { LocalLinkContext, LocalLinkMatchContext, type LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import { isMermaidLanguage } from '@plannotator/ui/components/diagramLanguages';
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
  const flat = source.replace(/[\t\n\r]/g, '');
  if (REMOTE_ADDRESS.test(flat) || HTML_REFERENCE.test(flat) || HTML_TAG.test(flat.replace(CLASS_ANNOTATION, ''))) return true;
  for (const match of flat.matchAll(MERMAID_REFERENCE)) if (decodesToAscii(match[1]!)) return true;
  return false;
}

export const mermaidMayLoad = (source: string): boolean => mermaidMayReachAnotherHost(source) || MAY_LOAD_FEATURE.test(source);

/** A plan's blocks with every Mermaid fence that `mermaidMayLoad` drawn as its plain source instead of a diagram. */
export function planBlocks(blocks: Block[]): Block[] {
  return blocks.map((block) => (block.type === 'code' && isMermaidLanguage(block.language) && mermaidMayLoad(block.content) ? { ...block, language: 'text' } : block));
}

/** The rules above for everything drawn inside (the Viewer takes `resolvePlanLink` as its own prop as well). */
export function PlanContentRules({ children }: { children: ReactNode }) {
  return (
    <ImageResolverContext.Provider value={resolvePlanImage}>
      <LocalLinkMatchContext.Provider value={isInertPlanLink}>
        <LocalLinkContext.Provider value={resolvePlanLink}>{children}</LocalLinkContext.Provider>
      </LocalLinkMatchContext.Provider>
    </ImageResolverContext.Provider>
  );
}
