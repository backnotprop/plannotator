/**
 * The one-time "themes" dialog on the page (approval "inbox-theme-chooser", 2026-11-10; the approved mock and its
 * build notes are in `.product/approved/inbox-theme-chooser/`). A dialog of the line (`theme_chooser`,
 * packages/shared/inbox/reveals.ts), right after the tab icon dialog: the Inbox makes it due for someone still on the
 * default theme and names it in `reveal.next` once the tab icon dialog is no longer due and the line's gap has passed.
 * The page arms it from there (`useLineReveal`) and opens it soon after the page does, as the tab icon dialog (the
 * owner, 2026-11-10: "themes can show up fifteen seconds after opening"; reveal.ts `soonMayClaim`, `atOnce`): the page
 * 15 s old and visible, the list loaded, with no thread to read and leave and no stillness to wait for. It still never
 * opens over something typed or open, a question waiting in the open thread, or a toast: it waits for that to end. A
 * palette picked on this page before then drops it (`holds`); one picked elsewhere makes the Inbox refuse the claim.
 *
 * Every way out is final (the claim stamped it): a card's button saves the theme and the mode as Settings does
 * (theme.ts), "Open Settings" goes to Settings' Colors row, the close button, Escape and a click outside change
 * nothing. No Not now, and no keyboard shortcut.
 *
 * Below the hook: the dialog's model (what a pick saves, the button's and the line's words, the fan's poses), pure, so
 * the tests read the rules without a browser.
 */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { useRef } from 'react';
import type { Mode } from '@plannotator/ui/theme-modes';
import { soonMayClaim, useLineReveal } from './reveal';

/** The default theme: both halves hold it until the person picks another (packages/shared/inbox/theme-chooser.ts). */
export const THEME_CHOOSER_DEFAULT = 'plannotator';

export interface ThemeChooserInput {
  /** The Inbox has it next for this page (settings `reveal.next === 'theme_chooser'`), read once per load. */
  due: boolean;
  /** The tour, an update or another one-time dialog was on screen (or due) on this load. */
  blocked: boolean;
  /** The list has loaded and is not the first-run screen. */
  listLoaded: boolean;
  firstRun: boolean;
  thread: string | null;
  rows: readonly InboxListRow[];
  /** The Inbox page with nothing over it: the list, with or without a thread open. */
  clear: boolean;
  place: string;
  heldBack: () => boolean;
  toast: boolean;
  /** The palettes on this page now (ThemeProvider): the dialog is only for the default theme on both halves. */
  light: string;
  dark: string;
}

/** Its need at a settled moment: the list loaded, not the first-run screen, the page 15 s old and visible. */
export function themeChooserMayClaim(gate: Pick<ThemeChooserInput, 'listLoaded' | 'firstRun'>, pageAge: number): boolean {
  return soonMayClaim(gate, pageAge);
}

/** Both halves still hold the default theme. */
export function themeChooserOnDefault(pair: { light: string; dark: string }): boolean {
  return pair.light === THEME_CHOOSER_DEFAULT && pair.dark === THEME_CHOOSER_DEFAULT;
}

export function useThemeChooser(input: ThemeChooserInput) {
  const latest = useRef(input);
  latest.current = input;
  return useLineReveal({
    id: 'theme_chooser',
    due: input.due,
    blocked: input.blocked,
    thread: input.thread,
    rows: input.rows,
    clear: input.clear,
    place: input.place,
    heldBack: input.heldBack,
    toast: input.toast,
    // The moment is now (`atOnce`), never a leave.
    leaveCounts: () => false,
    atOnce: true,
    mayClaim: (pageAge) => themeChooserMayClaim(latest.current, pageAge),
    // A palette picked on this page meanwhile (Settings' Colors row): nothing left to offer.
    holds: () => themeChooserOnDefault(latest.current),
  });
}

/**
 * "Choose your own": Settings opens on General and its Colors row (components/Palettes.tsx) comes into view with the
 * focus on the half in use, once Settings has drawn it. No address of its own: `#settings/general` is the page's.
 */
export function openThemeSettings(): void {
  window.location.hash = '#settings/general';
  let tries = 0;
  const land = () => {
    const row = document.querySelector<HTMLElement>('[data-settings-palettes]');
    if (!row) {
      if (++tries < 120) requestAnimationFrame(land);
      return;
    }
    row.scrollIntoView?.({ block: 'center' });
    row.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  };
  requestAnimationFrame(land);
}

/* ------------------------------------------------------------------ the dialog's model */

export type ThemeChooserHalf = 'light' | 'dark';

/** The two theme cards, in the fan's order; the third card is "Choose your own". */
export const THEME_CHOOSER_THEMES = [
  { id: 'plannotator', name: 'Original', line: 'Violet on slate' },
  { id: 'plannotator-modern', name: 'Modern', line: 'White and true black, Inter' },
] as const;
export type ThemeChooserThemeId = (typeof THEME_CHOOSER_THEMES)[number]['id'];
/** A card of the fan: a theme, or "Choose your own". */
export type ThemeChooserCardId = ThemeChooserThemeId | 'own';
export const THEME_CHOOSER_CARDS: readonly ThemeChooserCardId[] = ['plannotator', 'plannotator-modern', 'own'];

/** "Choose your own": the three themes its picture deals (palette id, the half shown, the name on its tag). */
export const THEME_CHOOSER_OWN = [
  { id: 'catppuccin', half: 'dark', name: 'Catppuccin' },
  { id: 'solarized', half: 'light', name: 'Solarized' },
  { id: 'tokyo-night', half: 'dark', name: 'Tokyo Night' },
] as const;

/** The title's six tiles, one per letter of "themes": a real theme each (its background and its primary). */
export const THEME_CHOOSER_TILES: readonly { theme: string; light: boolean }[] = [
  { theme: 'plannotator', light: true },
  { theme: 'plannotator-modern', light: false },
  { theme: 'catppuccin', light: false },
  { theme: 'solarized', light: true },
  { theme: 'tokyo-night', light: false },
  { theme: 'rose-pine', light: true },
];

/** The dialog's words (the approved mock's; the card lines and the "follows your system" line still need the owner's OK). */
export const THEME_CHOOSER_WORDS = {
  /** The heading as a screen reader hears it; on screen it is the six lettered tiles. */
  title: 'Themes',
  lettering: 'themes',
  close: 'Close',
  brand: 'Plannotator',
  inUse: 'In use',
  followsSystem: 'follows your system',
  always: (half: ThemeChooserHalf) => `always ${half}`,
  keep: (name: string) => `Keep ${name}`,
  use: (name: string, half: ThemeChooserHalf) => `Use ${name}, ${half}`,
  /** The corner of the sheet behind: its visible word, and its name. */
  corner: (half: ThemeChooserHalf) => half,
  cornerLabel: (name: string, half: ThemeChooserHalf) => `Show Plannotator ${name} in ${half}`,
  sheetAlt: (name: string, half: ThemeChooserHalf) => `The Inbox in Plannotator ${name}, ${half}`,
  own: 'Choose your own',
  ownLine: (more: number) => `${more} more themes, one for light and one for dark`,
  ownAlt: (name: string) => `The Inbox in ${name}`,
  openSettings: 'Open Settings',
} as const;

export const otherHalf = (half: ThemeChooserHalf): ThemeChooserHalf => (half === 'light' ? 'dark' : 'light');

/**
 * What picking a theme saves (the approved rule: "pick without shuffling = follows system"): the theme on both
 * halves, and the mode. The sheet in front is the system's mode (the person never shuffled, or shuffled back): Match
 * system. The other sheet in front: that mode, fixed.
 */
export function themeChooserPick(theme: ThemeChooserThemeId, front: ThemeChooserHalf, system: ThemeChooserHalf): { light: string; dark: string; mode: Mode } {
  return { light: theme, dark: theme, mode: front === system ? 'system' : front };
}

/** What is in use now, as the dialog reads it (ThemeProvider): the two palettes and the saved mode. */
export interface ThemeChooserInUse {
  light: string;
  dark: string;
  mode: Mode;
}

/** This card's theme is the one in use: both halves hold it. */
export function themeChooserInUse(theme: ThemeChooserThemeId, inUse: ThemeChooserInUse): boolean {
  return inUse.light === theme && inUse.dark === theme;
}

/** Picking this would change nothing: the theme is in use and the mode it would save is the saved one. */
export function themeChooserKeeps(theme: ThemeChooserThemeId, front: ThemeChooserHalf, system: ThemeChooserHalf, inUse: ThemeChooserInUse): boolean {
  return themeChooserInUse(theme, inUse) && themeChooserPick(theme, front, system).mode === inUse.mode;
}

/** The card's button: "Keep Original" when nothing would change, else the theme and the mode it would show. */
export function themeChooserButton(theme: ThemeChooserThemeId, front: ThemeChooserHalf, system: ThemeChooserHalf, inUse: ThemeChooserInUse): string {
  const name = THEME_CHOOSER_THEMES.find((t) => t.id === theme)!.name;
  return themeChooserKeeps(theme, front, system, inUse) ? THEME_CHOOSER_WORDS.keep(name) : THEME_CHOOSER_WORDS.use(name, front);
}

/** The card's line: the theme in a few words, then what picking it does to the mode. */
export function themeChooserLine(theme: ThemeChooserThemeId, front: ThemeChooserHalf, system: ThemeChooserHalf): string {
  const line = THEME_CHOOSER_THEMES.find((t) => t.id === theme)!.line;
  return `${line} · ${front === system ? THEME_CHOOSER_WORDS.followsSystem : THEME_CHOOSER_WORDS.always(front)}`;
}

/* ------------------------------------------------------------------ the fan's geometry and motion (the build notes) */

/** The one speed (the owner: "six hundred milliseconds. That's final"), and what derives from it. */
export const THEME_CHOOSER_MOTION = {
  /** A card coming forward. */
  inMs: 600,
  inEase: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  /** The cards going back (0.86 of it). */
  outMs: 516,
  outEase: 'cubic-bezier(0.33, 0.55, 0.4, 1)',
  /** Each card a beat after its neighbour, by its distance from the new front card. */
  staggerMs: 60,
  /** Rest on a card or on the corner this long before anything moves. */
  intentMs: 70,
  /** The light/dark shuffle inside a card (0.9 of it); the sheets meet where the curve reaches half. */
  shuffleMs: 540,
  shuffleEase: [0.32, 0, 0.22, 1] as const,
  /** `will-change` stays this long after the longest move. */
  settleMs: 60,
  /** A swipe on a touch screen moves one card past this many px, when more across than down. */
  swipePx: 30,
  /** The 3D context's depth: a card's size comes from how far back it sits. */
  perspective: 1900,
} as const;

/** The layout's numbers: the fan on a desktop, the deck on a phone (at most 520 px wide). */
export interface ThemeChooserGeometry {
  deck: boolean;
  /** The stage's own width before it is scaled to fit. */
  width: number;
  /** How far the sheet behind sits out, right and up: its visible corner. */
  peekX: number;
  peekY: number;
  sheetW: number;
  sheetH: number;
  cardW: number;
  /** The distance between two cards' places in the fan (0 in the deck). */
  slot: number;
}

export const THEME_CHOOSER_DECK_MAX = 520;

export function themeChooserGeometry(viewportWidth: number): ThemeChooserGeometry {
  const deck = viewportWidth <= THEME_CHOOSER_DECK_MAX;
  const peekX = deck ? 26 : 46;
  const peekY = deck ? 24 : 38;
  const sheetW = deck ? Math.min(294, viewportWidth - 96) : 660;
  const sheetH = Math.round(sheetW * (deck ? 862 / 600 : 925 / 1360));
  return { deck, width: deck ? viewportWidth : 1140, peekX, peekY, sheetW, sheetH, cardW: sheetW + peekX + (deck ? 20 : 28), slot: deck ? 0 : 190 };
}

export interface ThemeChooserPose {
  x: number;
  y: number;
  /** The card's size on screen, 1 in front. */
  s: number;
  /** Degrees. */
  r: number;
}

/** Where card `i` rests while card `front` is in front. */
export function themeChooserPose(i: number, front: number, g: ThemeChooserGeometry): ThemeChooserPose {
  const rel = i - front;
  const a = Math.abs(rel);
  const side = Math.sign(rel);
  if (g.deck) {
    const s = a === 0 ? 1 : 0.92;
    const step = (g.cardW * (1 + s)) / 2 + 10;
    return { x: a === 0 ? 0 : side * (step + (a - 1) * (g.cardW * s + 10)), y: a * 8, s, r: side * Math.min(a, 1) * 1.5 };
  }
  const s = a === 0 ? 1 : a === 1 ? 0.8 : 0.71;
  return { x: (i - 1) * g.slot + side * (a === 0 ? 0 : a === 1 ? 14 : 24), y: a === 0 ? 0 : a === 1 ? 22 : 38, s, r: side * (a === 0 ? 0 : a === 1 ? 3 : 6) };
}

/** A pose as the card's one transform: its depth gives its size, so depth order is the order on screen. */
export function themeChooserTransform(p: ThemeChooserPose): string {
  const z = THEME_CHOOSER_MOTION.perspective * (1 - 1 / p.s);
  return `translate3d(${(p.x / p.s).toFixed(2)}px, ${(p.y / p.s).toFixed(2)}px, ${z.toFixed(2)}px) rotate(${p.r}deg)`;
}

/** How card `i` moves when `front` becomes the front card: its duration, delay and curve. */
export function themeChooserMove(i: number, front: number, instant: boolean): { ms: number; delayMs: number; ease: string } {
  const m = THEME_CHOOSER_MOTION;
  const coming = i === front;
  if (instant) return { ms: 0, delayMs: 0, ease: coming ? m.inEase : m.outEase };
  return { ms: coming ? m.inMs : m.outMs, delayMs: Math.abs(i - front) * m.staggerMs, ease: coming ? m.inEase : m.outEase };
}

/**
 * The card a point means, by where the cards are going (the front card first), never by what is under a still pointer
 * mid-move: so the fan cannot fight itself. `x` from the stage's centre and `y` from its top, in the stage's own px.
 * -1: none.
 */
export function themeChooserCardAt(x: number, y: number, front: number, count: number, cardH: number, g: ThemeChooserGeometry): number {
  const byDepth = Array.from({ length: count }, (_, i) => i).sort((a, b) => Math.abs(a - front) - Math.abs(b - front));
  for (const i of byDepth) {
    const p = themeChooserPose(i, front, g);
    const half = (g.cardW * p.s) / 2;
    const top = 10 + p.y + cardH * (1 - p.s) * 0.5;
    const bottom = top + cardH * p.s;
    if (x >= p.x - half && x <= p.x + half && y >= top - 10 && y <= bottom + 10) return i;
  }
  return -1;
}

/** Time (0..1) at which a cubic-bezier curve reaches progress `y`. */
export function themeChooserTimeAt(e: readonly [number, number, number, number], y: number): number {
  const bz = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (bz(e[1], e[3], m) < y) lo = m;
    else hi = m;
  }
  return bz(e[0], e[2], lo);
}
