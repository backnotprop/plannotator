/**
 * A question's prototypes in the window (approval "inbox-question-tradeoffs"):
 * which page each option shows, and what names a prototype's comments in the
 * export. Pure: the card's "Try prototype" tab, the prototype window
 * (components/PrototypeWindow.tsx) and Send's feedback read the same answers.
 *
 * A page is one of two kinds:
 * - `file`: an HTML file the message attached (`Prototype: proto/a.html`),
 *   matched the way a link to an attachment is (links.ts), shown at the
 *   version that was sent;
 * - `app`: an app running on this computer (`Prototype: http://localhost:…`),
 *   one of the message's `live_sites` (checked and probed at send), shown
 *   through the Inbox's live proxy.
 * A question's own `Prototype:` line is one page every option shows.
 */
import type { InboxAttachment, InboxLiveSiteRef } from '@plannotator/core/inbox-types';
import { attachmentForLink } from './links';

/** Its frame may never navigate the Inbox window (no `allow-top-navigation`). */
export const LIVE_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals';

export type PrototypePage =
  | { kind: 'app'; siteId: string; url: string }
  | { kind: 'file'; attachmentId: string; name: string };

/** What a question's prototypes need from the question: as stored, or as the card parsed it. */
export interface PrototypeQuestion {
  prompt: string;
  prototype?: { target: string; label?: string };
  choices: readonly { label: string; prototype?: { target: string; label?: string } }[];
}

/** What they need from the message that asked it. */
export interface PrototypeMessage {
  live_sites?: readonly Pick<InboxLiveSiteRef, 'id' | 'url'>[];
  attachments?: readonly Pick<InboxAttachment, 'id' | 'path' | 'named_path' | 'name' | 'kind'>[];
  base_path?: string | null;
}

/** A target with a scheme names an app; anything else is a path. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** An app's address, matched to the message's checked sites (its fragment aside), or null. */
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

/** The page a `Prototype:` target names in this message, or null (not attached, not an HTML file, or not a checked app). */
export function prototypePageOf(target: string | undefined, message: PrototypeMessage, root: string): PrototypePage | null {
  if (!target) return null;
  if (SCHEME_RE.test(target.trim())) {
    const site = prototypeSiteOf(target, message.live_sites);
    return site ? { kind: 'app', siteId: site.id, url: site.url } : null;
  }
  const attachment = attachmentForLink(target, { attachments: message.attachments ?? [], root, base: message.base_path ?? null });
  return attachment && attachment.kind === 'html' ? { kind: 'file', attachmentId: attachment.id, name: attachment.name } : null;
}

/**
 * Each option's page, in choice order (null: the option has none), and
 * whether they are the question's one shared page. An option's own line wins
 * over the shared one.
 */
export function questionPrototypePages(question: PrototypeQuestion, message: PrototypeMessage, root: string): { pages: (PrototypePage | null)[]; shared: boolean } {
  const shared = prototypePageOf(question.prototype?.target, message, root);
  const own = question.choices.map((choice) => prototypePageOf(choice.prototype?.target, message, root));
  if (own.some(Boolean)) return { pages: own.map((page) => page ?? shared), shared: false };
  return { pages: question.choices.map(() => shared), shared: shared !== null };
}

/** Whether a question has a page to try (its "Try prototype" tab is drawn). */
export function hasPrototype(question: PrototypeQuestion, message: PrototypeMessage, root: string): boolean {
  return questionPrototypePages(question, message, root).pages.some(Boolean);
}

/** What names a prototype's comments in the export, by site id and by attachment id. */
export interface PrototypeNames {
  sites: ReadonlyMap<string, string>;
  attachments: ReadonlyMap<string, string>;
}

/**
 * The names of the thread's prototypes, for Send's feedback: `Prototype of
 * "B · Total first"` for an option's own page, `Prototype for "Which
 * checkout?"` for a question's shared one. The first question and option to
 * name a page names it.
 */
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
