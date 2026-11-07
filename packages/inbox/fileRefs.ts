/**
 * Every file an agent's message names opens beside the thread, in the pane (approval "inbox-file-refs-open-viewer").
 *
 * What names a file: a link to a local path (`[the plan](docs/plan.md)`), a code span that is a path
 * (`packages/inbox/App.tsx:42`, `README.md`, `/tmp/run/out.log`, `~/notes/todo.md`), and a bare path in the text
 * (`docs/plan.md`, `/tmp/shot.png`, with a folder, so a word like `Node.js` never is one). Lines ride along as the
 * hover reads them (`:42`, `:12-20`, `#L12-L20`).
 *
 * A bare path is drawn by ui's InlineMarkdown through its opt-in `BarePathContext` (`findBarePaths` finds them), so it
 * is a real control: focusable, opened with Enter, read by a screen reader.
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

/**
 * A bare path in a run of words: from the root, the home folder or a folder (`/tmp/a.log`, `~/n/a.md`, `./a/b.ts`,
 * `docs/plan.md`), a name with a kind, optional lines. The first folder never starts with `[` (where a link starts);
 * a later one may (`app/[id]/page.tsx`).
 */
const BARE_PATH = /(?:~\/|\.{0,2}\/)?[\w@.\-][\w@.\-[\]]*\/(?:[\w@.\-[\]]+\/)*[\w.\-[\]]+\.[A-Za-z0-9]{1,10}(?::\d+(?:-\d+)?)?/g;

/** Each bare path in `text` that names a file (`fileRefOf` with a folder), as its start and end. */
/** A first segment that is a web host (`example.com/…`, `docs.github.com/…`). */
const WEB_HOST = /^(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|edu|gov|so|sh|me|xyz|info)\//i;

export function findBarePaths(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  BARE_PATH.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_PATH.exec(text))) {
    const before = match.index === 0 ? '' : text[match.index - 1]!;
    if (/[\w/~[]/.test(before)) continue;
    // A sentence's full stop is not part of the name.
    const words = match[0].replace(/[.]+$/, '');
    // Another repository's issue or PR (`vercel/next.js#123`, `owner/repo@sha`): a reference, never a file here.
    if (/^[#@][0-9a-f]/i.test(text.slice(match.index + words.length))) continue;
    // A web address written without its scheme (`example.com/docs/page.html`).
    if (WEB_HOST.test(words)) continue;
    if (!fileRefOf(words, true)) continue;
    out.push({ start: match.index, end: match.index + words.length });
  }
  return out;
}
