/**
 * The skill references in the person's sent message, painted as the composer
 * paints them (approval "inbox-skill-references", shot 06): `$write-better`
 * in the primary color on a light wash, a human-only one also underlined
 * dotted. Painted with the CSS Custom Highlight API, like search's landing
 * highlight (search/highlight.ts), so the Viewer's DOM is never changed. The
 * skills are the ones the message's own block names (what was sent), never
 * the live catalog, so a skill uninstalled since still reads as it was sent.
 * Where the API is missing (an older browser, the DOM tests) nothing is
 * painted and the words read as plain text.
 */
import type { InboxSkillReference } from '@plannotator/core/skill-reference-block';
import { findSkillReferenceTokens, type SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';

/** The highlights' names in `CSS.highlights` (inbox.css styles `::highlight(…)`). */
export const SKILL_REF_HIGHLIGHT = 'ib-skill-ref';
export const SKILL_REF_HUMAN_HIGHLIGHT = 'ib-skill-ref-human';

/** Text the references are never found in: code, the folded block itself, and form fields. */
const SKIP = 'pre, code, [data-skills-line], [data-fold-head], script, style, textarea';

/** The ranges of the named skills' references in the text under `root`. */
export function skillReferenceRanges(root: Node, skills: readonly InboxSkillReference[]): { plain: Range[]; human: Range[] } {
  const out = { plain: [] as Range[], human: [] as Range[] };
  if (skills.length === 0) return out;
  const catalog: SkillCatalogEntry[] = skills.map((s) => ({ name: s.name, root: 'universal', humanOnly: s.humanOnly }));
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (const token of findSkillReferenceTokens(node.data, catalog)) {
      const range = doc.createRange();
      range.setStart(node, token.start);
      range.setEnd(node, token.end);
      (token.entry.humanOnly ? out.human : out.plain).push(range);
    }
  }
  return out;
}

interface HighlightApi {
  highlights: { set(name: string, value: unknown): void; delete(name: string): void };
  Highlight: new (...ranges: Range[]) => unknown;
}

function api(): HighlightApi | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightApi['highlights'] } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightApi['Highlight'] }).Highlight;
  return css?.highlights && typeof Highlight === 'function' ? { highlights: css.highlights, Highlight } : null;
}

// One registry name per kind for the whole window, so every sent message's ranges are gathered here.
const painted = new Map<string, { plain: Range[]; human: Range[] }>();

function publish(registry: HighlightApi): void {
  const plain = [...painted.values()].flatMap((r) => r.plain);
  const human = [...painted.values()].flatMap((r) => r.human);
  if (plain.length > 0) registry.highlights.set(SKILL_REF_HIGHLIGHT, new registry.Highlight(...plain));
  else registry.highlights.delete(SKILL_REF_HIGHLIGHT);
  if (human.length > 0) registry.highlights.set(SKILL_REF_HUMAN_HIGHLIGHT, new registry.Highlight(...human));
  else registry.highlights.delete(SKILL_REF_HUMAN_HIGHLIGHT);
}

/**
 * Paint one message's references under `root`, again whenever its DOM
 * changes (the Viewer redrawing a block would leave stale ranges). Returns
 * the cleanup that unpaints it.
 */
export function paintSkillReferences(key: string, root: HTMLElement, skills: readonly InboxSkillReference[]): () => void {
  const registry = api();
  if (!registry || skills.length === 0) return () => {};
  const paint = () => {
    painted.set(key, skillReferenceRanges(root, skills));
    publish(registry);
  };
  paint();
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    painted.delete(key);
    publish(registry);
  };
}
