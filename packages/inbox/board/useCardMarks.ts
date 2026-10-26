import { useEffect, useRef, useState, type RefObject } from 'react';
import { inboxCardMarkRef, INBOX_CARD_MARKS_MAX, type InboxCardMark, type InboxCardWire } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';

/** A card's mark is asked again after this (the server's cache is as fresh). */
export const MARK_FRESH_MS = 5 * 60_000;
/** A failed ask is tried again after this. */
export const MARK_RETRY_MS = 60_000;
/** The window got its focus back: the cards on screen are asked again, at most this often. */
export const MARK_FOCUS_MS = 30_000;
/** Cards that come into view are asked for together, this long after the last one. */
const MARK_GATHER_MS = 200;

/**
 * The lane cards' marks (their one linked PR or issue's state), for the cards
 * on screen only, while the Board page is open (owner, 2026-10-26). A card is
 * asked for when it comes into view and has no mark younger than
 * `MARK_FRESH_MS` for its current link; the cards in view are asked again
 * when the window gets its focus back (at most every `MARK_FOCUS_MS`). One
 * request for every card in view; the server batches by repository. Off
 * (`enabled` false: a page opened over the tailnet), nothing is asked and
 * every mark stays the quiet neutral one.
 */
export function useCardMarks(cards: readonly InboxCardWire[], enabled: boolean, root: RefObject<HTMLElement | null>, layout: string): ReadonlyMap<string, InboxCardMark> {
  const [marks, setMarks] = useState<ReadonlyMap<string, InboxCardMark>>(() => new Map());
  const asked = useRef(new Map<string, { url: string; at: number }>());
  const visible = useRef(new Set<string>());
  const urls = useRef(new Map<string, string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFocus = useRef(0);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const ask = (refresh: boolean) => {
    if (!enabled) return;
    const now = Date.now();
    const ids: string[] = [];
    for (const id of visible.current) {
      const url = urls.current.get(id);
      if (!url) continue;
      const hit = asked.current.get(id);
      if (!refresh && hit && hit.url === url && now - hit.at < MARK_FRESH_MS) continue;
      ids.push(id);
      if (ids.length >= INBOX_CARD_MARKS_MAX) break;
    }
    if (ids.length === 0) return;
    for (const id of ids) asked.current.set(id, { url: urls.current.get(id)!, at: now });
    inboxApi
      .cardMarks(ids, refresh)
      .then(({ marks: answer }) => {
        if (!alive.current) return;
        setMarks((prev) => {
          const next = new Map(prev);
          for (const [id, mark] of Object.entries(answer)) next.set(id, mark);
          return next;
        });
      })
      .catch(() => {
        // Quietly neutral; asked again a minute later.
        for (const id of ids) asked.current.set(id, { url: urls.current.get(id) ?? '', at: Date.now() - MARK_FRESH_MS + MARK_RETRY_MS });
      });
  };
  const askSoon = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      ask(false);
    }, MARK_GATHER_MS);
  };
  const askRef = useRef({ askSoon, ask });
  askRef.current = { askSoon, ask };

  // Which cards link something, and to what (a new link on a card asks again); where each is drawn
  // (a card that moves lane, or another view, is a new element to watch).
  const linkKey = `${layout}#` + cards.map((card) => `${card.id}=${card.column}=${inboxCardMarkRef(card)?.url ?? ''}`).join('|');
  useEffect(() => {
    urls.current = new Map(
      cards.flatMap((card) => {
        const ref = inboxCardMarkRef(card);
        return ref ? [[card.id, ref.url] as const] : [];
      }),
    );
    if (!enabled) return;
    const host = root.current;
    if (!host) return;
    const elements = [...host.querySelectorAll<HTMLElement>('[data-card-id]')].filter((el) => urls.current.has(el.dataset.cardId ?? ''));
    if (typeof IntersectionObserver === 'undefined') {
      visible.current = new Set(elements.map((el) => el.dataset.cardId!));
      askRef.current.askSoon();
      return;
    }
    visible.current = new Set();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.cardId;
        if (!id) continue;
        if (entry.isIntersecting) visible.current.add(id);
        else visible.current.delete(id);
      }
      askRef.current.askSoon();
    });
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      if (Date.now() - lastFocus.current < MARK_FOCUS_MS) return;
      lastFocus.current = Date.now();
      askRef.current.ask(true);
    };
    lastFocus.current = Date.now();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled]);

  return marks;
}
