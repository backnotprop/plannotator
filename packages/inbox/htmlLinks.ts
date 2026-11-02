/**
 * What a link inside an attached HTML page means in the Inbox.
 *
 * The page is drawn in Plannotator's sandboxed HtmlViewer, whose bridge never
 * lets the frame navigate: on a plain click it hands the RAW href to the
 * window, in Annotate and Interact alike (⌘-click, Ctrl-click off macOS, pins
 * the link for a comment while armed; one rule on every HTML surface). The href is read
 * with annotate's own rules (`resolveHtmlLinkIntent`: relative to the page's
 * folder, the query dropped, the fragment kept), then mapped onto what the
 * Inbox has:
 *
 * - a file attached to the thread (by realpath or the path the agent named):
 *   it opens in the pane, as its tile does;
 * - another `.html`/`.htm` page in the attached page's folder that is not
 *   attached: shown read-only in the same pane (`/linked-page`);
 * - a local image in that folder that is not attached: the lightbox, read
 *   through the attached page's own asset route;
 * - another site: a new tab;
 * - anything else (another kind of file, outside the folder, a hidden file,
 *   another scheme): a note saying why. Never silent.
 *
 * Pure: no DOM, no fetch. The caller passes the folders, the attachments and
 * the asset route, so every branch is unit-testable.
 */
import { isDotenvFileName } from '@plannotator/core/annotatable';
import { resolveHtmlLinkIntent } from '@plannotator/ui/utils/htmlLinkNavigation';
import { normalizeLinkPath, type LinkableAttachment } from './links';

export type InboxHtmlLink =
  /** An attachment of the thread: open it in the pane. `hash` is the fragment, without `#`. */
  | { kind: 'attachment'; id: string; name: string; hash: string }
  /** A page in the attached page's folder that is not attached: `relative` is its path in that folder. */
  | { kind: 'page'; path: string; relative: string; name: string; hash: string }
  /** A local image in the attached page's folder, not attached: `url` is the asset route. */
  | { kind: 'image'; url: string; name: string }
  /** Another site: a new tab. */
  | { kind: 'external'; url: string }
  /** Nothing opens; `note` says why, in one sentence. */
  | { kind: 'refused'; name: string; note: string }
  /** Nothing to do (an in-page fragment, which the page scrolls itself). */
  | { kind: 'ignored' };

export interface InboxHtmlLinkContext {
  /** The attached page's folder (the folder of its realpath): links never leave it. */
  folder: string;
  /** The folder of the page the link is in: the attached page's, or a linked page's. */
  baseDir: string;
  /** Every file of the thread the pane can open. */
  attachments: readonly LinkableAttachment[];
  /** The attached page's asset route (`/api/html-assets/<token>/`, rooted at `folder`), or null. */
  assetRoute: string | null;
  /** The window's own origin. */
  serverOrigin: string;
  /** Markdown attachments follow sibling Markdown documents, not executable HTML. */
  markdown?: boolean;
}

const trimSlash = (path: string) => path.replace(/\/+$/, '');

/** The folder of a path, with `/` separators. */
export function folderOf(path: string): string {
  const slashed = normalizeLinkPath(path);
  const at = slashed.lastIndexOf('/');
  return at <= 0 ? '/' : slashed.slice(0, at);
}

function attachmentAt<T extends LinkableAttachment>(path: string, attachments: readonly T[]): T | null {
  const target = normalizeLinkPath(path);
  for (const attachment of attachments) {
    if (normalizeLinkPath(attachment.path) === target) return attachment;
    if (attachment.named_path && normalizeLinkPath(attachment.named_path) === target) return attachment;
  }
  return null;
}

/** `path` relative to `folder`, or null when it is not inside it. */
function inside(path: string, folder: string): string | null {
  const dir = trimSlash(normalizeLinkPath(folder));
  const target = normalizeLinkPath(path);
  return target.startsWith(`${dir}/`) ? target.slice(dir.length + 1) : null;
}

/** A segment the asset route never serves: hidden (`.git`, `.env`) or a dotenv name. */
function hiddenPath(relative: string): boolean {
  return relative.split('/').some((segment) => segment.startsWith('.') || isDotenvFileName(segment));
}

const baseName = (path: string) => normalizeLinkPath(path).split('/').pop() || path;

export function resolveInboxHtmlLink(href: string, context: InboxHtmlLinkContext): InboxHtmlLink {
  const folder = trimSlash(normalizeLinkPath(context.folder));
  const intent = resolveHtmlLinkIntent(href, {
    baseDir: context.baseDir,
    // A root-relative link (`/x.html`) means the site this page belongs to: its folder.
    rootDir: folder,
    // An opaque origin (`null`: a sandboxed or test document) still needs a base to parse an absolute URL against.
    serverOrigin: /^https?:\/\//i.test(context.serverOrigin) ? context.serverOrigin : 'http://inbox.invalid',
    assetRoot: context.assetRoute ? { dir: folder, url: context.assetRoute } : null,
  });
  switch (intent.kind) {
    case 'external':
      return { kind: 'external', url: intent.url };
    case 'ignored':
      if (intent.reason === 'fragment') return { kind: 'ignored' };
      if (intent.reason === 'scheme') {
        const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase() ?? 'this';
        return { kind: 'refused', name: href.trim().slice(0, 80), note: `The Inbox does not follow ${scheme}: links.` };
      }
      return { kind: 'refused', name: href.trim().slice(0, 80), note: 'This link could not be read.' };
    default:
      break;
  }
  const path = intent.path;
  const name = baseName(path);
  // An attachment of the thread opens as itself, whatever kind it is.
  const attached = attachmentAt(path, context.attachments);
  if (attached) return { kind: 'attachment', id: attached.id, name: attached.name, hash: intent.kind === 'document' ? intent.hash : '' };
  const relative = inside(path, folder);
  if (relative === null) {
    return { kind: 'refused', name, note: `${name} is outside this page's folder and is not attached, so it does not open here.` };
  }
  if (hiddenPath(relative)) {
    return { kind: 'refused', name, note: `${name} is a hidden file or in a hidden folder, so it does not open here.` };
  }
  if (intent.kind === 'image') return { kind: 'image', url: intent.url, name };
  if (intent.kind === 'document' && (context.markdown ? /\.mdx?$/i : /\.html?$/i).test(path)) {
    return { kind: 'page', path, relative, name, hash: intent.hash };
  }
  // A Markdown file has no asset route: only other Markdown files in its folder open from a link.
  if (context.markdown) {
    return { kind: 'refused', name, note: `${name} is not attached to this thread. Only Markdown files in this file's folder open from a link.` };
  }
  if (intent.kind === 'unsupported' && intent.reason === 'no-asset-root') {
    return { kind: 'refused', name, note: `${name} is not attached, and this page's images are not available here.` };
  }
  return { kind: 'refused', name, note: `${name} is not attached to this thread. Only HTML pages and images in this page's folder open from a link.` };
}
