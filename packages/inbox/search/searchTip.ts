/**
 * The Search tip (the owner, 2026-11-26: "a little helpful popover tip … for when users use search the next time within
 * the search box"): a one-time card at the palette's search box that says words in quotes are an exact phrase. The
 * Launch tip's sibling (compose/launchTip.ts): the same card (`.ib-tour-coach.ib-ctip`), the same words' shape, the same
 * "seen once" kept by the Inbox (packages/shared/inbox/search-tip.ts, settings `reveal.search_tip`, the claim
 * `POST /api/inbox/reveal` `id: "search_tip"`). The rules the window keeps:
 *
 *  - The next open of the palette once the Inbox has it for this page. Never in the tour, on the first-run screen or
 *    while another one-time dialog or tip is claimed or up (App's `revealBlocked`, `lineBusy`), and never within the
 *    gap of one shown on this load (`oneTimeDialogShownThisLoad`).
 *  - It never moves a row once drawn (a person reaching for a row must not tap another): whether it shows is decided
 *    from what the page already knows, as the palette opens, so it is in the palette's first paint (no wait, no late
 *    push), and the claim goes out in that same moment. A refused claim (another window showed it, or a dialog's gap)
 *    leaves it up for this open, since taking it away would move the rows back; this page asks no more. A lost answer
 *    leaves it up too, as the Launch tip's does. Only the Inbox's yes holds the other one-time things back for the gap
 *    (`noteOneTimeDialogShown`) and says it to a screen reader.
 *  - Once per browser, whatever the Inbox answers: drawn, it is kept in this browser's storage (`SEARCH_TIP_SEEN_KEY`)
 *    and never offered here again, so a refused or lost claim (a read-only data folder, a full disk) cannot bring it
 *    back at every load. The Inbox's stamp still keeps it to once across this computer's browsers; a page that has it
 *    offered reads the settings again when it is shown or focused (`useSearchTipFresh`), so a tab left open while
 *    another device showed it learns that first. Worst case: once per browser.
 *  - Under the box it shows only when the results list keeps `SEARCH_TIP_MIN_ROWS` rows of room (a short window, a
 *    phone with little height): else not at this open, and nothing is spent, so a roomier open shows it.
 *  - Where: beside the palette, level with the box and pointing at it, when the window has room for the card and its
 *    gaps (the Launch tip's rule); else (a narrow window, a phone) under the box, in the palette's flow, so it covers
 *    neither the box nor a result. There the results list gives up the card's height (`--ib-sp-tip-h`, measured), so
 *    the palette still ends inside the window.
 *  - It leaves on Got it, Escape (the first Escape closes only the tip; the next is the palette's), a quote mark typed
 *    in the box, or the palette closing. No timer.
 *  - Focus never moves to it: typing goes on in the box. While it is up the box is described by its line.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  /** The way out (a 120 ms fade), then it is gone from the DOM. */
  leaveMs: 130,
  /** After a settings read (the page's, or one for the tip), the least wait before a focus or a shown tab reads them again. */
  freshGapMs: 10_000,
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

/**
 * Where this browser keeps "the Search tip was drawn here" (localStorage, the Inbox's `plannotator-inbox-…` keys, as
 * the Board chip's choice in compose/model.ts). Beside the Inbox's own stamp, not instead of it: the stamp makes it
 * once for this computer's every browser; this makes it once for this browser even when the stamp never lands (the
 * Inbox refused the claim, its data folder is read-only, or the answer was lost), so it never comes back at every load.
 */
export const SEARCH_TIP_SEEN_KEY = 'plannotator-inbox-search-tip-seen';

/** The tip was drawn in this browser already. Storage that cannot be read reads as not yet. */
export function searchTipSeenHere(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(SEARCH_TIP_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberSearchTipSeen(): void {
  try {
    localStorage.setItem(SEARCH_TIP_SEEN_KEY, '1');
  } catch {
    // Storage refused (private mode, quota): the Inbox's stamp and this page's own once still hold.
  }
}

/** `right`: beside the palette, its top from the palette's top. `below`: in the palette's flow, under the box. */
export type SearchTipPlace = { side: 'right'; top: number; left: number } | { side: 'below' };

/**
 * Beside the palette when the window has the card's width and its gaps at its right; else under the box. Every size is
 * a layout size (offsetLeft / offsetWidth / offsetTop), which the palette's entrance (`ib-sp-in`, scale 0.98 for its
 * first 150 ms) does not shrink: the card is placed in that first frame and must sit 16 px from the palette it ends at.
 * `dialog`: the palette's left and width in the window; `row`: the search box's top in the palette and its height.
 */
export function searchTipPlace(input: { phone: boolean; viewportWidth: number; dialog: { left: number; width: number }; row: { top: number; height: number } }): SearchTipPlace {
  const { phone, viewportWidth, dialog, row } = input;
  if (!phone && viewportWidth - (dialog.left + dialog.width) >= SEARCH_TIP_WIDTH + BESIDE_GAP + EDGE) {
    return { side: 'right', left: dialog.width + BESIDE_GAP, top: Math.round(row.top + row.height / 2 - ARROW_Y) };
  }
  return { side: 'below' };
}

/** The results list keeps at least this many rows of room under a card standing under the box. */
export const SEARCH_TIP_MIN_ROWS = 3;
/**
 * A result row's height when the list has none to measure yet: the rows' least height (inbox.css `.ib-sp-row`
 * min-height 34 px, a phone's 56 px), the height a one-line row measures in the built window.
 */
const ROW_FALLBACK = { desktop: 34, phone: 56 };

/**
 * The room the results list keeps with the card under the box, px. A desktop's list is capped by inbox.css
 * `.ib-sp-list` max-height, `min(560px, calc(88vh - 160px - card))` (the same sum: keep them together); a phone's list
 * fills what the palette leaves (flex 1), so its height measured with the card in place is its room.
 */
export function searchTipListRoom(input: { phone: boolean; viewportHeight: number; cardHeight: number; listHeight: number }): number {
  if (input.phone) return input.listHeight;
  return Math.min(560, 0.88 * input.viewportHeight - 160 - input.cardHeight);
}

/** Under the box, the card shows only when the results list keeps `SEARCH_TIP_MIN_ROWS` rows of room. Beside it takes none. */
export function searchTipFits(input: { place: SearchTipPlace; phone: boolean; viewportHeight: number; cardHeight: number; listHeight: number; rowHeight: number }): boolean {
  if (input.place.side === 'right') return true;
  const row = input.rowHeight > 0 ? input.rowHeight : input.phone ? ROW_FALLBACK.phone : ROW_FALLBACK.desktop;
  return searchTipListRoom(input) >= SEARCH_TIP_MIN_ROWS * row;
}

/**
 * While the tip is offered on this page (`due`) and was not drawn in this browser: the settings are read again
 * (`refresh`, the read the page makes anyway) when the tab is shown again or the window takes focus, at most once per
 * `SEARCH_TIP_TIMES.freshGapMs` (counted from when it became offered: the page has just read them). A tab left open while the tip was shown and stamped on another device then learns it is
 * no longer due before the next open. No timer: nothing is read while the tab sits in front, or once it is not offered.
 */
export function useSearchTipFresh(due: boolean, refresh: (() => void) | undefined): void {
  const run = useRef(refresh);
  run.current = refresh;
  useEffect(() => {
    if (!due) return;
    let last = Date.now();
    const again = () => {
      if (document.visibilityState === 'hidden' || searchTipSeenHere() || Date.now() - last < SEARCH_TIP_TIMES.freshGapMs) return;
      last = Date.now();
      run.current?.();
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [due]);
}

/** This page spends one claim at most (the palette stays mounted, but a remount must not ask again). */
let spentThisLoad = false;
const pageKey = `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
/** A test starts each case as a fresh load. */
export function resetSearchTipForTests(): void {
  spentThisLoad = false;
}

/** `trying`: the card is in place but not yet painted, measuring whether the results list keeps its room. */
export type SearchTipStage = 'none' | 'trying' | 'shown' | 'leaving' | 'done';

/**
 * The tip's stages for one palette. `offered`: the Inbox has it for this page and nothing holds it back (App), read
 * as the palette opens (a change while it is open draws nothing and takes nothing away). `say`: the palette's polite
 * region. Returns the stage, `placed` (the card's answer while `trying`: it fits) and `close` (Got it, Escape).
 */
export function useSearchTip(input: { open: boolean; offered: boolean; q: string; say: (words: string) => void }) {
  const { open, q } = input;
  const [stage, setStage] = useState<SearchTipStage>('none');
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const say = useRef(input.say);
  say.current = input.say;
  const offered = useRef(input.offered);
  offered.current = input.offered;
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Decided as the palette opens, before it is painted (a layout effect), so a shown card is in its first paint and
  // no row it pushes down is ever drawn above it first. The card then measures itself (`placed`), still before paint.
  useLayoutEffect(() => {
    if (!open) {
      setStage((was) => (was === 'none' ? 'none' : 'done'));
      return;
    }
    if (!offered.current || spentThisLoad || oneTimeDialogShownThisLoad() || searchTipSeenHere()) return;
    stageRef.current = 'trying';
    setStage('trying');
  }, [open]);

  // The card's answer, before the first paint. No room for the results under it: not at this open, nothing spent or
  // kept (a roomier open shows it). Room: it is drawn now, so this browser keeps that it was (never again here,
  // whatever the Inbox answers), and the claim goes out in the same moment.
  const placed = useCallback((fits: boolean) => {
    if (stageRef.current !== 'trying') return;
    if (!fits) {
      stageRef.current = 'none';
      setStage('none');
      return;
    }
    spentThisLoad = true;
    rememberSearchTipSeen();
    stageRef.current = 'shown';
    setStage('shown');
    void claimRevealOnce('search_tip', pageKey).then(
      (answer) => {
        // Refused: it stays up for this open (taking it away would move the rows under a finger); this page asks no more.
        if (!answer.show) return;
        noteOneTimeDialogShown();
        say.current(SEARCH_TIP_SAID);
      },
      // A lost answer (retried once already): it stays for this open, as the Launch tip's does.
      () => {},
    );
  }, []);

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

  return { stage, close, placed };
}
