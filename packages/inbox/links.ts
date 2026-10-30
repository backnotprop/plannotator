/**
 * Links in a message to the files it attached. A question can point at a
 * file the agent attached, `[the mock](mock.html)`; in the window that link
 * opens the attachment beside the thread, exactly as its tile does. The
 * match happens here, in the window, against the attachment records the
 * thread already carries (each file's realpath and, for a symlink, the path
 * the agent named): nothing is fetched to decide, and no route takes a path.
 *
 * A relative link starts where the message's images start (#1813): the
 * folder the agent sent from (`base_path`), else the project root. The
 * project root is tried too, since an agent may write a link from the root
 * while standing in a subfolder. `?query` and `#fragment` are ignored, and a
 * percent-encoded link (`my%20mock.html`) is decoded. A bare file name with
 * no folder (`mock.html`) also matches the one attachment of the message
 * with that name, when only one has it.
 *
 * A local link that names no attachment of the message is drawn as inert
 * text titled "Not attached": the window never asks the server for it.
 */
import { useMemo } from 'react';
import type { InboxAttachment, InboxProjectRepo } from '@plannotator/core/inbox-types';

export type LinkableAttachment = Pick<InboxAttachment, 'id' | 'path' | 'named_path' | 'name' | 'kind'>;

const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || WINDOWS_DRIVE.test(path);
}

/** `a/b/../c/./d` as `a/c/d`, with `\` read as `/` so Windows paths compare. */
export function normalizeLinkPath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  const drive = /^[a-z]:/i.test(slashed) ? slashed.slice(0, 2).toLowerCase() : '';
  const rest = drive ? slashed.slice(2) : slashed;
  const absolute = rest.startsWith('/');
  const out: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  return `${drive}${absolute ? '/' : ''}${out.join('/')}`;
}

/** The paths a link may mean: as written without `?`/`#`, and percent-decoded. */
function linkCandidates(href: string): string[] {
  const stripped = href.trim().replace(/[?#].*$/s, '');
  if (!stripped) return [];
  const out = [stripped];
  if (stripped.includes('%')) {
    try {
      const decoded = decodeURIComponent(stripped);
      if (decoded !== stripped) out.push(decoded);
    } catch {
      // Not percent-encoded after all.
    }
  }
  return out;
}

/**
 * The attachment of a message a link points to, or null. `root` is the
 * project's root and `base` the folder the agent sent from (the message's
 * `base_path`), both realpaths as the store keeps them.
 */
export function attachmentForLink<T extends LinkableAttachment>(
  href: string,
  options: { attachments: readonly T[]; root: string; base?: string | null },
): T | null {
  const { attachments } = options;
  if (attachments.length === 0) return null;
  const known = new Map<string, T>();
  for (const attachment of attachments) {
    known.set(normalizeLinkPath(attachment.path), attachment);
    if (attachment.named_path) known.set(normalizeLinkPath(attachment.named_path), attachment);
  }
  const dirs = [...new Set([options.base, options.root].filter((dir): dir is string => typeof dir === 'string' && dir !== ''))];
  const candidates = linkCandidates(href);
  for (const candidate of candidates) {
    const absolute = isAbsolutePath(candidate)
      ? [normalizeLinkPath(candidate)]
      : dirs.map((dir) => normalizeLinkPath(`${dir}/${candidate}`));
    for (const path of absolute) {
      const hit = known.get(path);
      if (hit) return hit;
    }
  }
  // A bare file name: the one attachment of the message with that name.
  for (const candidate of candidates) {
    if (/[\\/]/.test(candidate)) continue;
    const named = attachments.filter((attachment) => attachment.name === candidate);
    if (named.length === 1) return named[0]!;
  }
  return null;
}

/**
 * Where an attachment is, as the person knows it: the path the agent named
 * (else its realpath), relative to the project root when it lies inside it.
 */
export function attachmentDisplayPath(attachment: Pick<LinkableAttachment, 'path' | 'named_path'>, root: string): string {
  const path = normalizeLinkPath(attachment.named_path || attachment.path);
  const base = normalizeLinkPath(root);
  if (base && path.startsWith(`${base.replace(/\/$/, '')}/`)) return path.slice(base.replace(/\/$/, '').length + 1);
  return path;
}

/** The tooltip of a link that opens an attachment: its path in the project, so a match by bare name shows which file. */
export function openAttachmentTitle(displayPath: string): string {
  return `Open ${displayPath} beside the thread`;
}

/**
 * The window's own address of an attachment open beside its thread, the
 * route the window reads (`#thread=…&file=…`), so "Open in new tab", drag
 * and copy land on the file rather than on a path the Inbox does not serve.
 */
export function attachmentDeepLink(threadId: string, attachmentId: string, version: 'current' | 'sent' = 'current'): string {
  const params = new URLSearchParams();
  params.set('thread', threadId);
  params.set('file', attachmentId);
  // The route's own parameter for the version the agent sent (App.tsx routeOf / hashOf).
  if (version === 'sent') params.set('v', 'sent');
  return `#${params.toString()}`;
}

/** The tooltip of a local link that names no attachment of the message. */
export const NOT_ATTACHED_TITLE = 'Not attached to this message';

/**
 * Bare `#123` / `@user` refs (#1840): the project's `origin` as the Viewer's
 * `refRepo`, so a ref links to that repository's issue on its forge (and
 * opens in a new tab, as every external link does) instead of a styled span.
 * Kept stable while the repo is the same, so a re-read thread does not redraw
 * every message.
 */
export function useRefRepo(repo: InboxProjectRepo | null | undefined): { display: string; host?: string } | null {
  const display = repo?.display ?? null;
  const host = repo?.host ?? undefined;
  return useMemo(() => (display ? { display, ...(host ? { host } : {}) } : null), [display, host]);
}
