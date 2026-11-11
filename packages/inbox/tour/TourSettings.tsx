/** Skip restores only what the card changed, each field to its value just before the card first changed it: never a snapshot from the first render, which can precede the first settings read and would write the cookie's or default values over config.json. */

import { forwardRef, useImperativeHandle, useRef } from 'react';
import { paletteSwatchColors } from '@plannotator/ui/components/ThemeTab';
import { BUILT_IN_THEMES, themesForHalf, type ThemeColors, type ThemeHalf, type ThemeInfo } from '@plannotator/ui/utils/themeRegistry';
import type { Mode } from '@plannotator/ui/theme-modes';
import { INBOX_TEXT_SIZES, type InboxTextSize } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { Icon } from '../icons';
import { useInboxPalettes, useInboxTheme } from '../theme';
import { chooseTextSize, useInboxTextSize } from '../textSize';

export const TOUR_COLOR_SETS = ['plannotator', 'plannotator-modern', 'catppuccin'] as const;

export function tourMoreColorSets(half: ThemeHalf, themes: ThemeInfo[] = BUILT_IN_THEMES): number {
  return themesForHalf(themes, half).filter((theme) => !(TOUR_COLOR_SETS as readonly string[]).includes(theme.id)).length;
}

const MODES: { id: Mode; label: string; icon: 'sun' | 'moon' | 'system' }[] = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'system', label: 'Match system', icon: 'system' },
];

const shortName = (theme: ThemeInfo) => (theme.id === 'plannotator' ? theme.name : theme.name.replace(/^Plannotator /, ''));

function colorsOf(id: string, half: ThemeHalf): ThemeColors {
  return (BUILT_IN_THEMES.find((theme) => theme.id === id) ?? BUILT_IN_THEMES[0]!).colors[half];
}

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

interface Changed<K extends Field> {
  before: Fields[K];
  wrote: Fields[K];
}
type ChangedFields = { [K in Field]?: Changed<K> };

function savedFields(settings: { theme?: { mode?: unknown; light?: unknown; dark?: unknown } | null; text_size?: unknown } | null): Partial<Record<Field, unknown>> {
  return { mode: settings?.theme?.mode, light: settings?.theme?.light, dark: settings?.theme?.dark, size: settings?.text_size };
}

export function tourSkipRestores(changed: ChangedFields, saved: Partial<Record<Field, unknown>>): Partial<Fields> {
  const out: Partial<Fields> = {};
  for (const field of Object.keys(changed) as Field[]) {
    const c = changed[field]!;
    if (c.before === c.wrote) continue;
    const now = saved[field];
    if (now !== undefined && now !== c.before && now !== c.wrote) continue;
    (out as Record<Field, unknown>)[field] = c.before;
  }
  return out;
}

export interface TourSettingsHandle {
  restore: () => Promise<void>;
}

export const TourSettings = forwardRef<TourSettingsHandle, { onSettings: () => void; ready?: boolean }>(function TourSettings({ onSettings, ready = true }, ref) {
  const theme = useInboxTheme();
  const palettes = useInboxPalettes();
  const size = useInboxTextSize();
  const changed = useRef<ChangedFields>({});
  const now = useRef({ theme, palettes, size });
  now.current = { theme, palettes, size };
  // Until the first settings read is adopted the window holds the cookie's or the default look, not the person's: the
  // controls wait (a pick then would record a "before" that is not theirs, and Skip would write it over config.json).
  const note = <K extends Field>(field: K, before: Fields[K], to: Fields[K]) => {
    if (!ready) return;
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
  const more = tourMoreColorSets(shown);
  const sets = TOUR_COLOR_SETS.map((id) => BUILT_IN_THEMES.find((t) => t.id === id)).filter((t): t is ThemeInfo => !!t);
  return (
    <div className="ib-tset" data-tour-settings="" data-waiting={ready ? undefined : ''} aria-busy={ready ? undefined : true}>
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
                  disabled={!ready}
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
                  disabled={!ready}
                  value={set.id}
                  checked={on}
                  aria-label={set.name}
                  onChange={() => {
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
                disabled={!ready}
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
