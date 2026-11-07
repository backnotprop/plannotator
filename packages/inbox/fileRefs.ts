/**
 * Design prototype "file-refs-open-pane": every file an agent's message names opens beside the thread, in the pane.
 *
 * What names a file: a link to a local path (`[the plan](docs/plan.md)`), a code span that is a path
 * (`packages/inbox/App.tsx:42`, `README.md`), and a bare path in the text (`docs/plan.md`, with a folder, so a word
 * like `Node.js` never is one). Lines ride along as the hover reads them (`:42`, `:12-20`, `#L12-L20`).
 *
 * A bare path is painted with the CSS Custom Highlight API (as skill references are, skillHighlight.ts), so the
 * Viewer's DOM is never changed; a click finds the range under the pointer.
 */
import { CODE_FILE_REGEX, stripLineRef } from '@plannotator/core/code-file';
import { projectFileOfLink } from './links';

export interface FileRef {
  path: string;
  line?: number;
  lineEnd?: number;
}

/** Names the pane can show, or offer, besides code: documents, pages, pictures, films and plain data. */
const OTHER_FILE = /\.(md|mdx|markdown|txt|log|csv|tsv|html?|png|jpe?g|gif|webp|avif|bmp|svg|mp4|m4v|mov|webm|pdf)$/i;

/** Whether words are one file's path (no spaces, no scheme, a file name with a kind the window knows). */
export function looksLikeFilePath(text: string, needsFolder = false): boolean {
  const words = text.trim();
  if (!words || /\s/.test(words) || /^[a-z][a-z0-9+.-]*:\/\//i.test(words) || words.startsWith('#') || words.startsWith('@')) return false;
  const bare = stripLineRef(words.replace(/#L\d+(?:-L?\d+)?$/, ''));
  if (needsFolder && !bare.includes('/')) return false;
  if (bare.endsWith('/') || /[()<>{}"'`,;|*?]/.test(bare)) return false;
  // A library's name, not a file: Node.js, Vue.js, Three.js.
  if (/^[A-Z][A-Za-z0-9]*\.js$/.test(bare)) return false;
  return CODE_FILE_REGEX.test(bare) || OTHER_FILE.test(bare);
}

/** The file words name, with its lines, or null. */
export function fileRefOf(text: string, needsFolder = false): FileRef | null {
  if (!looksLikeFilePath(text, needsFolder)) return null;
  return projectFileOfLink(text.trim());
}

/** A bare path in a line of text: a folder, a name with a kind, optional lines. */
const BARE_PATH = /(?:\.{0,2}\/|~\/)?(?:[\w@.\-[\]]+\/)+[\w.\-[\]]+\.[A-Za-z0-9]{1,10}(?::\d+(?:-\d+)?)?/g;

/** Text a bare path is never found in: links, code (code spans have their own), buttons and fields, a message's head. */
const SKIP = 'a, pre, code, button, textarea, input, [role="button"], [data-fold-head], [data-open-head], [data-sent-answers], script, style';

export interface BarePathRange {
  range: Range;
  ref: FileRef;
}

/** The bare paths under `root`. */
export function barePathRanges(root: Node): BarePathRange[] {
  const out: BarePathRange[] = [];
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    BARE_PATH.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BARE_PATH.exec(node.data))) {
      const before = match.index === 0 ? '' : node.data[match.index - 1]!;
      if (/\w/.test(before)) continue;
      // A sentence's full stop is not part of the name.
      const words = match[0].replace(/[.]+$/, '');
      const ref = fileRefOf(words, true);
      if (!ref) continue;
      const range = doc.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + words.length);
      out.push({ range, ref });
    }
  }
  return out;
}

interface HighlightApi {
  highlights: { set(name: string, value: unknown): void; delete(name: string): void };
  Highlight: new (...ranges: Range[]) => { priority: number };
}

/** The highlight's name (inbox.css `::highlight(ib-file-ref)`). */
export const FILE_REF_HIGHLIGHT = 'ib-file-ref';
/** Every painted message's ranges, so one highlight holds them all. */
const painted = new Map<string, BarePathRange[]>();

function repaint(): void {
  const api = globalThis as unknown as { CSS?: Partial<HighlightApi>; Highlight?: HighlightApi['Highlight'] };
  const registry = api.CSS?.highlights;
  const Highlight = api.Highlight;
  if (!registry || !Highlight) return;
  const ranges = [...painted.values()].flat().map((r) => r.range);
  if (ranges.length === 0) registry.delete(FILE_REF_HIGHLIGHT);
  else registry.set(FILE_REF_HIGHLIGHT, new Highlight(...ranges));
}

/** The bare path under a point, from the ranges `key` painted. */
function refAt(key: string, x: number, y: number): FileRef | null {
  const list = painted.get(key);
  if (!list?.length) return null;
  for (const { range, ref } of list) {
    for (const rect of range.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top - 1 && y <= rect.bottom + 1) return ref;
    }
  }
  return null;
}

/**
 * Paint a message's bare paths and make a click on one open it (`onOpen`). The pointer turns to a hand over one.
 * Returns the cleanup. Painted again when the body's words change.
 */
export function paintBarePaths(key: string, root: HTMLElement, onOpen: (ref: FileRef) => void): () => void {
  const paint = () => {
    painted.set(key, barePathRanges(root));
    repaint();
  };
  paint();
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => paint()) : null;
  observer?.observe(root, { childList: true, subtree: true, characterData: true });
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (window.getSelection()?.isCollapsed === false) return;
    const ref = refAt(key, event.clientX, event.clientY);
    if (!ref) return;
    event.preventDefault();
    event.stopPropagation();
    onOpen(ref);
  };
  const onMove = (event: MouseEvent) => {
    const over = !!refAt(key, event.clientX, event.clientY);
    if (over) root.setAttribute('data-file-ref-over', '');
    else root.removeAttribute('data-file-ref-over');
  };
  root.addEventListener('click', onClick);
  root.addEventListener('mousemove', onMove);
  return () => {
    observer?.disconnect();
    root.removeEventListener('click', onClick);
    root.removeEventListener('mousemove', onMove);
    root.removeAttribute('data-file-ref-over');
    painted.delete(key);
    repaint();
  };
}
