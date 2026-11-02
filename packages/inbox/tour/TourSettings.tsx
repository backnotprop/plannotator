/**
 * The tour's "Make it yours" card (step 10 of 11; the owner, 2026-11-02): the
 * theme, three colour sets and the text size, drawn over the tour's Inbox so
 * a pick shows at once on a full window. Every control writes through the
 * same hooks as Settings → General → Appearance (theme.ts, textSize.ts), so
 * nothing here has storage of its own: the `plannotator-theme` cookie and
 * config.json `theme`, and config.json `inboxTextSize` with its cookie.
 *
 * What the step opened with is kept, so Skip puts it back (`restore`, through
 * the card's handle); the card's Next ("Connect agents next") keeps what was
 * picked. Under the colour sets, how many more Settings offers (counted from
 * the palette registry), with the link to Settings → General. A colour set is picked for
 * both halves at once (the three offered draw both); Settings still picks a
 * palette per half, and offers every palette. No keyboard shortcut: each
 * control is a native radio group, one tab stop, the arrows move the pick.
 */

import { forwardRef, useImperativeHandle, useRef } from 'react';
import { paletteSwatchColors } from '@plannotator/ui/components/ThemeTab';
import { BUILT_IN_THEMES, type ThemeColors, type ThemeHalf, type ThemeInfo } from '@plannotator/ui/utils/themeRegistry';
import type { Mode } from '@plannotator/ui/theme-modes';
import { INBOX_TEXT_SIZES, type InboxTextSize } from '@plannotator/core/inbox-types';
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

interface Opened {
  mode: Mode;
  light: string;
  dark: string;
  size: InboxTextSize;
}

export interface TourSettingsHandle {
  /** Skip: put back what the step opened with (only what changed is written again). */
  restore: () => void;
}

export const TourSettings = forwardRef<TourSettingsHandle, { onSettings: () => void }>(function TourSettings({ onSettings }, ref) {
  const theme = useInboxTheme();
  const palettes = useInboxPalettes();
  const size = useInboxTextSize();
  const opened = useRef<Opened | null>(null);
  if (!opened.current) opened.current = { mode: theme.mode, light: palettes.pair.light, dark: palettes.pair.dark, size };
  const now = useRef({ theme, palettes, size });
  now.current = { theme, palettes, size };
  useImperativeHandle(
    ref,
    () => ({
      restore: () => {
        const was = opened.current!;
        const { theme: t, palettes: p, size: s } = now.current;
        if (t.mode !== was.mode) t.choose(was.mode);
        if (p.pair.light !== was.light) p.choose('light', was.light);
        if (p.pair.dark !== was.dark) p.choose('dark', was.dark);
        if (s !== was.size) void chooseTextSize(was.size);
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
                <input type="radio" name="ib-tset-mode" value={choice.id} checked={on} onChange={() => theme.choose(choice.id)} />
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
              <input type="radio" name="ib-tset-size" value={n} checked={size === n} aria-label={`${n} px`} onChange={() => void chooseTextSize(n)} />
              {n}
            </label>
          ))}
        </span>
      </div>
    </div>
  );
});
