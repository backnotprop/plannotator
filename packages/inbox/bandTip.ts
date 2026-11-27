/**
 * The Group tip (the owner, 2026-11-20: "We would need to inform the users they can do that though... Like a one-time
 * kind of like hover thing ... Ideally we reuse it"): a group band's own tooltip (Tip, the one every control's hover
 * text uses), shown once, that says the band has a menu. The "seen once" is the Inbox's, kept where the other tips
 * keep theirs (packages/shared/inbox/band-tip.ts, settings `reveal.band_tip`, the claim `POST /api/inbox/reveal`
 * `id: "band_tip"`). There is no card and no dialog: the Launch and Sidebar tips' coach card asks for a calm moment
 * and a Got it, too much for one line about a right-click. The rules the window keeps:
 *
 *  - A desktop: once the pointer has rested on a band that has a menu for BAND_TIP_TIMES.restMs (a pointer merely
 *    crossing it spends nothing), its tooltip reads BAND_TIP_WORDS.desktop; it goes when the pointer leaves the band.
 *    A phone (no hover): once the list has held still (no touch, no scroll) for BAND_TIP_TIMES.phoneViewMs, the first
 *    band with a menu that is on screen shows BAND_TIP_WORDS.phone; with none on screen it waits again.
 *  - Never while the list is out of sight (a thread covers it: a phone, a stacked window, full screen; the page
 *    hidden), while picking rows (a band has no menu then), while another one-time dialog or tip is claimed or up, a
 *    menu or a dialog is open, or something is typed (`busy`); never on the tour. The Inbox reports it due only outside
 *    a dialog's gap and only a day after first use, so a fresh world (the e2e ones) never sees it.
 *  - It goes by itself after BAND_TIP_TIMES.shownMs, and at once on any press, key, scroll, a right-click or the band's
 *    menu opening. One claim per page; the Inbox gives it once per person.
 *  - A band's menu really opening (never a press that only took the pressed look) before the tip ever showed retires
 *    it for good: `used` stamps it whatever the tenure or a dialog's gap (the person has found the menu).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { post, type SettingsModel } from './api';
import { inboxUrl } from './inboxUrl';
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
  /** A phone: the list held still (no touch, no scroll) this long with a band that has a menu on screen. */
  phoneViewMs: 2500,
  /** A desktop: the pointer rests on the band this long first. */
  restMs: 600,
};

/** The Inbox has the tip for this page. */
export function bandTipDue(settings: Pick<SettingsModel, 'reveal'> | null | undefined): boolean {
  return !!settings && settings.reveal?.band_tip === true;
}

/** What the window hands the list (App.tsx): absent, no tip. */
export interface BandTipHost {
  /** The Inbox has it for this page, and nothing of this load rules it out (the tour, the first-run screen). */
  due: boolean;
  /** The list is out of sight, another one-time dialog or tip is claimed or up, a menu or dialog is open, or something is typed. */
  busy: () => boolean;
  /** Spends the claim: true when the tip may show (`claimRevealOnce('band_tip')`). */
  claim: () => Promise<boolean>;
  /** A band's menu opened: the tip is stamped and never shows (`retireBandTip`), due or not. */
  used: () => unknown;
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
 * A band's menu opened: the Group tip is stamped and never shows, whatever the tenure or a dialog's gap. Best effort: a
 * lost answer only means the tip may still show once.
 */
export function retireBandTip(): Promise<void> {
  return post<{ show: boolean }>(inboxUrl('/reveal'), { id: 'band_tip', used: true }).then(
    () => undefined,
    () => undefined,
  );
}

/** App's host for the list: one claimer per page; `busy` is read as App last drew it (the list asks from its timers). */
export function useBandTipHost(due: boolean, busy: () => boolean): BandTipHost {
  const claim = useMemo(() => bandTipClaimer(), []);
  const latestBusy = useRef(busy);
  latestBusy.current = busy;
  return { due, busy: () => latestBusy.current(), claim, used: retireBandTip };
}

/**
 * Whether a group's band is in view now: inside the window and inside the list's scrolling box (a phone's Group tip
 * waits for one).
 */
export function bandOnScreen(body: HTMLElement | null, sectionId: string): boolean {
  const band = body?.querySelector<HTMLElement>(`.ib-group[data-section-id="${CSS.escape(sectionId)}"] > button.ib-band`);
  if (!band) return false;
  const rect = band.getBoundingClientRect();
  if (rect.height === 0) return false;
  let top = 0;
  let bottom = window.innerHeight;
  for (let el = band.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    const box = el.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
    break;
  }
  return rect.top >= top && rect.bottom <= bottom;
}

/**
 * The list side. `menuBands`: the bands that have a menu now, in order (none while picking, none while the list is out
 * of sight). `onScreen`: whether a band is in view now (a phone's tip waits for one). Returns the band showing the tip
 * (its words), and what the bands report: a hover (`pointed`) and its end (`left`), a band's menu opening (`menuOpened`).
 */
export function useBandTip(host: BandTipHost | undefined, phone: boolean, menuBands: readonly string[], onScreen: (band: string) => boolean = () => true) {
  const [shown, setShown] = useState<{ band: string; words: string } | null>(null);
  /** This page has asked (or retired it): never again on this load. */
  const spent = useRef(false);
  const latest = useRef({ host, menuBands, onScreen });
  latest.current = { host, menuBands, onScreen };
  /** A desktop: the band the pointer rests on, and the wait before its tip. */
  const resting = useRef<{ band: string; timer: ReturnType<typeof setTimeout> } | null>(null);
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
  const stopResting = () => {
    if (resting.current) clearTimeout(resting.current.timer);
    resting.current = null;
  };
  useEffect(() => stopResting, []);
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
  // The band left, picking started or the list went out of sight: gone.
  useEffect(() => {
    if (shown && !menuBands.includes(shown.band)) setShown(null);
  }, [shown, menuBands]);
  // A phone: the list held still for a while with a band that has a menu on screen.
  const watching = phone && menuBands.length > 0;
  const due = !!host?.due;
  useEffect(() => {
    if (!watching || !due || spent.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wait = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (spent.current) return;
        const band = latest.current.menuBands.find((id) => latest.current.onScreen(id));
        if (band && may()) show(band, BAND_TIP_WORDS.phone);
        // None on screen, or something else is up: it waits again.
        else wait();
      }, BAND_TIP_TIMES.phoneViewMs);
    };
    wait();
    // A touch (a scroll, a swipe, a tap) or a scroll by any means starts the wait again.
    window.addEventListener('touchstart', wait, { capture: true, passive: true });
    window.addEventListener('scroll', wait, { capture: true, passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('touchstart', wait, { capture: true });
      window.removeEventListener('scroll', wait, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, due]);
  return {
    shown,
    /** The pointer came onto a band (a mouse, never a touch): its tip shows once it has rested there. */
    pointed: (band: string) => {
      if (phone || !latest.current.menuBands.includes(band) || !may()) return;
      stopResting();
      resting.current = {
        band,
        timer: setTimeout(() => {
          resting.current = null;
          if (latest.current.menuBands.includes(band) && may()) show(band, BAND_TIP_WORDS.desktop);
        }, BAND_TIP_TIMES.restMs),
      };
    },
    /** The pointer left a band: no tip for it now, and one showing goes, as a tooltip does. */
    left: (band: string) => {
      if (resting.current?.band === band) stopResting();
      setShown((now) => (now?.band === band ? null : now));
    },
    /** A band's menu really opened: the tip goes, and one never shown is retired for good (whatever the tenure). */
    menuOpened: () => {
      setShown(null);
      stopResting();
      if (spent.current || !latest.current.host) return;
      spent.current = true;
      void Promise.resolve(latest.current.host.used()).catch(() => {});
    },
  };
}
