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
  useLayoutEffect(() => {
    const el = box.current;
    const on = el?.querySelector<HTMLElement>('.ib-pal[data-on]');
    if (!el || !on || el.scrollHeight <= el.clientHeight) return;
    const top = on.offsetTop;
    if (top < el.scrollTop || top + on.offsetHeight > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - (el.clientHeight - on.offsetHeight) / 2);
    }
  }, [half, pair[half]]);
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
