/**
 * The Spaces home (approval "plans-home", home-5.html): "What do you want to plan?" and Start a plan over the dither
 * field, "On this computer", Search plans and the cards/list switch at the top right; then "Now" (only active plans,
 * never cut), "Recent" (8 rows, or one row of cards) and an "All plans" link. The sidebar's project scopes the page to
 * it ("Now" first, then "Earlier"), with Home to go back; "All plans" is every plan by project (the newest 5 rows or
 * one row of cards each, then "Show N more"; a project's name folds its group, and folds are remembered). Search
 * looks through every title.
 *
 * Nothing moves under the person: an arrival redraws its face, dot and fact in place at once, but while they are
 * looking (the pointer over the page, or a scroll or a key in the last 4 s) its new place waits behind a quiet
 * "N updates · Show" pill; not looking, the page settles by itself, every card moving to its place in one move
 * (reduced motion: a cut). Opening a card grows its face into the plan page (a View Transition where there is one).
 *
 * The card, the row, the pill and their motions are the frame's (packages/ui/components/frame), built by the sister
 * team; until they land they come from the one stand-in file (frameCardStandIn.tsx).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { PlanSummary, SpacesView } from '@plannotator/core/plans';
import { fullTime } from '@plannotator/core/inbox-format';
import { SidebarTrigger } from '../shell/sidebar';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { writeRoute } from '../app/writeRoute';
import { startPlansDither, reducedMotion } from './dither';
import { Card, CardRow, CardStyles, CardUpdatesPill, arrive, settleBatch, type CardLinkProps } from './frameCardStandIn';
import { SpaceFace } from './SpaceFace';
import { readPlans, setPlanPin, setSpacesView } from './store';
import { ImportErrorNote } from './parts';
import { ALL_PLANS_ROWS, RECENT_ROWS, factWords, heldLayout, homeSections, inProject, projectGroups, searchPlans, spaceFact, spaceKind, spaceUnread, type SpacesScopeProject } from './spacesModel';

/** How long a scroll or a key keeps the person "looking" (approval "plans-home"). */
export const LOOK_MS = 4000;
/** Where the folded projects of "All plans" are kept, on this computer. */
export const SPACES_FOLDS_KEY = 'plannotator-inbox-spaces-folded';

export type SpacesScope = { kind: 'home' } | { kind: 'all' } | { kind: 'project'; id: string };

export interface SpacesHomeProps {
  plans: readonly PlanSummary[];
  pins: readonly string[];
  view: SpacesView;
  scope: SpacesScope;
  projects: readonly SpacesScopeProject[];
  importing: boolean;
  error: string | null;
  importError: string | null;
}

const home = () => writeRoute({ page: 'plans', project: null, thread: null });

export function SpacesHome(props: SpacesHomeProps) {
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const headId = useId();

  // The layout as placed; the plans as they are now draw the content.
  const [placed, setPlaced] = useState<readonly PlanSummary[]>(props.plans);
  const looking = useLooking(root);
  const settle = useCallback((next: readonly PlanSummary[]) => settleBatch(body.current, () => flushSync(() => setPlaced(next))), []);
  useEffect(() => {
    if (looking || placed === props.plans) return;
    const t = setTimeout(() => settle(props.plans), 0);
    return () => clearTimeout(t);
  }, [looking, placed, props.plans, settle]);
  const { layout, pending } = useMemo(() => heldLayout(placed, props.plans), [placed, props.plans]);
  const fresh = useMemo(() => new Map(props.plans.map((p) => [p.id, p])), [props.plans]);
  const pins = useMemo(() => new Set(props.pins), [props.pins]);

  const scopeId = props.scope.kind === 'project' ? props.scope.id : null;
  const project = useMemo(() => (scopeId === null ? null : (props.projects.find((p) => p.id === scopeId) ?? { id: scopeId, name: scopeId })), [scopeId, props.projects]);
  const q = query.trim();
  const mode = q ? 'search' : props.scope.kind;
  const pool = useMemo(() => {
    const scoped = project ? inProject(layout, project) : layout;
    return q ? searchPlans(scoped, q) : scoped;
  }, [layout, project, q]);
  const { now, recent } = useMemo(() => homeSections(pool, null), [pool]);

  const cols = useColumns(body, 230, 24);
  const [folded, setFolded] = useState<ReadonlySet<string>>(readFolds);
  const fold = (name: string) => {
    const next = new Set(folded);
    if (!next.delete(name)) next.add(name);
    setFolded(next);
    try {
      localStorage.setItem(SPACES_FOLDS_KEY, JSON.stringify([...next]));
    } catch {
      // Private mode: the folds hold for this page.
    }
  };
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(root.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);

  const list = props.view === 'list';
  const item = (plan: PlanSummary, size: 'large' | 'regular', withProject = false) => (
    <SpaceItem key={plan.id} plan={fresh.get(plan.id) ?? plan} size={size} list={list} secondary={withProject && mode !== 'project' ? plan.project_name || undefined : undefined} pinned={pins.has(plan.id)} portal={portal} />
  );
  const items = (plans: readonly PlanSummary[], size: 'large' | 'regular', withProject = false) => <div className={list ? 'ib-spc-rows' : size === 'large' ? 'ib-spc-grid ib-spc-now' : 'ib-spc-grid'}>{plans.map((p) => item(p, size, withProject))}</div>;
  const pill = pending > 0 && looking ? <CardUpdatesPill count={pending} onShow={() => settle(props.plans)} /> : null;
  // The pill sits by the first heading on the page ("Now" when there is one).
  let pillShown = false;
  const takePill = () => {
    if (pillShown) return null;
    pillShown = true;
    return pill;
  };
  const head = (words: string, id: string) => (
    <h2 className="ib-spc-h" id={id}>
      <span dir="auto">{words}</span>
      {takePill()}
    </h2>
  );

  const sections: ReactElement[] = [];
  if (now.length) {
    sections.push(
      <section key="now" className="ib-spc-sec" aria-labelledby={`${headId}-now`} data-spaces-section="now">
        {head('Now', `${headId}-now`)}
        {items(now, list ? 'regular' : 'large', true)}
      </section>,
    );
  }
  if (mode === 'home' && recent.length) {
    sections.push(
      <section key="recent" className="ib-spc-sec" aria-labelledby={`${headId}-recent`} data-spaces-section="recent">
        {head('Recent', `${headId}-recent`)}
        {items(recent.slice(0, list ? RECENT_ROWS : cols), 'regular')}
        <button type="button" className="ib-spc-more ib-spc-all" onClick={() => writeRoute({ page: 'plans', project: null, thread: null, planAll: true })} data-spaces-all="">
          All plans
        </button>
      </section>,
    );
  } else if (mode === 'project' && recent.length) {
    sections.push(
      <section key="earlier" className="ib-spc-sec" aria-labelledby={now.length ? `${headId}-earlier` : undefined} aria-label={now.length ? undefined : project!.name} data-spaces-section="earlier">
        {now.length > 0 && head('Earlier', `${headId}-earlier`)}
        {items(recent, 'regular')}
      </section>,
    );
  } else if (mode === 'all' || mode === 'search') {
    for (const group of projectGroups(recent)) {
      const shut = mode === 'all' && folded.has(group.project);
      const open = mode === 'search' || opened.has(group.project);
      const cut = list ? ALL_PLANS_ROWS : cols;
      const shown = open || shut ? group.plans : group.plans.slice(0, cut);
      const n = group.plans.length;
      const gid = `${headId}-g-${sections.length}`;
      sections.push(
        <section key={`g:${group.project}`} className="ib-spc-sec ib-spc-group" aria-labelledby={gid} data-spaces-group={group.project} data-folded={shut ? '' : undefined}>
          {mode === 'all' ? (
            <h2 className="ib-spc-h" id={gid}>
              <button type="button" className="ib-spc-fold" aria-expanded={!shut} onClick={() => fold(group.project)} data-spaces-fold={group.project}>
                <Icon name="chevD" />
                <span dir="auto">{group.project}</span>
                {shut && <span className="ib-spc-fcount">{n === 1 ? '1 plan' : `${n} plans`}</span>}
              </button>
              {takePill()}
            </h2>
          ) : (
            head(group.project, gid)
          )}
          {!shut && items(shown, 'regular')}
          {!shut && n > shown.length && (
            <button type="button" className="ib-spc-more" onClick={() => setOpened(new Set(opened).add(group.project))} data-spaces-more={group.project}>
              Show {n - shown.length} more
            </button>
          )}
        </section>,
      );
    }
  }

  const crumbs =
    mode === 'project' || mode === 'all' ? (
      <nav className="ib-spc-crumbs" aria-label="Where you are" data-spaces-crumbs="">
        <button type="button" onClick={home} data-spaces-home-crumb="">
          <Icon name="chevL" />
          Home
        </button>
        <b dir="auto">{mode === 'project' ? project!.name : 'All plans'}</b>
      </nav>
    ) : null;

  return (
    <section className={`ib-dpage ib-spaces${list ? ' ib-spc-list' : ''}`} ref={root} aria-label="Spaces" data-spaces-home="" data-spaces-view={props.view} data-spaces-scope={mode}>
      <CardStyles />
      <Hearth headId={`${headId}-h`} query={query} onQuery={setQuery} view={props.view} />
      <div className="ib-spc-body" ref={body}>
        {props.importing && (
          <p className="ib-plans-note" role="status">
            Bringing in the plans you reviewed before…
          </p>
        )}
        {props.importError && <ImportErrorNote error={props.importError} onRetry={() => void readPlans(true)} />}
        {props.error && (
          <p className="ib-plans-note" role="alert">
            {props.error}{' '}
            <button type="button" className="ib-plans-link" onClick={() => void readPlans()}>
              Try again
            </button>
          </p>
        )}
        {crumbs}
        {sections}
        {!pool.length && (
          <p className="ib-spc-none" data-spaces-none="">
            {q ? `No plans match “${q}”.` : 'No plans in this project.'}
          </p>
        )}
      </div>
    </section>
  );
}

function readFolds(): ReadonlySet<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SPACES_FOLDS_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/** The page's head: the field, the scope's tools at the top right, and the one question with Start a plan. */
function Hearth({ headId, query, onQuery, view }: { headId: string; query: string; onQuery: (q: string) => void; view: SpacesView }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const words = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || !canvas.current) return;
    return startPlansDither(host.current, canvas.current, () => (words.current ? [words.current] : []));
  }, []);
  return (
    <header className="ib-spc-hearth">
      <div className="ib-spc-field" ref={host} aria-hidden="true">
        <canvas ref={canvas} />
      </div>
      <div className="ib-dh ib-spc-top">
        <SidebarTrigger />
        <div className="ib-spc-tools">
          <span className="ib-spc-local" data-spaces-local="">
            <Icon name="laptop" />
            On this computer
          </span>
          <label className="ib-spc-search">
            <Icon name="search" />
            <input type="search" placeholder="Search plans" aria-label="Search plans" value={query} onChange={(e) => onQuery(e.target.value)} autoComplete="off" data-spaces-search="" />
          </label>
          <ViewSwitch view={view} />
        </div>
      </div>
      <div className="ib-spc-words" ref={words}>
        <h1 id={headId} tabIndex={-1}>
          What do you want to plan?
        </h1>
        <button type="button" className="ib-plans-primary" onClick={() => writeRoute({ page: 'plans', project: null, thread: null, planNew: true })} data-plans-new="">
          <Icon name="arrowRight" />
          Start a plan
        </button>
      </div>
    </header>
  );
}

const VIEW_MARKS: Record<SpacesView, ReactElement> = {
  cards: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="1.75" y="1.75" width="5.25" height="5.25" rx="1.2" />
      <rect x="9" y="1.75" width="5.25" height="5.25" rx="1.2" />
      <rect x="1.75" y="9" width="5.25" height="5.25" rx="1.2" />
      <rect x="9" y="9" width="5.25" height="5.25" rx="1.2" />
    </svg>
  ),
  list: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M2 3.5h12M2 8h12M2 12.5h12" strokeLinecap="round" />
    </svg>
  ),
};

/** Cards | List: two small buttons, the person's choice kept in config.json. */
function ViewSwitch({ view }: { view: SpacesView }) {
  return (
    <div className="ib-spc-vsw" role="group" aria-label="Show plans as" data-spaces-view-switch="">
      {(['cards', 'list'] as const).map((v) => (
        <Tip key={v} content={v === 'cards' ? 'Cards' : 'List'} side="bottom">
          <button type="button" aria-label={v === 'cards' ? 'Cards' : 'List'} aria-pressed={view === v} onClick={() => view !== v && void setSpacesView(v)} data-spaces-view-pick={v}>
            {VIEW_MARKS[v]}
          </button>
        </Tip>
      ))}
    </div>
  );
}

/** One space as a card or a row: its face, its title, its one fact, its unread dot, and the pin beside the link. */
function SpaceItem({ plan, size, list, secondary, pinned, portal }: { plan: PlanSummary; size: 'large' | 'regular'; list: boolean; secondary?: string; pinned: boolean; portal: HTMLElement | null }) {
  const inner = useRef<HTMLDivElement>(null);
  const fact = spaceFact(plan, null);
  const words = factWords(fact);
  const factNode = fact.kind === 'move' ? <span className="ib-spc-you">{words}</span> : words;
  const time = fact.kind === 'date' ? fullTime(plan.updated_at) : undefined;
  // Something arrived: the face takes its new content in place, with the arrival's short fade; nothing moves.
  const stamp = `${plan.head_version_number}:${plan.updated_at}`;
  const was = useRef(stamp);
  useEffect(() => {
    if (was.current === stamp) return;
    was.current = stamp;
    arrive(inner.current?.querySelector('[data-card-face]') ?? null);
  }, [stamp]);
  const pin = () => void setPlanPin(plan.id, !pinned).catch(() => {});
  const action = (
    <Tip content={pinned ? 'Unpin' : 'Pin to sidebar'} side="bottom">
      <button type="button" className={`ib-spc-pin${pinned ? ' ib-spc-pinned' : ''}`} aria-label={pinned ? 'Unpin' : 'Pin to sidebar'} onClick={pin} data-space-pin-toggle={plan.id}>
        <Icon name={pinned ? 'pinOff' : 'pin'} size={15} />
      </button>
    </Tip>
  );
  const common = { kind: spaceKind(plan), title: plan.name, href: `#plans=${encodeURIComponent(plan.id)}`, linkComponent: SpaceLink, fact: factNode, unread: spaceUnread(plan), time, action, pinned };
  const face = plan.head_version_number >= 1 ? <SpaceFace plan={plan} /> : null;
  const box = (
    <div className={list ? 'ib-spc-item ib-spc-rowitem' : 'ib-spc-item'} data-card-key={plan.id} data-space={plan.id}>
      <div className="ib-spc-in" ref={inner}>
        {list ? <CardRow {...common} secondary={secondary} face={face} /> : <Card {...common} face={face} size={size} />}
      </div>
    </div>
  );
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={box} />
      <ContextMenu.Portal container={portal ?? undefined}>
        <ContextMenu.Positioner className="ib-pm-pos">
          <ContextMenu.Popup className="ib-pm" aria-label={plan.name} data-space-menu={plan.id}>
            <Menu.Item className="ib-pmi" label={pinned ? 'Unpin' : 'Pin to sidebar'} onClick={pin} data-space-menu-pin={pinned ? 'unpin' : 'pin'}>
              <Icon name={pinned ? 'pinOff' : 'pin'} size={15} />
              {pinned ? 'Unpin' : 'Pin to sidebar'}
            </Menu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** A card's link: the plan's address; a plain click opens it with the face growing into the page. */
function SpaceLink({ href, className, children, ...rest }: CardLinkProps) {
  return (
    <a
      href={href}
      className={className}
      {...rest}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const id = e.currentTarget.closest<HTMLElement>('[data-card-key]')?.dataset.cardKey;
        if (!id) return;
        e.preventDefault();
        openSpace(id, e.currentTarget.querySelector<HTMLElement>('[data-card-face]'));
      }}
    >
      {children}
    </a>
  );
}

/** The class on the root while a card opens: the plan page's document takes the face's name (plans.css). */
const OPENING = 'ib-space-opening';

/** Open a plan; where View Transitions are, its face grows into the page's document (280 ms); else a cut. */
export function openSpace(id: string, face: HTMLElement | null): void {
  const go = () => writeRoute({ page: 'plans', project: null, thread: null, plan: id });
  const start = typeof document.startViewTransition === 'function' ? document.startViewTransition.bind(document) : null;
  if (!start || !face || reducedMotion()) return go();
  face.style.viewTransitionName = 'ib-space-open';
  const docEl = document.documentElement;
  const move = start(async () => {
    face.style.viewTransitionName = '';
    docEl.classList.add(OPENING);
    go();
    await until(() => !!document.querySelector('[data-plan-document]'), 360);
  });
  void move.finished.finally(() => docEl.classList.remove(OPENING));
}

function until(ready: () => boolean, ms: number): Promise<void> {
  const end = performance.now() + ms;
  return new Promise((resolve) => {
    const tick = () => (ready() || performance.now() > end ? resolve() : requestAnimationFrame(tick));
    tick();
  });
}

/**
 * The person is looking at the page: the pointer is over it, or they scrolled or pressed a key in the last 4 s.
 * Leaving the window counts as not looking.
 */
export function useLooking(root: RefObject<HTMLElement | null>): boolean {
  const [looking, setLooking] = useState(false);
  useEffect(() => {
    let inside = false;
    let last = -Infinity;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      const since = performance.now() - last;
      setLooking(inside || since < LOOK_MS);
      if (timer) clearTimeout(timer);
      timer = !inside && since < LOOK_MS ? setTimeout(update, LOOK_MS - since + 20) : null;
    };
    const move = (e: PointerEvent) => {
      const over = !!root.current && e.target instanceof Node && root.current.contains(e.target);
      if (over !== inside) {
        inside = over;
        update();
      }
    };
    const away = () => {
      if (!inside) return;
      inside = false;
      update();
    };
    const active = () => {
      last = performance.now();
      update();
    };
    const el = root.current;
    document.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', away);
    window.addEventListener('blur', away);
    document.addEventListener('keydown', active);
    document.addEventListener('wheel', active, { passive: true });
    document.addEventListener('touchmove', active, { passive: true });
    el?.addEventListener('scroll', active, { passive: true, capture: true });
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', away);
      window.removeEventListener('blur', away);
      document.removeEventListener('keydown', active);
      document.removeEventListener('wheel', active);
      document.removeEventListener('touchmove', active);
      el?.removeEventListener('scroll', active, { capture: true });
    };
  }, [root]);
  return looking;
}

/** How many regular cards one row of the page holds (auto-fill at `min` px with `gap`); 4 before the first measure. */
function useColumns(box: RefObject<HTMLElement | null>, min: number, gap: number): number {
  const [cols, setCols] = useState(4);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft || '0') - parseFloat(getComputedStyle(el).paddingRight || '0');
      if (w > 0) setCols(Math.max(1, Math.floor((w + gap) / (min + gap))));
    };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [box, min, gap]);
  return cols;
}
