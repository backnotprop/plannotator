/**
 * The tour's "Make it yours" card (step 10 of 11; the owner, 2026-11-02): the
 * theme, three colour sets and the text size, drawn over the tour's Inbox so
 * a pick shows at once on a full window. Every control writes through the
 * same hooks as Settings → General → Appearance (theme.ts, textSize.ts), so
 * nothing here has storage of its own: the `plannotator-theme` cookie and
 * config.json `theme`, and config.json `inboxTextSize` with its cookie.
 *
 * Skip puts back only what the card itself changed, each field to its value
 * just before the card first changed it (`restore`, through the card's
 * handle): never a snapshot from the card's first render, which can come
 * before the first settings read and would write the cookie's or the default
 * values over config.json. Before writing, Skip reads the settings again and
 * leaves a field another window changed since. The card's Next ("Connect
 * agents next") keeps what was picked. Under the colour sets, how many more
 * Settings offers (counted from the palette registry), with the link to
 * Settings → General. A colour set is picked for both halves at once (the three offered draw both); Settings still picks a
 * palette per half, and offers every palette. No keyboard shortcut: each
 * control is a native radio group, one tab stop, the arrows move the pick.
 */

import { forwardRef, useImperativeHandle, useRef } from 'react';
import { paletteSwatchColors } from '@plannotator/ui/components/ThemeTab';
import { BUILT_IN_THEMES, type ThemeColors, type ThemeHalf, type ThemeInfo } from '@plannotator/ui/utils/themeRegistry';
import type { Mode } from '@plannotator/ui/theme-modes';
import { INBOX_TEXT_SIZES, type InboxTextSize } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { Icon } from '../icons';
import { useInboxPalettes, useInboxTheme } from '../theme';
import { chooseTextSize, useInboxTextSize } from '../textSize';

/** The colour sets offered, in this order (the owner, 2026-11-02). Each draws both halves. */
export const TOUR_COLOR_SETS = ['plannotator', 'plannotator-modern', 'catppuccin'] as const;

/** How many palettes Settings offers beyond the step's three: every palette in the registry, never a fixed number. */
export function tourMoreColorSets(themes: readonly ThemeInfo[] = BUILT_IN_THEMES): number {
  return themes.filter((theme) => !(TOUR_COLOR_SETS as readonly string[]).includes(theme.id)).length;
}

const MODES: { id: Mode; label: string; icon: 'sun' | 'moon' | 'system' }[] = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'system', label: 'Match system', icon: 'system' },
];

/** The tile's name: "Modern" for "Plannotator Modern"; the card already says it is Plannotator. */
const shortName = (theme: ThemeInfo) => (theme.id === 'plannotator' ? theme.name : theme.name.replace(/^Plannotator /, ''));

function colorsOf(id: string, half: ThemeHalf): ThemeColors {
  return (BUILT_IN_THEMES.find((theme) => theme.id === id) ?? BUILT_IN_THEMES[0]!).colors[half];
}

/** A window in small, in one half's colours: a sidebar with its selection, a few lines, a button. */
function MiniWindow({ colors }: { colors: ThemeColors }) {
  const ink = (percent: number) => `color-mix(in oklch, ${colors.foreground} ${percent}%, transparent)`;
  return (
    <span className="ib-tset-win" style={{ background: colors.background, color: colors.foreground }}>
      <span className="ib-tset-side" style={{ background: `color-mix(in oklch, ${colors.foreground} 9%, ${colors.background})` }}>
        <span style={{ background: colors.primary }} />
      </span>
      <span className="ib-tset-lines">
        <span style={{ background: ink(55), width: '70%' }} />
        <span style={{ background: ink(25), width: '90%' }} />
        <span style={{ background: ink(25), width: '55%' }} />
        <span className="ib-tset-btn" style={{ background: colors.primary }} />
      </span>
    </span>
  );
}

interface Fields {
  mode: Mode;
  light: string;
  dark: string;
  size: InboxTextSize;
}
type Field = keyof Fields;

/** One field the card changed: its value just before the card's first change, and the card's latest pick. */
interface Changed<K extends Field> {
  before: Fields[K];
  wrote: Fields[K];
}
type ChangedFields = { [K in Field]?: Changed<K> };

/** config.json's value of each field, from a settings read (undefined: never saved, or the read failed). */
function savedFields(settings: { theme?: { mode?: unknown; light?: unknown; dark?: unknown } | null; text_size?: unknown } | null): Partial<Record<Field, unknown>> {
  return { mode: settings?.theme?.mode, light: settings?.theme?.light, dark: settings?.theme?.dark, size: settings?.text_size };
}

/**
 * The fields Skip puts back: each one the card changed, unless config.json now holds a third value (another
 * window changed it since; the card's write may still be on its way, so its own pick or the value before it
 * both count as untouched).
 */
export function tourSkipRestores(changed: ChangedFields, saved: Partial<Record<Field, unknown>>): Partial<Fields> {
  const out: Partial<Fields> = {};
  for (const field of Object.keys(changed) as Field[]) {
    const c = changed[field]!;
    // Changed and changed back: nothing to put back.
    if (c.before === c.wrote) continue;
    const now = saved[field];
    if (now !== undefined && now !== c.before && now !== c.wrote) continue;
    (out as Record<Field, unknown>)[field] = c.before;
  }
  return out;
}

export interface TourSettingsHandle {
  /** Skip: put back what the card itself changed, each to its value just before (never a whole snapshot). */
  restore: () => Promise<void>;
}

export const TourSettings = forwardRef<TourSettingsHandle, { onSettings: () => void }>(function TourSettings({ onSettings }, ref) {
  const theme = useInboxTheme();
  const palettes = useInboxPalettes();
  const size = useInboxTextSize();
  const changed = useRef<ChangedFields>({});
  const now = useRef({ theme, palettes, size });
  now.current = { theme, palettes, size };
  /** The card changes `field` from `before` to `to`: the first change keeps `before`, every change keeps `to`. */
  const note = <K extends Field>(field: K, before: Fields[K], to: Fields[K]) => {
    const c = (changed.current[field] ??= { before, wrote: to } as ChangedFields[K]) as Changed<K>;
    c.wrote = to;
  };
  useImperativeHandle(
    ref,
    () => ({
      restore: async () => {
        const mine = { ...changed.current };
        changed.current = {};
        if (Object.keys(mine).length === 0) return;
        const { theme: t, palettes: p } = now.current;
        const saved = savedFields(await inboxApi.settings().catch(() => null));
        const back = tourSkipRestores(mine, saved);
        if (back.mode !== undefined) t.choose(back.mode);
        if (back.light !== undefined) p.choose('light', back.light);
        if (back.dark !== undefined) p.choose('dark', back.dark);
        if (back.size !== undefined) await chooseTextSize(back.size);
      },
    }),
    [],
  );
  const shown = theme.shown;
  const more = tourMoreColorSets();
  const sets = TOUR_COLOR_SETS.map((id) => BUILT_IN_THEMES.find((t) => t.id === id)).filter((t): t is ThemeInfo => !!t);
  return (
    <div className="ib-tset" data-tour-settings="">
      <div className="ib-tset-grp">
        <span className="ib-tset-l" id="ib-tset-theme">
          Theme
        </span>
        <div className="ib-tset-tiles" role="radiogroup" aria-labelledby="ib-tset-theme">
          {MODES.map((choice) => {
            const on = theme.mode === choice.id;
            return (
              <label key={choice.id} className="ib-tset-tile ib-tset-mode" data-on={on ? '' : undefined} data-tour-mode={choice.id}>
                <input
                  type="radio"
                  name="ib-tset-mode"
                  value={choice.id}
                  checked={on}
                  onChange={() => {
                    note('mode', theme.mode, choice.id);
                    theme.choose(choice.id);
                  }}
                />
                {choice.id === 'system' ? (
                  <span className="ib-tset-split" aria-hidden="true">
                    <MiniWindow colors={colorsOf(palettes.pair.light, 'light')} />
                    <MiniWindow colors={colorsOf(palettes.pair.dark, 'dark')} />
                  </span>
                ) : (
                  <span className="ib-tset-pic" aria-hidden="true">
                    <MiniWindow colors={colorsOf(palettes.pair[choice.id as ThemeHalf], choice.id as ThemeHalf)} />
                  </span>
                )}
                <span className="ib-tset-cap">
                  <Icon name={choice.icon} size={13} />
                  <span>{choice.label}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="ib-tset-grp">
        <span className="ib-tset-l" id="ib-tset-colors">
          Colors
        </span>
        <div className="ib-tset-tiles" role="radiogroup" aria-labelledby="ib-tset-colors">
          {sets.map((set) => {
            const on = palettes.pair[shown] === set.id;
            return (
              <label key={set.id} className="ib-tset-tile ib-tset-pal" data-on={on ? '' : undefined} data-tour-palette={set.id}>
                <input
                  type="radio"
                  name="ib-tset-palette"
                  value={set.id}
                  checked={on}
                  aria-label={set.name}
                  onChange={() => {
                    // Both halves: one POST of { light, dark } (theme.ts batches the marks).
                    note('light', palettes.pair.light, set.id);
                    note('dark', palettes.pair.dark, set.id);
                    palettes.choose('light', set.id);
                    palettes.choose('dark', set.id);
                  }}
                />
                <span className="ib-pal-sw" aria-hidden="true">
                  {paletteSwatchColors(set, shown).map((color, i) => (
                    <span key={i} style={{ backgroundColor: color }} />
                  ))}
                </span>
                <span className="ib-tset-cap" aria-hidden="true">
                  <span>{shortName(set)}</span>
                </span>
                {on && <Icon name="check" size={13} className="ib-tset-ck" />}
              </label>
            );
          })}
        </div>
        <p className="ib-tset-more" data-tour-more-colors={more}>
          {more > 0 ? `${more} more in ` : 'More in '}
          <a
            href="#settings/general"
            data-tour-settings-link=""
            onClick={(event) => {
              event.preventDefault();
              onSettings();
            }}
          >
            Settings
          </a>
        </p>
      </div>
      <div className="ib-tset-grp ib-tset-row">
        <span className="ib-tset-l" id="ib-tset-size">
          Text size
        </span>
        <span className="ib-seg" role="radiogroup" aria-labelledby="ib-tset-size">
          {INBOX_TEXT_SIZES.map((n) => (
            <label key={n} className="ib-seg-o" data-on={size === n ? '' : undefined}>
              <input
                type="radio"
                name="ib-tset-size"
                value={n}
                checked={size === n}
                aria-label={`${n} px`}
                onChange={() => {
                  note('size', size, n);
                  void chooseTextSize(n);
                }}
              />
              {n}
            </label>
          ))}
        </span>
      </div>
    </div>
  );
});
