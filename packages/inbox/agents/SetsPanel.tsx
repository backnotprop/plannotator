import { Popover } from '@base-ui/react/popover';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { tooltipContainerOf } from '@plannotator/ui/components/HostTitle';
import type { InboxIconSet, InboxIconSetIcon } from '@plannotator/core/inbox-types';
import { keepAgentFace, type AgentFaceRef } from './agentFaces';
import type { AgentFace } from './faceChoices';
import { SETS_LABEL } from './FaceFan';
import { getIconSet, isSetFace, setArtStyle, readIconSets, refreshFetchable, setCreditsHref, setFaceParts, setIconSrc, setLookOf, useIconSets, useSetListing } from './iconSets';

/** The set last looked at in this page: the panel opens on it again. */
let lastSet: string | null = null;

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
 * "Sets" (the face picker's place after "Your own…"): the icon sets, then a numbered grid of the chosen one with a
 * search by name or number, the Pokédex feel. Choosing an icon shows it on this agent at once, in every window
 * (`set:<set>/<icon>` in the faces). A fetchable set shows "Get" until it is downloaded; its icons then fill in as
 * they arrive. Icons load only as they scroll into view.
 *
 * Its keys are the panel's own while it is open (the arrows move in the grid, Enter picks, Escape closes): it adds no
 * shortcut. The one credit a set's licence asks for (game-icons.net's) is a muted line under its grid.
 */
export function SetsPanel({ anchor, open, agent, name, face, touch, onClose }: { anchor: HTMLElement; open: boolean; agent: AgentFaceRef; name: string; face: AgentFace; touch: boolean; onClose: () => void }) {
  const sets = useIconSets();
  // The pointer of fetchable sets is read only here, when the person opens Sets.
  useEffect(() => {
    if (open) void readIconSets(true);
  }, [open]);
  const current = isSetFace(face) ? setFaceParts(face) : null;
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setQuery('');
  }, [open]);
  const setId = picked ?? current?.set ?? lastSet ?? sets?.[0]?.id ?? null;
  const set: InboxIconSet | null = sets?.find((s) => s.id === setId) ?? sets?.[0] ?? null;
  const fetchable = set?.kind === 'fetchable';
  const state = set?.get?.state ?? 'done';
  const listing = useSetListing(set && (!fetchable || state !== 'none') ? set.id : null);

  // While a set fills in: read it again, twice a second, as long as the panel shows it.
  useEffect(() => {
    if (!open || !set || state !== 'getting') return;
    const timer = setInterval(() => void refreshFetchable(set.id), 500);
    return () => clearInterval(timer);
  }, [open, set?.id, state]); // eslint-disable-line react-hooks/exhaustive-deps

  const icons = listing?.icons ?? [];
  const found = useMemo(() => searchSetIcons(icons, query), [icons, query]);
  const have = useMemo(() => (fetchable ? new Set(listing?.have ?? []) : null), [fetchable, listing]);

  // Icons load as they scroll into view (an image's address or a mask is set only then), watched in the grid's own
  // scroll box; the watcher goes when the panel closes.
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
  useEffect(() => {
    if (open) return;
    watcher.current?.disconnect();
    watcher.current = null;
  }, [open]);
  useEffect(() => () => watcher.current?.disconnect(), []);

  const choose = (icon: InboxIconSetIcon) => {
    if (!set) return;
    lastSet = set.id;
    keepAgentFace(agent, `set:${set.id}/${icon.id}`);
    onClose();
  };
  const columns = touch ? 6 : 8;
  const onGridKey = (event: KeyboardEvent) => {
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
  const container = tooltipContainerOf(anchor) ?? anchor.closest<HTMLElement>('.pn-inbox') ?? undefined;
  const input = useRef<HTMLInputElement>(null);
  return (
    <Popover.Root open={open} onOpenChange={(next) => !next && onClose()} modal={false}>
      <Popover.Portal container={container}>
        <Popover.Positioner className="am-sets-pos" anchor={anchor} side="right" align="start" sideOffset={10} collisionPadding={8}>
          <Popover.Popup className="am-sets" aria-label={`${SETS_LABEL} ${name}`} data-touch={touch ? '' : undefined} initialFocus={touch ? false : input} finalFocus={{ current: anchor }}>
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
                    lastSet = s.id;
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
                        key={`${icon.id}:${here ? 1 : 0}`}
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
                          {look?.mono ? <span className="am-sets-mono" /> : <img alt="" draggable={false} decoding="async" />}
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
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** An icon cell come into view: its image's address, or its mask. */
function reveal(el: HTMLElement): void {
  const src = el.dataset.src;
  if (!src) return;
  if (el.dataset.mono !== undefined) el.style.setProperty('--set-src', `url("${src}")`);
  else el.querySelector('img')?.setAttribute('src', src);
}
