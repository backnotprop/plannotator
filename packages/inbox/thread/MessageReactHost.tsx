/**
 * Reactions on every agent message (approval "inbox-reactions-every-message", 2026-11-24), the thread pane's one
 * shared host. Each agent message draws only its face (ReactStrip.tsx, shown by CSS); everything else is one instance
 * for the whole pane, never one per message:
 * - the face opened into the person's emoji (a portal into the face's own slot: placed by CSS, nothing measured);
 * - the full tray (ReactionTray with the face as its anchor);
 * - the message menu a right-click anywhere on a message opens (and a hold on a phone): the same items as its ⋯, the
 *   emoji first. A right-click on selected text, a link, a picture or a field keeps the browser's own menu;
 * - the skill emoji's card.
 * Its listeners are on the thread's body (right-click, and a phone's hold when `PHONE_HOLD.opensSheet`), not one per
 * message, and, only while the face is open, the presses, scrolls and Escape that close it.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Menu } from '@base-ui/react/menu';
import type { InboxMessageWire, InboxReaction, InboxThread } from '@plannotator/core/inbox-types';
import { MessageMenuItems, type CopyMenuHost } from '../components/CopyMenus';
import { copyAuthor } from '../copyMarkdown';
import { whenTime } from '../format';
import { flyReaction, ReactionTray, reactedNow, sameReaction } from '../components/ReactionTray';
import { faceHover, faceStrip, hasSkill, useFaceStrip, type MessageReactApi } from './messageReact';
import { FaceStrip } from './ReactStrip';
import { questionWaits } from './footAck';
import { followTextPresses } from './facePress';
import { SkillPreviewCard } from './SkillPreviewCard';
import { sendSkillReaction, type SkillReactionHost } from './skillReaction';

type OnAck = (messageId: string, on: boolean, agent: string, reaction?: InboxReaction | null, was?: InboxReaction | null) => void;

/** What the pane gives the host; read through a ref, so the api's identity never changes. */
export interface MessageReactSource extends SkillReactionHost {
  thread: InboxThread;
  onAck?: OnAck;
  agentOf: (message: InboxMessageWire) => string;
  /** Reply's own rule (not a message from before an archive). */
  liveOf: (message: InboxMessageWire) => boolean;
  reply: (message: InboxMessageWire) => void;
}

/** The pane's MessageReactApi (stable), and a request to open the shared tray on a message. */
export function useMessageReactApi(source: MessageReactSource): MessageReactApi & { trayAsk: { current: (message: InboxMessageWire) => void } } {
  const newest = useRef(source);
  newest.current = source;
  return useMemo(() => {
    const trayAsk = { current: (_message: InboxMessageWire) => {} };
    return {
      trayAsk,
      offered: (m) => {
        const s = newest.current;
        return !!s.onAck && m.author.kind === 'agent' && s.thread.resolved_at === null && s.liveOf(m) && m.ack?.settled_seq == null;
      },
      plain: () => !questionWaits(newest.current.thread.messages),
      agentOf: (m) => newest.current.agentOf(m),
      live: (m) => newest.current.liveOf(m),
      ack: (m, on, reaction, was) => newest.current.onAck?.(m.id, on, newest.current.agentOf(m), reaction, was),
      reply: (m) => newest.current.reply(m),
      openTray: (m) => trayAsk.current(m),
      react: (m, reaction, from) => {
        const s = newest.current;
        const agent = s.agentOf(m);
        if (hasSkill(reaction)) {
          void sendSkillReaction(m, reaction, agent, s, s.thread);
          return;
        }
        const current = m.ack?.reaction ?? null;
        // A plain emoji while a question waits is never offered (the store refuses it too); taking one back still is.
        if (questionWaits(s.thread.messages) && !(m.ack && sameReaction(current, reaction))) return;
        // A second press of the emoji it already has takes it back, as the tray's does.
        if (m.ack && sameReaction(current, reaction)) {
          s.onAck?.(m.id, false, agent, current);
          return;
        }
        reactedNow(m.id);
        flyReaction(from, reaction?.emoji ?? '👍', m.id);
        s.onAck?.(m.id, true, agent, reaction, m.ack ? current : undefined);
      },
    } satisfies MessageReactApi & { trayAsk: typeof trayAsk };
  }, []);
}

/**
 * A phone's hold on a message. Two behaviours, one switch, the owner to pick:
 * - true: a still hold of `HOLD_MS` opens the message's sheet (and keeps the browser from selecting text then);
 * - false: the hold is left to the browser (long-press selects text, partial copy works) and the sheet is the ⋯'s.
 * False for now: it takes nothing away that people have today. (An object so a test can try both, then restore.)
 */
export const PHONE_HOLD = { opensSheet: false };
const HOLD_MS = 450;
const NOT_OURS = 'a[href], input, textarea, select, [contenteditable="true"], img, video, button, [role="button"], [role="menuitem"], .ib-pm, [data-reaction-tray], .ib-rstrip';

/** The open message whose body or head `target` is in, or null. */
function messageAt(target: EventTarget | null): HTMLElement | null {
  const el = target instanceof Element ? target : null;
  const article = el?.closest<HTMLElement>('[data-message-article]') ?? null;
  return article && article.querySelector('[data-message-more]') ? article : null;
}

export function MessageReactHost({ body, api, copy, phone, takeBackOf }: { body: RefObject<HTMLElement | null>; api: ReturnType<typeof useMessageReactApi>; copy: { readonly current: CopyMenuHost }; phone: boolean; takeBackOf: (message: InboxMessageWire) => (() => void) | null }) {
  const thread = copy.current.thread;
  const strip = useFaceStrip();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; sheet: boolean } | null>(null);
  const [tray, setTray] = useState<{ id: string; n: number } | null>(null);
  const trayAnchor = useRef<HTMLElement | null>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const heldAt = useRef(0);
  const find = (id: string | undefined) => (id ? (copy.current.thread.messages.find((m) => m.id === id) ?? null) : null);
  api.trayAsk.current = (message) => {
    faceHover.close();
    // A phone draws no face: the tray opens at the message's ⋯ (its sheet's "All reactions"), over its head line.
    const id = CSS.escape(message.id);
    trayAnchor.current = body.current?.querySelector<HTMLElement>(`[data-react-face-slot="${id}"]`) ?? (phone ? body.current?.querySelector<HTMLElement>(`[data-message-more="${id}"]`) : null) ?? null;
    if (trayAnchor.current) setTray((t) => ({ id: message.id, n: (t?.n ?? 0) + 1 }));
  };

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    setPortal(el.closest<HTMLElement>('.pn-inbox'));
    const holdOpensSheet = PHONE_HOLD.opensSheet;
    const open = (article: HTMLElement, x: number, y: number, sheet: boolean) => {
      const id = article.getAttribute('data-message-article') ?? '';
      faceHover.close();
      setMenu({ id, x, y, sheet });
    };
    const onContextMenu = (e: MouseEvent) => {
      if (phone) {
        // The platform's own long-press menu, right after our hold opened the sheet, is not a second menu.
        if (holdOpensSheet && Date.now() - heldAt.current < 900) e.preventDefault();
        return;
      }
      const article = messageAt(e.target);
      const target = e.target as Element;
      if (!article || target.closest(NOT_OURS.replace(', button, [role="button"]', ''))) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim() !== '' && article.contains(selection.anchorNode)) return;
      e.preventDefault();
      open(article, e.clientX, e.clientY, false);
    };
    el.addEventListener('contextmenu', onContextMenu);
    // A drag selects the words past the faces, as with none there (thread/facePress.ts). A phone draws no face.
    const unfollow = phone ? () => {} : followTextPresses(el);
    if (!phone || !holdOpensSheet) {
      return () => {
        unfollow();
        el.removeEventListener('contextmenu', onContextMenu);
      };
    }
    // A phone, `PHONE_HOLD.opensSheet`: a still hold on a message opens its sheet (Reply's hold time); a finger that
    // moves is a scroll.
    let hold: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
    const stop = () => {
      if (hold) clearTimeout(hold.timer);
      hold = null;
    };
    const onDown = (e: PointerEvent) => {
      stop();
      const article = messageAt(e.target);
      if (e.pointerType === 'mouse' || !article || (e.target as Element).closest(NOT_OURS)) return;
      hold = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          hold = null;
          heldAt.current = Date.now();
          navigator.vibrate?.(8);
          window.getSelection()?.removeAllRanges();
          open(article, 0, 0, true);
        }, HOLD_MS),
      };
    };
    const onMove = (e: PointerEvent) => hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10 && stop();
    const swallow = (e: Event) => {
      if (Date.now() - heldAt.current > 700) return;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    el.addEventListener('click', swallow, true);
    el.addEventListener('selectstart', swallow);
    return () => {
      stop();
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', stop);
      el.removeEventListener('pointercancel', stop);
      el.removeEventListener('click', swallow, true);
      el.removeEventListener('selectstart', swallow);
    };
  }, [body, phone]);

  // The opened face closes on a press outside it, a scroll, or Escape (and when the pointer is on neither the face nor
  // it: `faceHover`). Listening only while it is open.
  const stripOpen = !!strip;
  useEffect(() => {
    if (!stripOpen) return;
    const outside = (e: Event) => {
      const slot = faceStrip.get()?.slot;
      if (!slot || !(e.target instanceof Node) || !slot.contains(e.target)) faceHover.close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      faceHover.close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', outside, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', outside, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [stripOpen]);
  useEffect(() => () => faceHover.close(), []);

  // A new thread closes whatever was open for the last one.
  useEffect(() => {
    faceHover.close();
    setMenu(null);
    setTray(null);
  }, [thread.thread_id]);

  // While its menu is open, the message's ⋯ shows as open (as its own menu shows it).
  const menuMessage = find(menu?.id);
  const more = menu ? (body.current?.querySelector<HTMLElement>(`[data-message-more="${CSS.escape(menu.id)}"]`) ?? null) : null;
  const lastMore = useRef<HTMLElement | null>(null);
  if (more) lastMore.current = more;
  useEffect(() => {
    if (!more) return;
    more.setAttribute('data-open', '');
    return () => more.removeAttribute('data-open');
  }, [more]);
  const point = useMemo(() => (menu ? { getBoundingClientRect: () => DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }) } : null), [menu]);

  const stripMessage = strip && strip.slot.isConnected ? find(strip.messageId) : null;
  const trayMessage = find(tray?.id);
  const named = menuMessage ? `${copyAuthor(menuMessage)}, ${whenTime(menuMessage.created_at)}` : '';
  return (
    <>
      {stripMessage && api.offered(stripMessage) && createPortal(<FaceStrip message={stripMessage} api={api} />, strip!.slot)}
      {trayMessage && api.offered(trayMessage) && api.plain() && (
        <ReactionTray
          key={trayMessage.id}
          messageId={trayMessage.id}
          agent={api.agentOf(trayMessage)}
          on={!!trayMessage.ack}
          current={trayMessage.ack?.reaction ?? null}
          phone={phone}
          anchor={trayAnchor}
          openRequest={tray!.n}
          onAck={(on, reaction, was) => api.ack(trayMessage, on, reaction, was)}
          onSkill={(reaction, from) => api.react(trayMessage, reaction, from)}
        />
      )}
      <Menu.Root open={!!menuMessage} onOpenChange={(next) => !next && setMenu(null)} modal={false}>
        <Menu.Portal container={portal ?? undefined}>
          {menu?.sheet && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" anchor={point} side="bottom" align="start" data-phone={menu?.sheet ? '' : undefined}>
            <Menu.Popup className="ib-pm" aria-label={`Message from ${named}`} data-message-menu={menu?.id} data-context="" finalFocus={() => lastMore.current ?? false}>
              {menuMessage && <MessageMenuItems message={menuMessage} newest={copy} takeBack={takeBackOf(menuMessage)} live={api.live(menuMessage)} phone={menu!.sheet} />}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <SkillPreviewCard container={portal} />
    </>
  );
}
