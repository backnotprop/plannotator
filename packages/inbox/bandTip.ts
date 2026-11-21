/**
 * The Group tip (the owner, 2026-11-20: "We would need to inform the users they can do that though... Like a one-time
 * kind of like hover thing ... Ideally we reuse it"): a group band's own tooltip (Tip, the one every control's hover
 * text uses), shown once, that says the band has a menu. The "seen once" is the Inbox's, kept where the other tips
 * keep theirs (packages/shared/inbox/band-tip.ts, settings `reveal.band_tip`, the claim `POST /api/inbox/reveal`
 * `id: "band_tip"`). There is no card and no dialog: the Launch and Sidebar tips' coach card asks for a calm moment
 * and a Got it, too much for one line about a right-click. The rules the window keeps:
 *
 *  - A desktop: the first time the pointer rests on a band that has a menu, its tooltip reads BAND_TIP_WORDS.desktop.
 *    A phone (no hover): once the list has held still with such a band on screen for BAND_TIP_TIMES.phoneViewMs, with
 *    no touch meanwhile (so never in a scroll or a row's swipe), the first such band's tooltip reads
 *    BAND_TIP_WORDS.phone.
 *  - Never while picking rows (a band has no menu then), while another one-time dialog or tip is claimed or up, a menu
 *    or a dialog is open, or something is typed (`busy`); never on the tour. The Inbox reports it due only outside a
 *    dialog's gap and only a day after first use, so a fresh world (the e2e ones) never sees it.
 *  - It goes by itself after BAND_TIP_TIMES.shownMs, and at once on any press, key, scroll, a right-click or the band's
 *    menu opening. One claim per page; the Inbox gives it once per person.
 *  - Opening a band's menu before the tip ever showed claims it too (unshown): the person has found the menu.
 */
import { useEffect, useRef, useState } from 'react';
import type { SettingsModel } from './api';
import { claimRevealOnce } from './reveal';
import { newUuid } from './uuid';

export const BAND_TIP_WORDS = {
  desktop: 'Right-click for group actions',
  phone: 'Hold a group for actions',
} as const;

/** ms. A test shrinks them (and puts them back). */
export const BAND_TIP_TIMES = {
  /** Shown this long, then gone. */
  shownMs: 6000,
  /** A phone: the list held still (no touch) this long with a band that has a menu on screen. */
  phoneViewMs: 2500,
};

/** The Inbox has the tip for this page. */
export function bandTipDue(settings: Pick<SettingsModel, 'reveal'> | null | undefined): boolean {
  return !!settings && settings.reveal?.band_tip === true;
}

/** What the window hands the list (App.tsx): absent, no tip. */
export interface BandTipHost {
  /** The Inbox has it for this page, and nothing of this load rules it out (the tour, the first-run screen). */
  due: boolean;
  /** Another one-time dialog or tip is claimed or up, a menu or dialog is open, or something is typed. */
  busy: () => boolean;
  /** Spends the claim: true when the tip may show (`claimRevealOnce('band_tip')`). */
  claim: () => Promise<boolean>;
}

/** The App side: one key per page, so a retry after a lost answer is shown it again. */
export function bandTipClaimer(): () => Promise<boolean> {
  let key: string | null = null;
  return async () => {
    key ??= newUuid();
    return (await claimRevealOnce('band_tip', key)).show;
  };
}

/**
 * The list side. `menuBands`: the bands on screen that have a menu now, in order (none while picking). Returns the band
 * showing the tip (its words), and what the bands report: a hover (`pointed`), a band's menu opening (`menuOpened`).
 */
export function useBandTip(host: BandTipHost | undefined, phone: boolean, menuBands: readonly string[]) {
  const [shown, setShown] = useState<{ band: string; words: string } | null>(null);
  /** This page has asked (or retired it): never again on this load. */
  const spent = useRef(false);
  const latest = useRef({ host, menuBands });
  latest.current = { host, menuBands };
  const may = () => {
    const now = latest.current;
    return !!now.host?.due && !spent.current && !now.host.busy();
  };
  const show = (band: string, words: string) => {
    spent.current = true;
    void latest.current.host!.claim().then(
      (ok) => {
        // Still there and nothing else came up meanwhile.
        if (ok && latest.current.menuBands.includes(band) && !latest.current.host?.busy()) setShown({ band, words });
      },
      () => {},
    );
  };
  // Shown: gone after a while, and at once on any press, key, scroll or right-click.
  useEffect(() => {
    if (!shown) return;
    const hide = () => setShown(null);
    const timer = setTimeout(hide, BAND_TIP_TIMES.shownMs);
    const kinds = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'contextmenu', 'scroll'] as const;
    for (const kind of kinds) window.addEventListener(kind, hide, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      for (const kind of kinds) window.removeEventListener(kind, hide, { capture: true });
    };
  }, [shown]);
  // The band left, or picking started: gone.
  useEffect(() => {
    if (shown && !menuBands.includes(shown.band)) setShown(null);
  }, [shown, menuBands]);
  // A phone: the list held still for a while with a band that has a menu on screen.
  const first = phone ? (menuBands[0] ?? null) : null;
  const due = !!host?.due;
  useEffect(() => {
    if (!first || !due || spent.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wait = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const band = latest.current.menuBands[0];
        if (band && may()) show(band, BAND_TIP_WORDS.phone);
      }, BAND_TIP_TIMES.phoneViewMs);
    };
    wait();
    // A touch (a scroll, a swipe, a tap) starts the wait again.
    window.addEventListener('touchstart', wait, { capture: true, passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('touchstart', wait, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, due]);
  return {
    shown,
    /** The pointer came onto a band (a mouse, never a touch). */
    pointed: (band: string) => {
      if (!phone && latest.current.menuBands.includes(band) && may()) show(band, BAND_TIP_WORDS.desktop);
    },
    /** A band's menu opened: the tip goes, and one never shown is claimed so it never shows. */
    menuOpened: () => {
      setShown(null);
      if (spent.current || !latest.current.host?.due) return;
      spent.current = true;
      void latest.current.host.claim().catch(() => {});
    },
  };
}
