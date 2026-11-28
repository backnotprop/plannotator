import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { swarmEscapeIsOurs } from './escape';

/**
 * Who the ghost box writes to: "to everyone", or one member picked from a small list. Drawn as the reply's recipient
 * chip and its list are (ReplyRecipient.tsx: `.ib-rto-chip`, its list's shape in `.ib-ghost-tolist`), with the members' names only:
 * a press on a row picks it, Escape or a press outside closes the list.
 */
export function GhostTo({ members, to, onTo }: { members: readonly string[]; to: string | null; onTo: (to: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !swarmEscapeIsOurs(event, wrap.current)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', press, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  const name = to ?? 'everyone';
  const pick = (next: string | null) => {
    onTo(next);
    setOpen(false);
  };
  const rows: { key: string; value: string | null; words: string }[] = [{ key: '', value: null, words: 'everyone' }, ...members.map((m) => ({ key: m, value: m, words: m }))];
  return (
    <span ref={wrap} className="ib-ghost-towrap">
      <button type="button" className="ib-rto-chip ib-ghost-to" aria-expanded={open} aria-label={`To ${name}. Change who gets this`} onClick={() => setOpen((was) => !was)} data-ghost-to={to ?? ''}>
        <span className="ib-rto-l">to</span>
        <span className="ib-rto-n">
          <bdi>{name}</bdi>
        </span>
        <svg className="ib-rto-c" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="ib-tg-menu ib-ghost-tolist" role="group" aria-label="Who gets this" data-ghost-to-list="">
          {rows.map((row) => {
            const on = row.value === to;
            return (
              <div key={row.key} className="ib-rpick-row" data-on={on ? '' : undefined} data-ghost-to-row={row.key}>
                <button type="button" className="ib-rpick-name" onClick={() => pick(row.value)}>
                  <span className="ib-rpick-l" dir="auto">
                    {row.words}
                  </span>
                </button>
                <button type="button" role="checkbox" aria-checked={on} aria-hidden="true" tabIndex={-1} className="ib-rpick-tick" onClick={() => pick(row.value)}>
                  <span>
                    <Icon name="check" size={12} />
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
