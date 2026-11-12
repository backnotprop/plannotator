/**
 * The preview of a sent `#Shape` (approval "board-hashtags", round 8): the
 * initiative's name, its cards, its other threads and "Open on Board". The
 * controller follows ui's RefHoverCard (the issue and PR hover
 * cards in the same body; that one is wired to forge links, so it cannot draw
 * this): it opens after a hover or keyboard focus rests REF_CARD_DELAY_MS on
 * the tag, stays while the pointer moves into it, and closes REF_CARD_CLOSE_MS
 * after it leaves, on Escape, a press outside or a scroll. One at a time. A
 * click on the tag still goes to the Board filtered to it (Thread's
 * `openHashtag`). On a touch screen the first tap opens the preview, a second
 * tap on the tag (or its "Open on Board") goes. No keyboard shortcut.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import { REF_CARD_CLOSE_MS, REF_CARD_DELAY_MS } from '@plannotator/ui/components/RefHoverCard';
import { AuthorMark } from '../icons';
import { cardAge } from '../board/model';
import { initiativePeekModel, type InitiativePeekModel, type PeekItem } from '../initiativePeek';
import { initiativeHref, useInitiativeTags } from '../hashtags';

const TAG = 'a[href^="#board&initiative="]';
/** RefHoverCard's width. */
const WIDTH = 400;
const EDGE = 12;
const GAP = 6;

let closeOther: (() => void) | null = null;

interface Open {
  anchor: HTMLAnchorElement;
  id: string;
  via: 'hover' | 'focus' | 'tap';
}

function initiativeOf(a: HTMLAnchorElement): string | null {
  return new URLSearchParams(a.getAttribute('href')!.slice(1)).get('initiative');
}

/** The previews for the tags inside `rootRef`, and the tag click's question: did a tap open it instead (then stop)? */
export function useInitiativePeek(rootRef: React.RefObject<HTMLElement | null>): { node: React.ReactNode; tapOpens: (a: Element) => boolean } {
  const [open, setOpen] = useState<Open | null>(null);
  const peekId = `ib-tagpeek-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  // The tag says whether its preview is open and which it is (the markdown renderer draws the link, so this is set here).
  useEffect(() => {
    if (!open) return;
    const anchor = open.anchor;
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', peekId);
    return () => {
      anchor.setAttribute('aria-expanded', 'false');
      anchor.removeAttribute('aria-controls');
    };
  }, [open, peekId]);
  const current = useRef<Open | null>(null);
  current.current = open;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const lastPointer = useRef('mouse');
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const clear = () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };
  const close = useCallback((restoreFocus = false) => {
    clear();
    const was = current.current;
    if (!was) return;
    const inside = !!cardRef.current?.contains(document.activeElement);
    setOpen(null);
    if (restoreFocus && inside) was.anchor.focus({ preventScroll: true });
  }, []);
  const closeSelf = useRef(() => close());
  closeSelf.current = () => close();
  const show = useCallback((anchor: HTMLAnchorElement, via: Open['via']) => {
    const id = initiativeOf(anchor);
    if (!id) return;
    clear();
    if (closeOther && closeOther !== closeSelf.current) closeOther();
    closeOther = closeSelf.current;
    setOpen({ anchor, id, via });
  }, []);
  const scheduleClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => close(), REF_CARD_CLOSE_MS);
  }, [close]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const tagOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLAnchorElement>(TAG) : null);
    const later = (fn: () => void) => {
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      openTimer.current = window.setTimeout(fn, REF_CARD_DELAY_MS);
    };
    const onDown = (e: PointerEvent) => {
      lastPointer.current = e.pointerType;
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const a = tagOf(e.target);
      if (!a) return;
      if (current.current?.anchor === a) {
        if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
        return;
      }
      later(() => show(a, 'hover'));
    };
    const onOut = (e: PointerEvent) => {
      const a = tagOf(e.target);
      if (!a || (e.relatedTarget instanceof Node && a.contains(e.relatedTarget))) return;
      if (openTimer.current !== null && current.current?.anchor !== a) {
        window.clearTimeout(openTimer.current);
        openTimer.current = null;
      }
      if (current.current?.anchor === a && !(e.relatedTarget instanceof Node && cardRef.current?.contains(e.relatedTarget))) scheduleClose();
    };
    const onFocusIn = (e: FocusEvent) => {
      const a = tagOf(e.target);
      if (!a || !a.matches(':focus-visible') || current.current?.anchor === a) return;
      later(() => show(a, 'focus'));
    };
    const onFocusOut = (e: FocusEvent) => {
      const a = tagOf(e.target);
      if (!a) return;
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      const next = e.relatedTarget;
      if (current.current?.anchor === a && current.current.via === 'focus' && !(next instanceof Node && cardRef.current?.contains(next))) close();
    };
    // Tab from the focused tag moves into the preview (its first link), as the PR cards do.
    const onKey = (e: KeyboardEvent) => {
      const c = current.current;
      if (!c || e.target !== c.anchor || e.key !== 'Tab' || e.shiftKey) return;
      const first = cardRef.current?.querySelector<HTMLElement>('a[href]');
      if (!first) return;
      e.preventDefault();
      first.focus();
    };
    root.addEventListener('pointerdown', onDown, true);
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('pointerdown', onDown, true);
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('keydown', onKey);
      clear();
    };
  }, [rootRef, show, close, scheduleClose]);

  const tapOpens = useCallback(
    (a: Element) => {
      const touch = lastPointer.current === 'touch' || !!window.matchMedia?.('(hover: none)').matches;
      if (!touch || !(a instanceof HTMLAnchorElement)) return false;
      if (current.current?.anchor === a) {
        close();
        return false;
      }
      show(a, 'tap');
      return true;
    },
    [show, close],
  );

  // While open: Escape, a press outside, a scroll (outside it), a resize.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (cardRef.current?.contains(t) || open.anchor.contains(t)) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (!cardRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', closeSelf.current);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', closeSelf.current);
    };
  }, [open, close]);

  useEffect(
    () => () => {
      if (closeOther === closeSelf.current) closeOther = null;
    },
    [],
  );

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!open || !card) return setPos(null);
    const r = open.anchor.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - EDGE * 2);
    const left = Math.min(Math.max(EDGE, r.left - 12), window.innerWidth - width - EDGE);
    const h = card.offsetHeight;
    const below = window.innerHeight - r.bottom - GAP - EDGE;
    const top = below >= h || below >= r.top ? r.bottom + GAP : r.top - GAP - h;
    setPos({ left, top: Math.max(EDGE, top) });
  }, [open]);

  const tags = useInitiativeTags();
  // An opened preview reads the cards again: a tag written meanwhile in a thread no card links moves no card,
  // so nothing else would bring its thread into the list.
  const refresh = useRef(tags.refresh);
  refresh.current = tags.refresh;
  const openId = open?.id ?? null;
  useEffect(() => {
    if (openId) refresh.current?.();
  }, [openId]);
  if (!open || typeof document === 'undefined') return { node: null, tapOpens };
  const initiative = tags.initiatives.find((i) => i.id === open.id);
  if (!initiative) return { node: null, tapOpens };
  // The thread the tag sits in is not listed under Threads: the person is already in it.
  const here = new URLSearchParams(window.location.hash.slice(1)).get('thread');
  const model = initiativePeekModel(initiative.id, tags.cards, tags.rows, tags.projects, tags.mentions.get(initiative.id), here);
  const container = open.anchor.closest<HTMLElement>('dialog[open], .pn-inbox') ?? document.body;
  const board = initiativeHref(initiative.id);
  const go = () => close();
  const node = createPortal(
    <div
      ref={cardRef}
      // RefHoverCard's own surface (packages/ui): one family with the issue and PR cards.
      className="ib-tagpeek fixed z-[120] flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
      id={peekId}
      role="dialog"
      aria-label={`Initiative ${initiative.name}`}
      data-tag-peek={initiative.id}
      style={{ width: Math.min(WIDTH, window.innerWidth - EDGE * 2), left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: 'min(560px, calc(100dvh - 24px))' }}
      onPointerEnter={() => {
        if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'touch' && open.via !== 'tap') scheduleClose();
      }}
      onKeyDown={(e) => {
        const first = cardRef.current?.querySelector<HTMLElement>('a[href]');
        if (e.key === 'Tab' && e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          open.anchor.focus();
        }
      }}
    >
      <PeekView name={initiative.name} board={board} model={model} onGo={go} />
    </div>,
    container,
  );
  return { node, tapOpens };
}

/**
 * Nothing leans on colour (the owner: "little labeled badges"). The header is
 * the name and the meta line; under it one small labelled badge per column
 * that has cards, in the Board's order ("In review 2", "In progress 2",
 * "Todo 1", "Done 1"), in the Inbox's own neutral badge (`.ib-badge.ib-b-mut`).
 * The cards: one plain list in the Board's order, each its title and its
 * column in the same badge; a row opens the card on the Board. "Threads": the
 * threads a message tags it in that no card of it links, the one the tag sits
 * in left out; each the agent's mark and the subject, quiet.
 */

/** The initiative's mark: a `#` at the PR card's state-icon size and stroke, in the text's own muted colour. */
/** The tag's `#` mark: the preview's, the sidebar's Tags heading and the Add tag item (approval "inbox-thread-tags": `#` once per set). */
export function TagIcon({ className = '', size }: { className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" className={`h-4 w-4 flex-none ${className}`} style={size ? { width: size, height: size } : undefined} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M6.3 2.5 5 13.5M11 2.5l-1.3 11M2.8 5.8h10.6M2.6 10.2h10.6" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 flex-none" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

const ROW = 'ib-tagpeek-row -mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 text-foreground no-underline hover:bg-muted focus-visible:bg-muted focus-visible:outline-none';
const GROUP = 'mb-1 text-[12px] font-medium leading-4';
/** The Inbox's neutral badge, a size down for the preview. */
const BADGE = 'ib-badge ib-b-mut ib-tagpeek-badge';

function PeekView({ name, board, model, onGo }: { name: string; board: string; model: InitiativePeekModel; onGo: () => void }) {
  const cardHref = (item: PeekItem) => `${board}&card=${encodeURIComponent(item.id)}`;
  const empty = model.cards === 0;
  const updated = model.updated ? cardAge(model.updated).short : null;
  const meta = ['Initiative', model.projects.length ? model.projects.join(', ') : null, empty ? 'no cards yet' : null, updated ? `updated ${updated}` : null].filter(Boolean);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-4 pb-4 pt-3.5" data-tag-peek-head="">
        <div className="flex items-center gap-1.5">
          <TagIcon className="text-muted-foreground" />
          <div className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-5 text-foreground" data-tag-peek-title="">
            {name}
          </div>
        </div>
        <div className="mt-0.5 truncate pl-[22px] text-[12px] leading-4 text-muted-foreground" data-tag-peek-meta="">
          {meta.join(' · ')}
        </div>
        {model.byColumn.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Cards by column" data-tag-peek-columns="">
            {model.byColumn.map((c) => (
              <li key={c.col} className={BADGE}>
                {c.column}
                {/* A no-break space, so the badge reads "In review 2" and not "In review2". */}
                <span className="ib-tagpeek-n">
                  {'\u00A0'}
                  {c.count}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {model.items.length === 0 && model.mentions.length === 0 ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3" data-tag-peek-body="">
          {model.items.length > 0 ? (
            <ul aria-label="Cards">
              {model.items.map((item) => (
                <li key={item.id}>
                  <a className={ROW} href={cardHref(item)} onClick={onGo}>
                    <span className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${item.col === 'done' ? 'text-muted-foreground' : ''}`}>{item.title}</span>
                    <span className={BADGE}>{item.column}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {model.moreItems > 0 ? <div className="pt-1 text-[12px] leading-4 text-muted-foreground">+{model.moreItems} more</div> : null}
          {model.mentions.length > 0 ? (
            <section aria-label="Threads" className={model.items.length > 0 ? 'mt-4' : undefined} data-tag-peek-threads="">
              <h3 className={`${GROUP} text-muted-foreground`}>Threads</h3>
              <ul>
                {model.mentions.map((thread) => (
                  <li key={thread.id}>
                    <a className={ROW} href={`#thread=${encodeURIComponent(thread.id)}`} onClick={onGo}>
                      <span className="ib-tagpeek-agent flex h-5 w-4 flex-none items-center justify-center">
                        <AuthorMark author={thread.agent} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-muted-foreground">{thread.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
              {model.moreMentions > 0 ? <div className="pl-[26px] pt-1 text-[12px] leading-4 text-muted-foreground">+{model.moreMentions} more</div> : null}
            </section>
          ) : null}
        </div>
      )}

      <div className="flex flex-none items-center gap-2 border-t border-border px-4 py-2" data-tag-peek-foot="">
        <span className="min-w-0 flex-1" />
        <a
          href={board}
          onClick={onGo}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary/10 px-2.5 text-[12px] font-medium text-primary no-underline hover:bg-primary/15"
          data-tag-peek-open=""
        >
          Open on Board
          <ArrowIcon />
        </a>
      </div>
    </div>
  );
}
