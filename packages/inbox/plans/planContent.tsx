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
 * A Mermaid source that could load something or take the tab away while drawn or clicked: any URL (`https:`, `//`),
 * a node picture (`img:`, which Mermaid loads with `new Image()` before any sanitizer), an html label tag (`<img>`,
 * `<image>`, written raw or as an entity), CSS that fetches (`url(`, `@import`, in `themeCSS` or a `style`), a link
 * (`href`, `src`, a `click` line). Icon packs load nothing: Plannotator registers none.
 */
const MERMAID_MAY_LOAD = /\/\/|url\s*\(|@import|<\s*(?:img|image|svg|iframe|object|embed|link|video|audio|source)\b|(?:&|#)(?:lt|#?0*60|#?x0*3c);|\b(?:img|src|href)\s*[:=]|\bhref\b|^\s*click\b/im;
export const mermaidMayLoad = (source: string): boolean => MERMAID_MAY_LOAD.test(source);

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
