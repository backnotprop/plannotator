import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';
import { EMOJI, type EmojiRow } from './emojiData';
import { Icon } from '../icons';
import { recentEmoji } from '../reactions';

const COLS = 8;

const byEmoji = new Map<string, EmojiRow>();
for (const cat of EMOJI) for (const row of cat.emoji) if (!byEmoji.has(row[0])) byEmoji.set(row[0], row);
export function emojiRow(emoji: string): EmojiRow {
  return byEmoji.get(emoji) ?? [emoji, 'emoji', ''];
}

function score(row: EmojiRow, words: string[]): number {
  const name = row[1].split(/[\s-]+/);
  const extra = row[2].split(/[\s-]+/);
  if (!words.every((w) => name.some((t) => t.startsWith(w)) || extra.some((t) => t.startsWith(w)))) return -1;
  if (row[1].startsWith(words.join(' '))) return 0;
  return words.every((w) => name.some((t) => t.startsWith(w))) ? 1 : 2;
}

interface Section {
  id: string;
  label: string;
  rows: EmojiRow[];
}

export interface EmojiPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: RefObject<HTMLElement | null>;
  container?: HTMLElement | null;
  returnTo?: RefObject<HTMLElement | null> | (() => HTMLElement | boolean | null);
  onPick: (row: EmojiRow) => void;
  phone: boolean;
  says: (row: EmojiRow) => ReactNode;
  idle: string;
  label: string;
}

export function EmojiPicker({ open, onOpenChange, anchor, container, returnTo, onPick, phone, says, idle, label }: EmojiPickerProps) {
  return (
    <Popover.Root open={open} onOpenChange={(next) => onOpenChange(next)} modal={false}>
      <Popover.Portal container={container ?? undefined}>
        <Popover.Positioner className="ib-emo-pos" data-phone={phone ? '' : undefined} anchor={anchor} side="top" align="start" sideOffset={10} alignOffset={-6} collisionPadding={12}>
          <Popover.Popup className="ib-emo" aria-label={label} initialFocus={phone ? false : undefined} finalFocus={returnTo ?? true}>
            {open && <PickerBody onPick={onPick} phone={phone} says={says} idle={idle} onClose={() => onOpenChange(false)} />}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PickerBody({ onPick, phone, says, idle, onClose }: { onPick: (row: EmojiRow) => void; phone: boolean; says: (row: EmojiRow) => ReactNode; idle: string; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [grid, setGrid] = useState(false);
  const [cat, setCat] = useState<string>('');
  const body = useRef<HTMLDivElement>(null);
  const recent = useMemo(() => recentEmoji().map(emojiRow), []);

  const sections: Section[] = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      const seen = new Set<string>();
      const found: [EmojiRow, number][] = [];
      for (const c of EMOJI)
        for (const r of c.emoji) {
          if (seen.has(r[0])) continue;
          const n = score(r, words);
          if (n >= 0) {
            seen.add(r[0]);
            found.push([r, n]);
          }
        }
      const rows = found.sort((a, b) => a[1] - b[1]).map(([r]) => r);
      return [{ id: 'results', label: rows.length ? 'Results' : '', rows }];
    }
    return [...(recent.length ? [{ id: 'recent', label: 'Recent', rows: recent }] : []), ...EMOJI.map((c) => ({ id: c.id, label: c.label, rows: c.emoji }))];
  }, [query, recent]);
  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const starts = useMemo(() => {
    const out: number[] = [];
    let n = 0;
    for (const s of sections) {
      out.push(n);
      n += s.rows.length;
    }
    return out;
  }, [sections]);
  const shown = flat[active] ?? (query ? flat[0] : undefined) ?? null;

  useEffect(() => {
    setActive(query ? 0 : -1);
    setGrid(false);
    body.current?.scrollTo?.({ top: 0 });
  }, [query]);
  const byKeys = useRef(false);
  useEffect(() => {
    if (active < 0 || !byKeys.current) return;
    byKeys.current = false;
    body.current?.querySelector(`[data-emo-i="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const step = (dir: 'left' | 'right' | 'up' | 'down') => {
    if (!flat.length) return;
    if (active < 0) return setActive(0);
    if (dir === 'left') return setActive(Math.max(0, active - 1));
    if (dir === 'right') return setActive(Math.min(flat.length - 1, active + 1));
    let si = 0;
    while (si + 1 < starts.length && starts[si + 1]! <= active) si++;
    const col = (active - starts[si]!) % COLS;
    const rowStart = active - col;
    const secEnd = starts[si]! + sections[si]!.rows.length;
    if (dir === 'down') {
      if (rowStart + COLS < secEnd) return setActive(Math.min(rowStart + COLS + col, secEnd - 1));
      if (si + 1 < sections.length) return setActive(Math.min(starts[si + 1]! + col, starts[si + 1]! + sections[si + 1]!.rows.length - 1));
      return;
    }
    if (rowStart > starts[si]!) return setActive(rowStart - COLS + col);
    if (si === 0) {
      setActive(-1);
      setGrid(false);
      return;
    }
    si -= 1;
    const len = sections[si]!.rows.length;
    const lastRow = starts[si]! + Math.floor((len - 1) / COLS) * COLS;
    setActive(Math.min(lastRow + col, starts[si]! + len - 1));
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key.startsWith('Arrow')) byKeys.current = true;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setGrid(true);
      step('down');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      step('up');
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && grid) {
      e.preventDefault();
      step(e.key === 'ArrowLeft' ? 'left' : 'right');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown) onPick(shown);
    }
  };

  const jump = (id: string) => {
    const el = body.current?.querySelector<HTMLElement>(`[data-emo-sec="${id}"]`);
    if (el && body.current) body.current.scrollTo?.({ top: el.offsetTop - 4, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setCat(id);
  };
  const onScroll = () => {
    const b = body.current;
    if (!b || query) return;
    let current = '';
    for (const el of b.querySelectorAll<HTMLElement>('[data-emo-sec]')) if (el.offsetTop - 8 <= b.scrollTop) current = el.dataset.emoSec!;
    setCat(current || sections[0]?.id || '');
  };
  const activeId = active >= 0 ? `ib-emo-${active}` : undefined;
  const tabs = [...(recent.length ? [{ id: 'recent', glyph: null as string | null, label: 'Recent' }] : []), ...EMOJI.map((c) => ({ id: c.id, glyph: c.emoji[0]![0], label: c.label }))];
  const current = cat || sections[0]?.id;

  let i = 0;
  return (
    <div className="ib-emo-in" data-emoji-picker="">
      <div className="ib-emo-search">
        <Icon name="search" size={14} />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="ib-emo-list"
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label="Search emoji"
          placeholder="Search emoji"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          data-emo-search=""
        />
      </div>
      {!query && (
        <div className="ib-emo-tabs" role="toolbar" aria-label="Emoji categories">
          {tabs.map((t) => (
            <button key={t.id} type="button" className="ib-emo-tab" aria-label={t.label} aria-current={current === t.id ? 'true' : undefined} onClick={() => jump(t.id)} data-emo-tab={t.id}>
              {t.glyph ? <span aria-hidden="true">{t.glyph}</span> : <Icon name="clock" size={14} />}
            </button>
          ))}
        </div>
      )}
      <div className="ib-emo-body" ref={body} onScroll={onScroll} id="ib-emo-list" role="listbox" aria-label="Emoji">
        {sections.map((s) => (
          <div key={s.id} role="group" aria-label={s.label || 'Results'} data-emo-sec={s.id}>
            {s.label && (
              <div className="ib-emo-h" aria-hidden="true">
                {s.label}
              </div>
            )}
            {s.rows.length === 0 && <p className="ib-emo-none">No emoji match “{query}”.</p>}
            <div className="ib-emo-grid">
              {s.rows.map((r) => {
                const n = i++;
                return (
                  <span
                    key={`${s.id}-${r[0]}`}
                    id={`ib-emo-${n}`}
                    role="option"
                    aria-selected={n === active}
                    aria-label={r[1]}
                    className="ib-emo-cell"
                    data-emo-i={n}
                    data-emo={r[0]}
                    data-active={n === active ? '' : undefined}
                    onPointerMove={(e) => e.pointerType === 'mouse' && n !== active && setActive(n)}
                    onClick={() => onPick(r)}
                  >
                    {r[0]}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="ib-emo-foot" aria-live="off">
        {shown ? (
          <>
            <span className="ib-emo-big" aria-hidden="true">
              {shown[0]}
            </span>
            <span className="ib-emo-say">
              <b>{shown[1].replace(/^./, (c) => c.toUpperCase())}</b>
              <span>{says(shown)}</span>
            </span>
          </>
        ) : (
          <span className="ib-emo-say ib-emo-hint">
            <b>Any emoji</b>
            <span>{idle}</span>
          </span>
        )}
        {phone && (
          <button type="button" className="ib-emo-close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
