import type { InboxListRow } from '@plannotator/core/inbox-types';
import { useRef } from 'react';
import type { Mode } from '@plannotator/ui/theme-modes';
import { soonMayClaim, useLineReveal } from './reveal';

export const THEME_CHOOSER_DEFAULT = 'plannotator';

export interface ThemeChooserInput {
  due: boolean;
  blocked: boolean;
  listLoaded: boolean;
  firstRun: boolean;
  thread: string | null;
  rows: readonly InboxListRow[];
  clear: boolean;
  place: string;
  heldBack: () => boolean;
  toast: boolean;
  light: string;
  dark: string;
}

export function themeChooserMayClaim(gate: Pick<ThemeChooserInput, 'listLoaded' | 'firstRun'>, pageAge: number): boolean {
  return soonMayClaim(gate, pageAge);
}

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
    leaveCounts: () => false,
    atOnce: true,
    mayClaim: (pageAge) => themeChooserMayClaim(latest.current, pageAge),
    holds: () => themeChooserOnDefault(latest.current),
  });
}

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

export type ThemeChooserHalf = 'light' | 'dark';

export const THEME_CHOOSER_THEMES = [
  { id: 'plannotator', name: 'Original', line: 'Violet on slate' },
  { id: 'plannotator-modern', name: 'Modern', line: 'White and true black, Inter' },
] as const;
export type ThemeChooserThemeId = (typeof THEME_CHOOSER_THEMES)[number]['id'];
export type ThemeChooserCardId = ThemeChooserThemeId | 'own';
export const THEME_CHOOSER_CARDS: readonly ThemeChooserCardId[] = ['plannotator', 'plannotator-modern', 'own'];

export const THEME_CHOOSER_OWN = [
  { id: 'catppuccin', half: 'dark', name: 'Catppuccin' },
  { id: 'solarized', half: 'light', name: 'Solarized' },
  { id: 'tokyo-night', half: 'dark', name: 'Tokyo Night' },
] as const;

export const THEME_CHOOSER_TILES: readonly { theme: string; light: boolean }[] = [
  { theme: 'plannotator', light: true },
  { theme: 'plannotator-modern', light: false },
  { theme: 'catppuccin', light: false },
  { theme: 'solarized', light: true },
  { theme: 'tokyo-night', light: false },
  { theme: 'rose-pine', light: true },
];

export const THEME_CHOOSER_WORDS = {
  title: 'Themes',
  lettering: 'themes',
  close: 'Close',
  brand: 'Plannotator',
  inUse: 'In use',
  followsSystem: 'follows your system',
  always: (half: ThemeChooserHalf) => `always ${half}`,
  keep: (name: string) => `Keep ${name}`,
  use: (name: string, half: ThemeChooserHalf) => `Use ${name}, ${half}`,
  corner: (half: ThemeChooserHalf) => half,
  cornerLabel: (name: string, half: ThemeChooserHalf) => `Show Plannotator ${name} in ${half}`,
  sheetAlt: (name: string, half: ThemeChooserHalf) => `The Inbox in Plannotator ${name}, ${half}`,
  own: 'Choose your own',
  ownLine: (more: number) => `${more} more themes, one for light and one for dark`,
  ownAlt: (name: string) => `The Inbox in ${name}`,
  openSettings: 'Open Settings',
} as const;

export const otherHalf = (half: ThemeChooserHalf): ThemeChooserHalf => (half === 'light' ? 'dark' : 'light');

export function themeChooserPick(theme: ThemeChooserThemeId, front: ThemeChooserHalf, system: ThemeChooserHalf): { light: string; dark: string; mode: Mode } {
  return { light: theme, dark: theme, mode: front === system ? 'system' : front };
}

export interface ThemeChooserInUse {
  light: string;
  dark: string;
  mode: Mode;
}

export function themeChooserInUse(theme: ThemeChooserThemeId, inUse: ThemeChooserInUse): boolean {
  return inUse.light === theme && inUse.dark === theme;
}

export function themeChooserKeeps(theme: ThemeChooserThemeId, front: ThemeChooserHalf, system: ThemeChooserHalf, inUse: ThemeChooserInUse): boolean {
  return themeChooserInUse(theme, inUse) && themeChooserPick(theme, front, system).mode === inUse.mode;
}

export function themeChooserButton(theme: ThemeChooserThemeId, front: ThemeChooserHalf, system: ThemeChooserHalf, inUse: ThemeChooserInUse): string {
  const name = THEME_CHOOSER_THEMES.find((t) => t.id === theme)!.name;
  return themeChooserKeeps(theme, front, system, inUse) ? THEME_CHOOSER_WORDS.keep(name) : THEME_CHOOSER_WORDS.use(name, front);
}

export function themeChooserLine(theme: ThemeChooserThemeId, front: ThemeChooserHalf, system: ThemeChooserHalf): string {
  const line = THEME_CHOOSER_THEMES.find((t) => t.id === theme)!.line;
  return `${line} · ${front === system ? THEME_CHOOSER_WORDS.followsSystem : THEME_CHOOSER_WORDS.always(front)}`;
}

export const THEME_CHOOSER_MOTION = {
  inMs: 600,
  inEase: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  outMs: 516,
  outEase: 'cubic-bezier(0.33, 0.55, 0.4, 1)',
  staggerMs: 60,
  intentMs: 70,
  shuffleMs: 540,
  shuffleEase: [0.32, 0, 0.22, 1] as const,
  settleMs: 60,
  swipePx: 30,
  perspective: 1900,
} as const;

export interface ThemeChooserGeometry {
  deck: boolean;
  width: number;
  peekX: number;
  peekY: number;
  sheetW: number;
  sheetH: number;
  cardW: number;
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
  s: number;
  r: number;
}

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

export function themeChooserTransform(p: ThemeChooserPose): string {
  const z = THEME_CHOOSER_MOTION.perspective * (1 - 1 / p.s);
  return `translate3d(${(p.x / p.s).toFixed(2)}px, ${(p.y / p.s).toFixed(2)}px, ${z.toFixed(2)}px) rotate(${p.r}deg)`;
}

export function themeChooserMove(i: number, front: number, instant: boolean): { ms: number; delayMs: number; ease: string } {
  const m = THEME_CHOOSER_MOTION;
  const coming = i === front;
  if (instant) return { ms: 0, delayMs: 0, ease: coming ? m.inEase : m.outEase };
  return { ms: coming ? m.inMs : m.outMs, delayMs: Math.abs(i - front) * m.staggerMs, ease: coming ? m.inEase : m.outEase };
}

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
