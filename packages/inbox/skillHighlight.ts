import type { InboxSkillReference } from '@plannotator/core/skill-reference-block';
import { QUESTION_ANSWERS_HEADING } from '@plannotator/core/question-block';
import { findSkillReferenceTokens, type SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { ATTACHMENT_FEEDBACK_HEADING, GUIDE_FEEDBACK_TITLE, MESSAGE_FEEDBACK_HEADING } from './attachments';

export const SKILL_REF_HIGHLIGHT = 'ib-skill-ref';
export const SKILL_REF_HUMAN_HIGHLIGHT = 'ib-skill-ref-human';

const SKIP = 'pre, code, [data-skills-line], [data-fold-head], [data-open-head], [data-sent-answers], script, style, textarea';

const SECTION_HEADINGS = [QUESTION_ANSWERS_HEADING, MESSAGE_FEEDBACK_HEADING.title, ATTACHMENT_FEEDBACK_HEADING.title, GUIDE_FEEDBACK_TITLE];

function wordsEnd(root: Node): Element | null {
  if (!(root instanceof Element)) return null;
  const sent = root.querySelector('[data-sent-answers], [data-sent-rest], [data-reply-feedback]');
  if (sent) return sent;
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const text = heading.textContent?.trim() ?? '';
    if (SECTION_HEADINGS.some((title) => text.startsWith(title))) return heading;
  }
  return null;
}

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

const painted = new Map<string, { plain: Range[]; human: Range[] }>();

function publish(registry: HighlightApi): void {
  const plain = [...painted.values()].flatMap((r) => r.plain);
  const human = [...painted.values()].flatMap((r) => r.human);
  if (plain.length > 0) registry.highlights.set(SKILL_REF_HIGHLIGHT, highlightOf(registry, plain));
  else registry.highlights.delete(SKILL_REF_HIGHLIGHT);
  if (human.length > 0) registry.highlights.set(SKILL_REF_HUMAN_HIGHLIGHT, highlightOf(registry, human));
  else registry.highlights.delete(SKILL_REF_HUMAN_HIGHLIGHT);
}

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
