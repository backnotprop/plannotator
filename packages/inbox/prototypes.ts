import type { InboxAttachment, InboxLiveSiteRef } from '@plannotator/core/inbox-types';
import { attachmentForLink } from './links';

/** Its frame may never navigate the Inbox window (no `allow-top-navigation`). */
export const LIVE_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals';

export type PrototypePage =
  | { kind: 'app'; siteId: string; url: string }
  | { kind: 'file'; attachmentId: string; name: string };

export interface PrototypeQuestion {
  prompt: string;
  prototype?: { target: string; label?: string };
  choices: readonly { label: string; prototype?: { target: string; label?: string } }[];
}

export interface PrototypeMessage {
  live_sites?: readonly Pick<InboxLiveSiteRef, 'id' | 'url'>[];
  attachments?: readonly Pick<InboxAttachment, 'id' | 'path' | 'named_path' | 'name' | 'kind'>[];
  base_path?: string | null;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function prototypeSiteOf(target: string | undefined, sites: PrototypeMessage['live_sites']): { id: string; url: string } | null {
  if (!target || !sites || sites.length === 0) return null;
  try {
    const url = new URL(target.trim());
    url.hash = '';
    return sites.find((site) => site.url === url.href) ?? null;
  } catch {
    return null;
  }
}

export function prototypePageOf(target: string | undefined, message: PrototypeMessage, root: string): PrototypePage | null {
  if (!target) return null;
  if (SCHEME_RE.test(target.trim())) {
    const site = prototypeSiteOf(target, message.live_sites);
    return site ? { kind: 'app', siteId: site.id, url: site.url } : null;
  }
  const attachment = attachmentForLink(target, { attachments: message.attachments ?? [], root, base: message.base_path ?? null });
  return attachment && attachment.kind === 'html' ? { kind: 'file', attachmentId: attachment.id, name: attachment.name } : null;
}

export function questionPrototypePages(question: PrototypeQuestion, message: PrototypeMessage, root: string): { pages: (PrototypePage | null)[]; shared: boolean } {
  const shared = prototypePageOf(question.prototype?.target, message, root);
  const own = question.choices.map((choice) => prototypePageOf(choice.prototype?.target, message, root));
  if (own.some(Boolean)) return { pages: own.map((page) => page ?? shared), shared: false };
  return { pages: question.choices.map(() => shared), shared: shared !== null };
}

export function hasPrototype(question: PrototypeQuestion, message: PrototypeMessage, root: string): boolean {
  return prototypePageCount(question, message, root) > 0;
}

export function prototypePageCount(question: PrototypeQuestion, message: PrototypeMessage, root: string): number {
  const { pages, shared } = questionPrototypePages(question, message, root);
  if (!pages.some(Boolean)) return 0;
  return shared ? 1 : pages.filter(Boolean).length;
}

export interface PrototypeNames {
  sites: ReadonlyMap<string, string>;
  attachments: ReadonlyMap<string, string>;
}

export function prototypeNames(
  messages: readonly (PrototypeMessage & { questions?: readonly (PrototypeQuestion & { kind?: string })[] })[],
  root: string,
): PrototypeNames {
  const sites = new Map<string, string>();
  const attachments = new Map<string, string>();
  const name = (page: PrototypePage | null, words: string) => {
    if (!page) return;
    const map = page.kind === 'app' ? sites : attachments;
    const id = page.kind === 'app' ? page.siteId : page.attachmentId;
    if (!map.has(id)) map.set(id, words);
  };
  for (const message of messages) {
    for (const question of message.questions ?? []) {
      if (question.kind === 'action') continue;
      for (const choice of question.choices) name(prototypePageOf(choice.prototype?.target, message, root), `Prototype of "${choice.label}"`);
      name(prototypePageOf(question.prototype?.target, message, root), `Prototype for "${question.prompt}"`);
    }
  }
  return { sites, attachments };
}
