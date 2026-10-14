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
import { QUESTION_ANSWERS_HEADING } from '@plannotator/core/question-block';
import { findSkillReferenceTokens, type SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { ATTACHMENT_FEEDBACK_HEADING, GUIDE_FEEDBACK_TITLE } from './attachments';

/** The highlights' names in `CSS.highlights` (inbox.css styles `::highlight(…)`). */
export const SKILL_REF_HIGHLIGHT = 'ib-skill-ref';
export const SKILL_REF_HUMAN_HIGHLIGHT = 'ib-skill-ref-human';

/** Text the references are never found in: code, the folded block itself, and form fields. */
const SKIP = 'pre, code, [data-skills-line], [data-fold-head], script, style, textarea';

/**
 * Where the person's own words end: the first heading of what the Send wrote
 * after them (the answers section, the attached files' or a guided review's
 * feedback). Those quote agent text, so a `$name` there is not the person's.
 */
const SECTION_HEADINGS = [QUESTION_ANSWERS_HEADING, ATTACHMENT_FEEDBACK_HEADING.title, GUIDE_FEEDBACK_TITLE];

function wordsEnd(root: Node): Element | null {
  if (!(root instanceof Element)) return null;
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const text = heading.textContent?.trim() ?? '';
    if (SECTION_HEADINGS.some((title) => text.startsWith(title))) return heading;
  }
  return null;
}

/** The ranges of the named skills' references in the person's own words under `root` (before the sections a Send writes after them). */
export function skillReferenceRanges(root: Node, skills: readonly InboxSkillReference[]): { plain: Range[]; human: Range[] } {
  const out = { plain: [] as Range[], human: [] as Range[] };
  if (skills.length === 0) return out;
  const catalog: SkillCatalogEntry[] = skills.map((s) => ({ name: s.name, root: 'universal', humanOnly: s.humanOnly }));
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const end = wordsEnd(root);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (end && end.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) break;
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
  Highlight: new (...ranges: Range[]) => { priority: number };
}

/** Below search's landing highlight (`ib-search-hit`, priority 0), so a search hit on a reference shows as a hit. */
const PRIORITY = -1;

function highlightOf(registry: HighlightApi, ranges: Range[]): unknown {
  const highlight = new registry.Highlight(...ranges);
  highlight.priority = PRIORITY;
  return highlight;
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
  if (plain.length > 0) registry.highlights.set(SKILL_REF_HIGHLIGHT, highlightOf(registry, plain));
  else registry.highlights.delete(SKILL_REF_HIGHLIGHT);
  if (human.length > 0) registry.highlights.set(SKILL_REF_HUMAN_HIGHLIGHT, highlightOf(registry, human));
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
