import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { InboxListGroupId } from '@plannotator/core/inbox-types';
import type { HeldNews } from '../held';
import type { ListEdge, UnseenRow } from '../showLight';
import { Icon } from '../icons';
import { prefersReducedMotion } from '../settle';

export const LIST_NEW_PILL_STAYS: boolean = true;
export const LIST_NEW_PILL_MS = 5000;
export const LIST_NEW_PILL_FADE_MS = 1800;

const NO_PILL: ReadonlySet<InboxListGroupId> = new Set(['quiet', 'sent']);
const IN_VIEW = 0.6;
const NONE: ReadonlySet<string> = new Set();

type Edge = ListEdge;
interface Where {
  sign: boolean;
  edges: Record<string, Edge>;
}

function landing(body: HTMLElement, lands: InboxListGroupId, order: readonly string[]): { band: Element | null; edge: Edge } {
  if (body.querySelector('[data-flat-list]')) return { band: null, edge: 'top' };
  for (const id of order.slice(Math.max(0, order.indexOf(lands)))) {
    const band = body.querySelector(`.ib-group[data-section-id="${id}"] > .ib-band`);
    if (band) return { band: band.nextElementSibling ?? band, edge: 'top' };
  }
  return { band: null, edge: 'bottom' };
}

function useWhere(body: RefObject<HTMLElement | null>, lands: string, order: string, layout: string): Where | null {
  const [where, setWhere] = useState<Where | null>(null);
  useEffect(() => {
    const root = body.current;
    const sign = root?.querySelector('[data-inbox-notice]');
    if (!root || !sign || lands === '' || typeof IntersectionObserver === 'undefined') {
      setWhere(null);
      return;
    }
    const now: Where = { sign: false, edges: {} };
    const bands = new Map<Element, string[]>();
    for (const group of lands.split(',')) {
      const target = landing(root, group as InboxListGroupId, order.split(','));
      now.edges[group] = target.edge;
      if (target.band) bands.set(target.band, [...(bands.get(target.band) ?? []), group]);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const inView = entry.intersectionRatio >= IN_VIEW;
          if (entry.target === sign) now.sign = inView;
          else for (const group of bands.get(entry.target) ?? []) now.edges[group] = inView || entry.boundingClientRect.top > (entry.rootBounds?.top ?? 0) ? 'bottom' : 'top';
        }
        setWhere({ sign: now.sign, edges: { ...now.edges } });
      },
      { root, threshold: [0, IN_VIEW] },
    );
    observer.observe(sign);
    for (const band of bands.keys()) observer.observe(band);
    return () => observer.disconnect();
  }, [body, lands, order, layout]);
  return where;
}

function usePageShown(): boolean {
  const [shown, setShown] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const read = () => setShown(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, []);
  return shown;
}

export interface ListNewPillProps {
  news: readonly HeldNews[];
  unseen: readonly UnseenRow[];
  body: RefObject<HTMLElement | null>;
  order: readonly InboxListGroupId[];
  layout: string;
  covered: boolean;
  onShow: (edge: Edge) => void;
  onGo: (edge: Edge) => void;
  stays?: boolean;
}

const shownKey = (row: UnseenRow) => `shown ${row.id}`;

export function ListNewPill({ news, unseen, body, order, layout, covered, onShow, onGo, stays = LIST_NEW_PILL_STAYS }: ListNewPillProps) {
  const loud = news.filter((item) => !NO_PILL.has(item.lands));
  const [seen, setSeen] = useState(NONE);
  const fresh = loud.filter((item) => !seen.has(item.key));
  const where = useWhere(body, [...new Set(fresh.map((item) => item.lands))].join(','), order.join(','), layout);
  const watching = usePageShown() && !covered;
  const held = watching && fresh.length > 0 && where !== null && !where.sign;
  const rest = unseen.filter((row) => !seen.has(shownKey(row)));
  const edges = held ? fresh.map((item) => where.edges[item.lands] ?? 'top') : rest.map((row) => row.edge);
  const below = edges.filter((at) => at === 'bottom').length;
  const edge: Edge = below > 0 && below >= edges.length - below ? 'bottom' : 'top';
  const count = edge === 'bottom' ? below : edges.length - below;
  const on = held || (watching && count > 0);
  const burst = held ? fresh.map((item) => item.key).join('\n') : rest.map(shownKey).join('\n');
  const sawAll = () => setSeen(new Set([...loud.map((item) => item.key), ...unseen.map(shownKey)]));

  const signInView = watching && where?.sign === true && fresh.length > 0;
  useEffect(() => {
    if (signInView) sawAll();
  }, [signInView, burst]);
  const noneUnseen = unseen.length === 0;
  useEffect(() => {
    if (noneUnseen) setSeen((last) => ([...last].some((key) => key.startsWith('shown ')) ? new Set([...last].filter((key) => !key.startsWith('shown '))) : last));
  }, [noneUnseen]);

  const [holding, setHolding] = useState(false);
  const [fading, setFading] = useState(false);
  const letGo = useRef(false);
  useEffect(() => {
    if (!on) {
      letGo.current = false;
      setHolding(false);
      return;
    }
    if (stays || holding) return;
    const fade = prefersReducedMotion() ? 0 : LIST_NEW_PILL_FADE_MS;
    const whole = letGo.current ? 0 : LIST_NEW_PILL_MS;
    letGo.current = false;
    let timer = setTimeout(() => {
      if (fade === 0) return sawAll();
      setFading(true);
      timer = setTimeout(sawAll, fade);
    }, whole);
    return () => {
      clearTimeout(timer);
      setFading(false);
    };
  }, [on, holding, burst, stays]);
  const hold = (next: boolean) => {
    if (!next && holding) letGo.current = true;
    setHolding(next);
  };

  const last = useRef<{ count: number; edge: Edge; held: boolean }>({ count: 1, edge: 'bottom', held: true });
  const drawn = on ? { count, edge, held } : last.current;
  useLayoutEffect(() => {
    if (on) last.current = drawn;
  });
  const words = `${drawn.count} new ${drawn.count === 1 ? 'message' : 'messages'} ${drawn.edge === 'bottom' ? 'below' : 'above'}`;
  const [said, setSaid] = useState('');
  useEffect(() => {
    setSaid(on ? words : '');
  }, [on]);

  return (
    <div className="ib-lnew" data-edge={drawn.edge}>
      <button
        type="button"
        className="ib-npill"
        data-list-new-pill=""
        data-off={on ? undefined : ''}
        data-fading={on && fading ? '' : undefined}
        tabIndex={on ? 0 : -1}
        aria-hidden={!on}
        aria-label={`${words}, ${drawn.held ? 'show and go there' : 'go there'}`}
        onPointerEnter={() => hold(true)}
        onPointerLeave={() => hold(false)}
        onFocus={() => hold(true)}
        onBlur={() => hold(false)}
        onClick={(event) => {
          event.currentTarget.blur();
          if (held) onShow(drawn.edge);
          else onGo(drawn.edge);
        }}
      >
        <Icon name={drawn.edge === 'bottom' ? 'arrowDown' : 'arrowUp'} size={15} />
        {drawn.count} new
      </button>
      <span className="ib-sr" aria-live="polite" data-list-new-said="">
        {said}
      </span>
    </div>
  );
}
