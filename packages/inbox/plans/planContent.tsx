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
 * Whether a Mermaid source could reach another host (or take the tab away) when drawn or clicked. Decided by
 * principle, not by Mermaid feature: a fetch to another host needs an absolute address once everything is decoded,
 * that is a scheme (`https:`, with or without `//`: `https:host/x` resolves to `host`) or `//`, and every way to spell
 * one indirectly needs a backslash (YAML, JSON and CSS escapes; a URL reads `\` as `/`) or a character reference
 * (`&#58;`, `#58;`, `&colon;`: Mermaid turns `#…;` into `&…;` in the SVG it writes). A URL parser also drops tabs and
 * line breaks inside an address (`ht⇥tps:`), so those are removed before looking. Percent-encoding and fullwidth
 * characters cannot make a scheme or `//`.
 *
 * A character reference is any `&…;` or `#…;`, except one that cannot decode to ASCII: a number at or above 128, or a
 * name made only of hex digits (a colour, `color:#fff;`). On top, belt and braces: a node picture or link key (`img`,
 * `src`, `href`, quoted or not), an html tag that loads, CSS that fetches (`url(`, `@import`), and any `click` line.
 */
const REMOTE_ADDRESS = /(?:https?|ftp|wss?):|\/\/|\\/i;
const CHARACTER_REFERENCE = /(?:&#?|#)\+?(\w+);/g;
const MAY_LOAD_FEATURE = /url\s*\(|@import|<\s*(?:img|image|svg|iframe|object|embed|link|video|audio|source)\b|\b(?:img|src|href)\b|^\s*click\b/im;

function decodesToAscii(name: string): boolean {
  if (/^\d+$/.test(name)) return Number(name) < 128;
  if (/^x[0-9a-f]+$/i.test(name)) return parseInt(name.slice(1), 16) < 128;
  return !/^[0-9a-f]+$/i.test(name);
}

/** The principle alone: an absolute address, or a way to spell one indirectly. */
export function mermaidMayReachAnotherHost(source: string): boolean {
  const flat = source.replace(/[\t\n\r]/g, '');
  if (REMOTE_ADDRESS.test(flat)) return true;
  for (const match of flat.matchAll(CHARACTER_REFERENCE)) if (decodesToAscii(match[1]!)) return true;
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
