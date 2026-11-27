/**
 * The Search tip (the owner, 2026-11-26: "a little helpful popover tip … for when users use search the next time within
 * the search box"): a one-time card at the palette's search box that says words in quotes are an exact phrase. The
 * Launch tip's sibling (compose/launchTip.ts): the same card (`.ib-tour-coach.ib-ctip`), the same words' shape, the same
 * "seen once" kept by the Inbox (packages/shared/inbox/search-tip.ts, settings `reveal.search_tip`, the claim
 * `POST /api/inbox/reveal` `id: "search_tip"`). The rules the window keeps:
 *
 *  - The next open of the palette once the Inbox has it for this page, `delayMs` after the box opens (its entrance
 *    settled). Never in the tour, on the first-run screen or while another one-time dialog or tip is claimed or up
 *    (App's `revealBlocked`, `lineBusy`), and never within the gap of one shown on this load
 *    (`oneTimeDialogShownThisLoad`). A quote typed before it shows keeps it away for that open.
 *  - It shows in the same render the claim is sent; a refused claim (another window showed it, or a dialog's gap) takes
 *    it away at once. Once shown, the other one-time things hold back for the gap (`noteOneTimeDialogShown`).
 *  - Where: beside the palette, level with the box and pointing at it, when the window has room for the card and its
 *    gaps (the Launch tip's rule); else (a narrow window, a phone) under the box, in the palette's flow, so it covers
 *    neither the box nor a result.
 *  - It leaves on Got it, Escape (the first Escape closes only the tip; the next is the palette's), a quote mark typed
 *    in the box, or the palette closing. No timer. A palette closed before it showed leaves it for the next open.
 *  - Focus never moves to it: typing goes on in the box. While it is up the box is described by its line.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxSearchQuoted } from '@plannotator/core/inbox-search';
import type { SettingsModel } from '../api';
import { claimRevealOnce, noteOneTimeDialogShown, oneTimeDialogShownThisLoad } from '../reveal';

export const SEARCH_TIP_WORDS = {
  eyebrow: 'New',
  title: 'Search for an exact phrase',
  line: 'Put words in "quotes" to find them side by side, in that order.',
  ok: 'Got it',
} as const;

/** What a screen reader hears once, through the palette's polite region. */
export const SEARCH_TIP_SAID = `${SEARCH_TIP_WORDS.eyebrow}: ${SEARCH_TIP_WORDS.title}. ${SEARCH_TIP_WORDS.line}`;

/** The card's timings, ms. A test shrinks them (and puts them back). */
export const SEARCH_TIP_TIMES = {
  /** After the palette opens: its 150 ms entrance has settled. */
  delayMs: 300,
  /** The way out (a 120 ms fade), then it is gone from the DOM. */
  leaveMs: 130,
};

/** The card's width (inbox.css `.ib-ctip`), its gap from the palette and from the window's edge. */
export const SEARCH_TIP_WIDTH = 284;
const BESIDE_GAP = 16;
const EDGE = 12;
/** The arrow's centre, from the card's top, where it stands level with the box's centre. */
const ARROW_Y = 26;

/** The Inbox has the tip for this page: an Inbox that reports it due. */
export function searchTipDue(settings: Pick<SettingsModel, 'reveal'> | null | undefined): boolean {
  return !!settings && settings.reveal?.search_tip === true;
}

/** `right`: beside the palette, its top from the palette's top. `below`: in the palette's flow, under the box. */
export type SearchTipPlace = { side: 'right'; top: number; left: number } | { side: 'below' };

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

/** Beside the palette when the window has the card's width and its gaps at its right; else under the box. */
export function searchTipPlace(input: { phone: boolean; viewportWidth: number; dialog: Box; row: Box }): SearchTipPlace {
  const { phone, viewportWidth, dialog, row } = input;
  if (!phone && viewportWidth - dialog.right >= SEARCH_TIP_WIDTH + BESIDE_GAP + EDGE) {
    return { side: 'right', left: dialog.width + BESIDE_GAP, top: Math.round(row.top - dialog.top + row.height / 2 - ARROW_Y) };
  }
  return { side: 'below' };
}

/** This page spends one claim at most (the palette stays mounted, but a remount must not ask again). */
let spentThisLoad = false;
const pageKey = `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
/** A test starts each case as a fresh load. */
export function resetSearchTipForTests(): void {
  spentThisLoad = false;
}

export type SearchTipStage = 'none' | 'wait' | 'shown' | 'leaving' | 'done';

/**
 * The tip's stages for one palette. `offered`: the Inbox has it for this page and nothing holds it back (App).
 * `say`: the palette's polite region. Returns the stage and `close` (Got it, Escape).
 */
export function useSearchTip(input: { open: boolean; offered: boolean; q: string; say: (words: string) => void }) {
  const { open, offered, q } = input;
  const [stage, setStage] = useState<SearchTipStage>('none');
  const say = useRef(input.say);
  say.current = input.say;
  const qRef = useRef(q);
  qRef.current = q;
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // An open with the tip offered and unspent waits for the entrance, then shows and claims in the same render.
  useEffect(() => {
    if (!open) {
      // The palette closed: a shown tip is done; one still waiting stays for the next open.
      setStage((was) => (was === 'none' || was === 'wait' ? 'none' : 'done'));
      return;
    }
    if (!offered || spentThisLoad) return;
    setStage('wait');
    let live = true;
    const timer = setTimeout(() => {
      if (!live || spentThisLoad || oneTimeDialogShownThisLoad() || inboxSearchQuoted(qRef.current)) {
        setStage('none');
        return;
      }
      spentThisLoad = true;
      noteOneTimeDialogShown();
      setStage('shown');
      void claimRevealOnce('search_tip', pageKey)
        .then((answer) => {
          if (!answer.show) setStage((was) => (was === 'shown' ? 'done' : was));
          else say.current(SEARCH_TIP_SAID);
        })
        .catch(() => setStage((was) => (was === 'shown' ? 'done' : was)));
    }, SEARCH_TIP_TIMES.delayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, offered]);

  const stageRef = useRef(stage);
  stageRef.current = stage;
  const close = useCallback(() => {
    if (stageRef.current !== 'shown') return;
    stageRef.current = 'leaving';
    setStage('leaving');
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setStage((now) => (now === 'leaving' ? 'done' : now)), SEARCH_TIP_TIMES.leaveMs);
  }, []);

  // A quote mark typed: the person is doing what it says.
  useEffect(() => {
    if (stage === 'shown' && inboxSearchQuoted(q)) close();
  }, [q, stage, close]);

  useEffect(() => () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  }, []);

  return { stage, close };
}
