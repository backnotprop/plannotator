import { isDotenvFileName } from '@plannotator/core/annotatable';
import { resolveHtmlLinkIntent } from '@plannotator/ui/utils/htmlLinkNavigation';
import { normalizeLinkPath, type LinkableAttachment } from './links';

export type InboxHtmlLink =
  | { kind: 'attachment'; id: string; name: string; hash: string }
  | { kind: 'page'; path: string; relative: string; name: string; hash: string }
  | { kind: 'image'; url: string; name: string }
  | { kind: 'external'; url: string }
  | { kind: 'refused'; name: string; note: string }
  | { kind: 'ignored' };

export interface InboxHtmlLinkContext {
  folder: string;
  baseDir: string;
  attachments: readonly LinkableAttachment[];
  assetRoute: string | null;
  serverOrigin: string;
  markdown?: boolean;
}

const trimSlash = (path: string) => path.replace(/\/+$/, '');

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

function inside(path: string, folder: string): string | null {
  const dir = trimSlash(normalizeLinkPath(folder));
  const target = normalizeLinkPath(path);
  return target.startsWith(`${dir}/`) ? target.slice(dir.length + 1) : null;
}

function hiddenPath(relative: string): boolean {
  return relative.split('/').some((segment) => segment.startsWith('.') || isDotenvFileName(segment));
}

const baseName = (path: string) => normalizeLinkPath(path).split('/').pop() || path;

export function resolveInboxHtmlLink(href: string, context: InboxHtmlLinkContext): InboxHtmlLink {
  const folder = trimSlash(normalizeLinkPath(context.folder));
  const intent = resolveHtmlLinkIntent(href, {
    baseDir: context.baseDir,
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
  if (context.markdown) {
    return { kind: 'refused', name, note: `${name} is not attached to this thread. Only Markdown files in this file's folder open from a link.` };
  }
  if (intent.kind === 'unsupported' && intent.reason === 'no-asset-root') {
    return { kind: 'refused', name, note: `${name} is not attached, and this page's images are not available here.` };
  }
  return { kind: 'refused', name, note: `${name} is not attached to this thread. Only HTML pages and images in this page's folder open from a link.` };
}
