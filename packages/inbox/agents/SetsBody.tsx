import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { InboxIconSet, InboxIconSetIcon } from '@plannotator/core/inbox-types';
import { keepAgentFace, type AgentFaceRef } from './agentFaces';
import type { AgentFace } from './faceChoices';
import { SETS_LABEL } from './FaceFan';
import { getIconSet, isSetFace, setArtStyle, readIconSets, refreshFetchable, setCreditsHref, setFaceParts, setIconSrc, setLookOf, useIconSets, useSetListing } from './iconSets';

/** The set last looked at, kept by this browser: Sets opens on it again, after a reload too. */
export const LAST_SET_KEY = 'plannotator-inbox-icon-set-last';

function readLastSet(): string | null {
  try {
    return window.localStorage.getItem(LAST_SET_KEY);
  } catch {
    return null;
  }
}

function keepLastSet(id: string): void {
  try {
    window.localStorage.setItem(LAST_SET_KEY, id);
  } catch {
    // Storage refused: not kept.
  }
}

/** "#007", or "#0025" in a set of a thousand or more. */
export const setNumber = (n: number, count: number) => `#${String(n).padStart(count >= 1000 ? 4 : 3, '0')}`;

/** The icons a search keeps: a number ("27", "#027") finds that icon; words find names and search words. */
export function searchSetIcons(icons: readonly InboxIconSetIcon[], query: string): readonly InboxIconSetIcon[] {
  const q = query.trim().toLowerCase();
  if (!q) return icons;
  const number = /^#?0*(\d+)$/.exec(q);
  const n = number ? Number(number[1]) : null;
  const text = q.replace(/^#/, '');
  return icons.filter((icon) => icon.n === n || (!number && (icon.name.toLowerCase().includes(text) || !!icon.words?.some((word) => word.startsWith(text)))));
}

/** "CC-BY-3.0" → "CC BY 3.0". */
const licenceLabel = (spdx: string | undefined) => (spdx ? spdx.replace(/-(\d+\.\d+)$/, ' $1').replace(/-/g, ' ') : '');

/**
 * "Sets" in the agent icon dialog (AgentIconDialog.tsx): the icon sets, then a numbered grid of the chosen one with a
 * search by name or number, the Pokédex feel. Choosing an icon shows it on this agent at once, in every window
 * (`set:<set>/<icon>` in the faces). A fetchable set shows "Get" until it is downloaded; its icons then fill in as
 * they arrive. Icons load only as they scroll into view.
 *
 * Its keys are the dialog's own (the arrows move in the grid, Enter in the search picks the first found): it adds no
 * shortcut. Choosing an icon closes the dialog (`onDone`). The one credit a set's licence asks for (game-icons.net's) is a muted line under its grid.
 */
export function SetsBody({ agent, face, onDone }: { agent: AgentFaceRef; face: AgentFace; onDone: () => void }) {
  const sets = useIconSets();
  // The pointer of fetchable sets is read only here, when the person opens Sets.
  useEffect(() => {
    void readIconSets(true);
  }, []);
  const current = isSetFace(face) ? setFaceParts(face) : null;
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [lastSet] = useState(readLastSet);
  const setId = picked ?? current?.set ?? lastSet ?? sets?.[0]?.id ?? null;
  const set: InboxIconSet | null = sets?.find((s) => s.id === setId) ?? sets?.[0] ?? null;
  const fetchable = set?.kind === 'fetchable';
  const state = set?.get?.state ?? 'done';
  const listing = useSetListing(set && (!fetchable || state !== 'none') ? set.id : null);

  // While a set fills in: read it again, twice a second, as long as the dialog shows it.
  useEffect(() => {
    if (!set || state !== 'getting') return;
    const timer = setInterval(() => void refreshFetchable(set.id), 500);
    return () => clearInterval(timer);
  }, [set?.id, state]); // eslint-disable-line react-hooks/exhaustive-deps

  const icons = listing?.icons ?? [];
  const found = useMemo(() => searchSetIcons(icons, query), [icons, query]);
  const have = useMemo(() => (fetchable ? new Set(listing?.have ?? []) : null), [fetchable, listing]);

  // Icons load as they scroll into view (an image's address or a mask is set only then), watched in the grid's own
  // scroll box; the watcher goes with the dialog.
  const scroller = useRef<HTMLDivElement>(null);
  const watcher = useRef<IntersectionObserver | null>(null);
  const lazy = useCallback((el: HTMLElement | null) => {
    if (!el || !el.dataset.src) return;
    if (typeof IntersectionObserver === 'undefined') {
      reveal(el);
      return;
    }
    watcher.current ??= new IntersectionObserver(
      (entries, watch) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          reveal(entry.target as HTMLElement);
          watch.unobserve(entry.target);
        }
      },
      { root: el.closest('.am-sets-scroll'), rootMargin: '120px 0px' },
    );
    watcher.current.observe(el);
  }, []);
  useEffect(() => () => watcher.current?.disconnect(), []);

  const choose = (icon: InboxIconSetIcon) => {
    if (!set) return;
    keepLastSet(set.id);
    keepAgentFace(agent, `set:${set.id}/${icon.id}`);
    onDone();
  };
  const onGridKey = (event: KeyboardEvent) => {
    // The grid's own column count (it fills the dialog's width).
    const columns = Math.max(1, getComputedStyle(event.currentTarget).gridTemplateColumns.split(' ').filter(Boolean).length);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
    if (!step) return;
    const cells = [...(scroller.current?.querySelectorAll<HTMLButtonElement>('.am-sets-i:not(:disabled)') ?? [])];
    const at = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    cells[Math.max(0, Math.min(cells.length - 1, at + step))]?.focus();
  };
  const onSearchKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      scroller.current?.querySelector<HTMLButtonElement>('.am-sets-i:not(:disabled)')?.focus();
    } else if (event.key === 'Enter') {
      const first = found.find((icon) => !have || have.has(icon.id));
      if (first) {
        event.preventDefault();
        choose(first);
      }
    }
  };

  const look = set ? setLookOf(set.id) : null;
  const count = set?.count ?? 0;
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="am-sets ib-agi-sets">
      <input
        ref={input}
        className="am-sets-q"
        type="search"
        placeholder="Search by name or number"
        aria-label="Search by name or number"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onSearchKey}
        autoComplete="off"
        spellCheck={false}
      />
      <div className="am-sets-tabs" role="tablist" aria-label={SETS_LABEL}>
        {(sets ?? []).map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            className="am-sets-tab"
            aria-selected={s.id === set?.id}
            data-set={s.id}
            onClick={() => {
              keepLastSet(s.id);
              setPicked(s.id);
              scroller.current?.scrollTo({ top: 0 });
            }}
          >
            {s.name}
          </button>
        ))}
      </div>
      {set && (
        <div className="am-sets-head">
          <span>{set.name}</span>
          <span>{query.trim() ? `${found.length} found` : count.toLocaleString('en-US')}</span>
        </div>
      )}
      {set && fetchable && state !== 'done' && (
        <div className="am-sets-get" data-state={state}>
          {state === 'getting' ? (
            <span className="am-sets-bar" aria-hidden="true">
              <i style={{ width: `${count ? Math.round(((set.get?.have ?? 0) / count) * 100) : 0}%` }} />
            </span>
          ) : (
            <button type="button" className="am-sets-getb" data-get={set.id} onClick={() => void getIconSet(set.id)}>
              Get
            </button>
          )}
          <span role="status">{state === 'none' ? `${count.toLocaleString('en-US')} icons` : `${(set.get?.have ?? 0).toLocaleString('en-US')} of ${count.toLocaleString('en-US')}`}</span>
        </div>
      )}
      <div className="am-sets-scroll" ref={scroller}>
        <div className="am-sets-g" role="radiogroup" aria-label={set?.name ?? SETS_LABEL} onKeyDown={onGridKey}>
          {set &&
            found.map((icon) => {
              const here = !have || have.has(icon.id);
              const src = here ? setIconSrc(set.id, icon.id) : undefined;
              const number = setNumber(icon.n, count);
              return (
                <button
                  key={`${set.id}/${icon.id}:${here ? 1 : 0}`}
                  type="button"
                  role="radio"
                  aria-checked={current?.set === set.id && current.icon === icon.id}
                  aria-label={`${icon.name}, ${number}`}
                  title={`${icon.name} ${number}`}
                  className="am-sets-i"
                  data-set-icon={icon.id}
                  data-missing={here ? undefined : ''}
                  disabled={!here}
                  onClick={() => choose(icon)}
                >
                  <span ref={lazy} className="am-sets-art" data-src={src} data-pixel={look?.pixelated ? '' : undefined} data-mono={look?.mono ? '' : undefined} style={setArtStyle(look, null) as CSSProperties}>
                    {look?.mono ? <span className="am-sets-mono" /> : <img alt="" draggable={false} decoding="async" onLoad={(event) => event.currentTarget.parentElement?.setAttribute('data-loaded', '')} onError={(event) => askAgain(event.currentTarget)} />}
                  </span>
                  <span className="am-sets-n">{number}</span>
                </button>
              );
            })}
        </div>
      </div>
      {set?.credits && (
        <div className="am-sets-credit">
          Icons by {set.name} authors · {licenceLabel(set.licence)} ·{' '}
          <a href={setCreditsHref(set.id)} target="_blank" rel="noopener noreferrer">
            Credits
          </a>
        </div>
      )}
    </div>
  );
}

/** An icon cell come into view: its image's address, or its mask. */
function reveal(el: HTMLElement): void {
  const src = el.dataset.src;
  if (!src) return;
  if (el.dataset.mono !== undefined) el.style.setProperty('--set-src', `url("${src}")`);
  else el.querySelector('img')?.setAttribute('src', src);
}

/** When an icon that did not load is asked for again: the link back, else after 2, 8 and 30 s. */
const ICON_RETRY_MS = [2_000, 8_000, 30_000];

/**
 * An icon in the grid that did not load (a dropped link, a request that failed): hidden behind its faint tile, never
 * the browser's broken picture, and asked for again (the link back, else after a while), a few times at most.
 */
function askAgain(img: HTMLImageElement): void {
  img.dataset.failed = '';
  const tries = Number(img.dataset.tries ?? 0);
  if (tries >= ICON_RETRY_MS.length) return;
  img.dataset.tries = String(tries + 1);
  const src = img.getAttribute('src');
  if (!src) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const again = () => {
    clearTimeout(timer);
    window.removeEventListener('online', again);
    if (!img.isConnected) return;
    delete img.dataset.failed;
    img.removeAttribute('src');
    img.setAttribute('src', src);
  };
  timer = setTimeout(again, ICON_RETRY_MS[tries]);
  window.addEventListener('online', again);
}
