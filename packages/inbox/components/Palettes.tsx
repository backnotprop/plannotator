/**
 * Settings → General → Appearance → Colors: the palette for the light half
 * and the dark half, the same choices plan review's Theme tab offers
 * (@plannotator/ui's useThemePaletteHalves, over the palette registry, so a palette
 * added there shows here by itself). A pick applies at once, is kept in the
 * `plannotator-theme` cookie, and only that half goes to config.json `theme`
 * (useInboxPalettes in theme.ts), so plan review opens on it too.
 *
 * A tab list picks which half ("Light half" / "Dark half", starting on the one
 * on screen; ← → / Home / End move and select, one tab stop), and each tab
 * controls the tile list: that half's palettes as a native radio group
 * ("Palettes for the light half"): one tab stop, the arrows step the pick
 * through the list (onTileKey, so the order is the list's in every browser),
 * and Tab leaves the group. The row's "Colors" label names the tab list; no two controls share a
 * name. No new shortcut.
 */

import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { paletteSwatchColors } from '@plannotator/ui/components/ThemeTab';
import type { ThemeHalf } from '@plannotator/ui/utils/themeRegistry';
import { Icon } from '../icons';
import { useInboxPalettes } from '../theme';

const HALVES: { id: ThemeHalf; label: string; icon: 'sun' | 'moon' }[] = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
];

const PALETTE_LIST_ID = 'ib-palette-list';

export function PaletteRow() {
  const { half, setHalf, pair, themes, nameOf, choose, shown } = useInboxPalettes();
  const box = useRef<HTMLDivElement>(null);
  // The chosen palette in view inside the tiles' own box (on a desktop it scrolls), never scrolling the page.
  useLayoutEffect(() => {
    const el = box.current;
    const on = el?.querySelector<HTMLElement>('.ib-pal[data-on]');
    if (!el || !on || el.scrollHeight <= el.clientHeight) return;
    // The box is the tiles' offset parent (position: relative), so offsetTop is inside it.
    const top = on.offsetTop;
    if (top < el.scrollTop || top + on.offsetHeight > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - (el.clientHeight - on.offsetHeight) / 2);
    }
  }, [half, pair[half]]);
  // The tab list's keys (automatic activation): the arrows, Home and End select the other half and focus it.
  const onTabKey = (event: KeyboardEvent<HTMLElement>) => {
    const index = HALVES.findIndex((choice) => choice.id === half);
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (index + 1) % HALVES.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (index - 1 + HALVES.length) % HALVES.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? HALVES.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const id = HALVES[next]!.id;
    setHalf(id);
    document.getElementById(`ib-palette-tab-${id}`)?.focus();
  };
  // The tiles' keys: the arrows step through the palettes in order (wrapping), Home and End go to the ends, each a pick,
  // as native radios do. Handled here so the step is the list's order in every browser, never twice.
  const onTileKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = themes.findIndex((theme) => theme.id === pair[half]);
    const last = themes.length - 1;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? index < 0 || index === last ? 0 : index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index <= 0 ? last : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1;
    if (next < 0 || last < 0) return;
    event.preventDefault();
    const id = themes[next]!.id;
    choose(half, id);
    box.current?.querySelector<HTMLInputElement>(`.ib-pal[data-palette="${id}"] input`)?.focus();
  };
  return (
    <div className="ib-palrow" data-settings-palettes={half}>
      <div className="ib-prow ib-palhead">
        <span className="ib-txt">
          <span className="ib-l" id="ib-colors-label">
            Colors
          </span>
          <span className="ib-desc" data-palette-summary="">
            Light: {nameOf(pair.light)} · Dark: {nameOf(pair.dark)}. {shown === half ? 'On screen now.' : `Shows when the Inbox is ${half}.`}
          </span>
        </span>
        <span className="ib-ctl">
          <span className="ib-seg" role="tablist" aria-labelledby="ib-colors-label" onKeyDown={onTabKey}>
            {HALVES.map((choice) => {
              const on = half === choice.id;
              return (
                <button
                  key={choice.id}
                  type="button"
                  role="tab"
                  id={`ib-palette-tab-${choice.id}`}
                  className="ib-seg-o"
                  data-on={on ? '' : undefined}
                  data-half={choice.id}
                  aria-selected={on}
                  aria-controls={PALETTE_LIST_ID}
                  aria-label={`${choice.label} half`}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setHalf(choice.id)}
                >
                  <Icon name={choice.icon} size={14} />
                  {choice.label}
                </button>
              );
            })}
          </span>
        </span>
      </div>
      <div
        ref={box}
        id={PALETTE_LIST_ID}
        className="ib-pals"
        role="radiogroup"
        aria-label={`Palettes for the ${half} half`}
        data-palette-half={half}
        onKeyDown={onTileKey}
      >
        {themes.map((theme) => {
          const on = pair[half] === theme.id;
          return (
            <label key={theme.id} className="ib-pal" data-on={on ? '' : undefined} data-palette={theme.id}>
              <input type="radio" name={`ib-palette-${half}`} value={theme.id} checked={on} onChange={() => choose(half, theme.id)} />
              <span className="ib-pal-sw" aria-hidden="true">
                {paletteSwatchColors(theme, half).map((color, i) => (
                  <span key={i} style={{ backgroundColor: color }} />
                ))}
              </span>
              <span className="ib-pal-n">{theme.name}</span>
              {on && <Icon name="check" size={14} className="ib-pal-ck" />}
            </label>
          );
        })}
      </div>
    </div>
  );
}
