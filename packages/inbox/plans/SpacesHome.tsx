/**
 * The Spaces home (approval "plans-home", home-5.html): "What do you want to plan?" and Start a plan over the dither
 * field, "On this computer", Search plans and the cards/list switch at the top right; then "Now" (only active plans,
 * never cut: one row of large cards at most, the rest of it as rows below), "Recent" (8 rows, or one row of cards)
 * and an "All plans" link. The sidebar's project scopes the page to
 * it (the projects combined into it too; "Now" first, then "Earlier"), with Home to go back; "All plans" is every
 * plan by project (the newest 5 rows or one row of cards each, then "Show N more"; a project's name folds its group,
 * and folds are remembered). Search looks through every title, in a project's scope too (its matches first; the
 * scope a chip in the field, whose × goes Home).
 *
 * Nothing moves under the person: an arrival redraws its face, dot and fact in place at once, but while they are
 * looking (the pointer over the page, focus in it, or a scroll or a key in the last 4 s) its new place waits behind a
 * quiet "N updates · Show" pill beside "Now" (counting only what this scope or search shows; said politely to a
 * screen reader); not looking, the page settles by itself, every card moving to its place in one move (the card's
 * `settleBatch`, on each grid) and a newcomer in "Now" fading in (reduced motion: a cut). The clock and the live sessions the layout was placed with are frozen
 * with it: a plan passing Now's 3 days, or an agent starting or stopping, waits like an arrival. Opening a card grows its face into the plan page, and going back
 * shrinks it into its card on the home as it was left (spacesMotion.ts).
 *
 * The card, the row, the pill and their motions are the frame's (`@plannotator/ui/components/frame`: Card, CardRow,
 * CardGrid, CardUpdatesPill, settleBatch, arrive). The card grids are the card's `CardGrid`, each given its row gap
 * (28 px for Now's large cards, 44 for the rest; never its default), and Now's one row of large cards is counted with
 * the same column minimum the grid draws (280 px, 230 for regular, 24 between). Rows are the card's `CardRows` with
 * `actionAtRest="never"`: a row shows its pin only on hover or keyboard focus, and on a touch screen a row is pinned
 * from its long-press menu (Pin to sidebar, Unpin); a pinned row keeps the card's pin after its title.
 */
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactElement, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { PlanSummary, SpacesView } from '@plannotator/core/plans';
import { SidebarTrigger } from '../shell/sidebar';
import { HostMark, Icon } from '../icons';
import { Tip } from '../components/Tip';
import { writeRoute } from '../app/writeRoute';
import { startStillField, reducedMotion } from './dither';
import { useInboxAgents } from '../agentsList';
import { CARD_FACE_WIDTH, Card, CardGrid, CardRow, CardRows, CardUpdatesPill, settleBatch, type CardLinkProps } from '@plannotator/ui/components/frame';
import { mermaidMayLoad } from './planContent';
import { SpaceFace, SpaceThumb } from './SpaceFace';
import { readPlans, setPlanPin, setSpacesView, useFaceText } from './store';
import { ImportErrorNote } from './parts';
import { openSpace, spacesHomeShown, takeHomeScroll } from './spacesMotion';
import { ALL_PLANS_ROWS, RECENT_ROWS, factWords, heldLayout, homeSections, inProject, nextNowCrossing, projectGroups, searchPlans, spaceFact, spaceKind, spaceUnread, spaceWorks, type SpaceWork, type SpaceWorks, type SpacesScopeProject } from './spacesModel';

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

  const scopeId = props.scope.kind === 'project' ? props.scope.id : null;
  const project = useMemo(() => (scopeId === null ? null : (props.projects.find((p) => p.id === scopeId) ?? { id: scopeId, name: scopeId })), [scopeId, props.projects]);
  const q = query.trim();
  const mode = q ? 'search' : props.scope.kind;
  // What this page shows of the library: every title for a search (the approval's "across all titles"), else the scope.
  const shows = useCallback((plans: readonly PlanSummary[]) => (q ? searchPlans(plans, q) : project ? inProject(plans, project) : [...plans]), [q, project]);

  // Which live session is on which plan (the session that submitted its newest version, while it is live here).
  const works = useWorks(props.plans);
  const worksNow = useRef(works);
  worksNow.current = works;
  // The clock Now's age is read with: it ticks only when a plan passes its 3 days.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const next = nextNowCrossing(props.plans, clock);
    if (!Number.isFinite(next)) return;
    const t = setTimeout(() => setClock(Date.now()), Math.min(Math.max(0, next - Date.now()) + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [props.plans, clock]);

  // The layout as placed, with the works and the clock it was placed with; the plans as they are now draw the content.
  const [placed, setPlaced] = useState<readonly PlanSummary[]>(props.plans);
  const [placedWith, setPlacedWith] = useState<{ work: SpaceWorks; at: number }>(() => ({ work: works, at: Date.now() }));
  const placedNow = useRef(placed);
  placedNow.current = placed;
  const looking = useLooking(root);
  const settle = useCallback((next: readonly PlanSummary[]) => {
    const before = new Set(placedNow.current.map((p) => p.id));
    const mutate = () =>
      flushSync(() => {
        setPlaced(next);
        setPlacedWith({ work: worksNow.current, at: Date.now() });
      });
    // The card's settleBatch moves a list's own children, so each grid gets one, nested: each measures its cards,
    // the one mutate runs once inside them all, and each slides its cards from where they were.
    const grids = [...(body.current?.querySelectorAll<HTMLElement>('[data-frame-card-grid], [data-spaces-list]') ?? [])];
    grids.reduce<() => void>((inner, grid) => () => settleBatch(grid, inner), mutate)();
    // A newcomer in "Now" fades in where it lands (home-5's settle; settleBatch brings it down from just above).
    if (reducedMotion()) return;
    for (const el of body.current?.querySelectorAll<HTMLElement>('[data-spaces-section="now"] [data-card-key]') ?? []) {
      if (!before.has(el.dataset.cardKey!) && typeof el.animate === 'function') el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }
  }, []);
  const stale = placed !== props.plans || placedWith.work !== works || placedWith.at < clock;
  useEffect(() => {
    if (looking || !stale) return;
    const t = setTimeout(() => settle(props.plans), 0);
    return () => clearTimeout(t);
  }, [looking, stale, props.plans, settle]);
  // Held and counted within what the page shows: an update elsewhere is no update here.
  const { layout, pending } = useMemo(
    () => heldLayout(shows(placed), shows(props.plans), placedWith, { work: works, at: Math.max(clock, placedWith.at) }),
    [placed, props.plans, shows, placedWith, works, clock],
  );
  const fresh = useMemo(() => new Map(props.plans.map((p) => [p.id, p])), [props.plans]);
  const pins = useMemo(() => new Set(props.pins), [props.pins]);

  const pool = layout;
  const { now, recent } = useMemo(() => homeSections(pool, placedWith.work, placedWith.at), [pool, placedWith]);

  // Where a plan opened from here comes back to, scrolled where it was.
  const route = useMemo(() => ({ page: 'plans' as const, project: scopeId, thread: null, planAll: props.scope.kind === 'all' }), [scopeId, props.scope.kind]);
  useLayoutEffect(() => {
    spacesHomeShown(route, root.current);
    const top = takeHomeScroll(route);
    if (top !== null && root.current) root.current.scrollTop = top;
  }, [route]);

  const cols = useColumns(body, 230, 24);
  const nowCols = useColumns(body, 280, 24);
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
  const item = (plan: PlanSummary, size: 'large' | 'regular', withProject = false, row = list) => (
    <SpaceItem
      key={plan.id}
      plan={fresh.get(plan.id) ?? plan}
      work={works.find((w) => w.plan === plan.id) ?? null}
      size={size}
      list={row}
      secondary={withProject && mode !== 'project' ? plan.project_name || undefined : undefined}
      pinned={pins.has(plan.id)}
      portal={portal}
    />
  );
  const items = (plans: readonly PlanSummary[], size: 'large' | 'regular', withProject = false, row = list) =>
    row ? (
      <CardRows className="ib-spc-rows" data-spaces-list="" actionAtRest="never">
        {plans.map((p) => item(p, size, withProject, row))}
      </CardRows>
    ) : (
      <CardGrid size={size} gap={size === 'large' ? 28 : 44}>
        {plans.map((p) => item(p, size, withProject, row))}
      </CardGrid>
    );
  const held = pending > 0 && looking;
  // Always drawn by the first heading (its polite count is said when it changes); its button only while updates wait.
  const pill = <CardUpdatesPill count={held ? pending : 0} onShow={() => settle(props.plans)} />;
  // The pill sits by the first heading on the page ("Now" when there is one).
  let pillShown = false;
  const takePill = () => {
    if (pillShown) return null;
    pillShown = true;
    return pill;
  };
  const head = (words: string, id: string, now = false) => (
    <h2 className={now ? 'ib-spc-h ib-spc-nowh' : 'ib-spc-h'} id={id}>
      <span dir="auto">{words}</span>
      {takePill()}
    </h2>
  );

  const sections: ReactElement[] = [];
  // "Now", and its heading whenever updates wait (the pill sits beside "Now").
  if (now.length || held) {
    sections.push(
      <section key="now" className="ib-spc-sec" aria-labelledby={`${headId}-now`} data-spaces-section="now">
        {head('Now', `${headId}-now`, true)}
        {/* One row of large cards at most; the rest of Now as rows under it, in the same section. */}
        {now.length > 0 && (list ? items(now, 'regular', true) : items(now.slice(0, nowCols), 'large', true, false))}
        {!list && now.length > nowCols && items(now.slice(nowCols), 'regular', true, true)}
      </section>,
    );
  }
  if (mode === 'home' && recent.length) {
    sections.push(
      <section key="recent" className="ib-spc-sec" aria-labelledby={`${headId}-recent`} data-spaces-section="recent">
        {head('Recent', `${headId}-recent`)}
        {items(recent.slice(0, list ? RECENT_ROWS : cols), 'regular', true)}
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
    // A search from a project's scope lists that project's matches first.
    const scoped = project ? new Set(inProject(recent, project).map((p) => p.id)) : null;
    const groups = projectGroups(recent);
    if (scoped) groups.sort((a, b) => Number(b.plans.some((p) => scoped.has(p.id))) - Number(a.plans.some((p) => scoped.has(p.id))));
    for (const group of groups) {
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
    <section className={`ib-dpage ib-spaces${list ? ' ib-spc-list' : ''}`} ref={root} aria-label="Spaces" data-spaces-home="" data-spaces-view={props.view} data-spaces-scope={mode} style={FACE_WIDTH_STYLE}>
      <Hearth headId={`${headId}-h`} query={query} onQuery={setQuery} view={props.view} scope={project} />
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

/** The width the card lays every face out at (the faces' CSS reads it: plans.css `--ib-spc-face-w`). */
const FACE_WIDTH_STYLE = { '--ib-spc-face-w': `${CARD_FACE_WIDTH}px` } as CSSProperties;

function readFolds(): ReadonlySet<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SPACES_FOLDS_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * The page's head: the field, the scope's tools at the top right, and the one question with Start a plan. In a
 * project's scope the search field carries the scope as a chip; its × goes Home.
 */
function Hearth({ headId, query, onQuery, view, scope }: { headId: string; query: string; onQuery: (q: string) => void; view: SpacesView; scope: SpacesScopeProject | null }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!host.current || !canvas.current) return;
    return startStillField(host.current, canvas.current);
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
          <div className={scope ? 'ib-spc-search ib-spc-scoped' : 'ib-spc-search'}>
            <Icon name="search" />
            {scope && (
              <span className="ib-spc-chip" data-spaces-scope-chip="">
                <span dir="auto">{scope.name}</span>
                <button type="button" aria-label={`Remove ${scope.name}, show every project`} onClick={home} data-spaces-scope-remove="">
                  <Icon name="x" size={12} />
                </button>
              </span>
            )}
            <input type="search" placeholder="Search plans" aria-label="Search plans" value={query} onChange={(e) => onQuery(e.target.value)} autoComplete="off" data-spaces-search="" />
          </div>
          <ViewSwitch view={view} />
        </div>
      </div>
      <div className="ib-spc-words">
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
// Drawn again only when its own plan, place or pin changed: a read that brings nothing new, or the person looking or
// not, redraws no card and no face.
const SpaceItem = memo(function SpaceItem({ plan, work, size, list, secondary, pinned, portal }: { plan: PlanSummary; work: SpaceWork | null; size: 'large' | 'regular'; list: boolean; secondary?: string; pinned: boolean; portal: HTMLElement | null }) {
  const fact = spaceFact(plan, work);
  const words = factWords(fact);
  // A date's full time is the card's tooltip (the words stay the home's: "Today", "Yesterday", "Nov 15").
  const time = fact.kind === 'date' ? plan.updated_at : undefined;
  const kind = spaceKind(plan);
  const thumb = useThumbDraws(plan, list) ? <SpaceThumb plan={plan} /> : undefined;
  // A failed write puts the pin back and the window's toast says so (the store).
  const pin = () => void setPlanPin(plan.id, !pinned);
  const action = (
    <Tip content={pinned ? 'Unpin' : 'Pin to sidebar'} side="bottom">
      <button type="button" className={`ib-spc-pin${pinned ? ' ib-spc-pinned' : ''}`} aria-label={pinned ? `Unpin ${plan.name}` : `Pin ${plan.name} to sidebar`} onClick={pin} data-space-pin-toggle={plan.id}>
        <Icon name={pinned ? 'pinOff' : 'pin'} size={15} />
      </button>
    </Tip>
  );
  // While its agent works on it, the agent's mark breathes beside the fact (the frame's `breathe`).
  const factMark = fact.kind === 'working' ? <HostMark host={fact.host} /> : undefined;
  const common = { kind, title: plan.name, href: `#plans=${encodeURIComponent(plan.id)}`, linkComponent: SpaceLink, fact: words, factMark, factTone: fact.kind === 'move' ? ('action' as const) : ('default' as const), working: fact.kind === 'working', unread: spaceUnread(plan), time, action, pinned };
  const face = plan.head_version_number >= 1 ? <SpaceFace plan={plan} /> : null;
  const box = (
    <div className={list ? 'ib-spc-item ib-spc-rowitem' : 'ib-spc-item'} data-card-key={plan.id} data-space={plan.id}>
      <div className="ib-spc-in">
        {list ? <CardRow {...common} secondary={secondary} thumb={thumb} empty={plan.head_version_number < 1} /> : <Card {...common} face={face} size={size} />}
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
});

/**
 * Whether a row's thumbnail draws the plan's own face (`SpaceThumb`); when it would not, the row is given none and the
 * card draws its kind's glyph. An HTML page never (no frame in a row); a picture or a diagram once its face is read
 * and is one that draws (a picture the list draws; a diagram not cut, and a Mermaid one that could load nothing).
 */
function useThumbDraws(plan: PlanSummary, list: boolean): boolean {
  const kind = plan.primary_kind ?? 'markdown';
  const head = plan.head_version_number >= 1 ? plan.head_version_number : null;
  const drawn = kind === 'image' || kind === 'mermaid' || kind === 'graphviz';
  const face = useFaceText(plan.id, list && drawn ? head : null);
  if (!list || head === null || kind === 'html') return false;
  if (!drawn) return true;
  if (!face) return false;
  if (kind === 'image') return !!face.picture;
  return face.text !== null && !face.cut && !(kind === 'mermaid' && mermaidMayLoad(face.text));
}

/** A card's link: the plan's address; a plain click opens it with the face growing into the page. */
function SpaceLink({ href, className, children, ...rest }: CardLinkProps) {
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const card = e.currentTarget.closest<HTMLElement>('[data-card-key]');
    if (!card?.dataset.cardKey) return;
    e.preventDefault();
    openSpace(card.dataset.cardKey, card.querySelector<HTMLElement>('[data-frame-card-well]'));
  };
  return (
    <a href={href} className={className} {...rest} onClick={open}>
      {children}
    </a>
  );
}

/**
 * The person is looking at the page: the pointer is over it, focus is in it (a keyboard or a screen reader's user
 * reading a card), or they scrolled or pressed a key in the last 4 s. Leaving the window counts as not looking.
 */
export function useLooking(root: RefObject<HTMLElement | null>): boolean {
  const [looking, setLooking] = useState(false);
  useEffect(() => {
    let inside = false;
    let focused = false;
    let last = -Infinity;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      const since = performance.now() - last;
      setLooking(inside || focused || since < LOOK_MS);
      if (timer) clearTimeout(timer);
      timer = !inside && !focused && since < LOOK_MS ? setTimeout(update, LOOK_MS - since + 20) : null;
    };
    const focus = () => {
      const now = !!root.current && root.current.contains(document.activeElement);
      if (now !== focused) {
        focused = now;
        update();
      }
    };
    // After focus moves (focusout comes before the next focusin): read where it is now.
    const blurred = () => setTimeout(focus, 0);
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
    el?.addEventListener('focusin', focus);
    el?.addEventListener('focusout', blurred);
    focus();
    document.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', away);
    window.addEventListener('blur', away);
    document.addEventListener('keydown', active);
    document.addEventListener('wheel', active, { passive: true });
    document.addEventListener('touchmove', active, { passive: true });
    el?.addEventListener('scroll', active, { passive: true, capture: true });
    return () => {
      if (timer) clearTimeout(timer);
      el?.removeEventListener('focusin', focus);
      el?.removeEventListener('focusout', blurred);
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

/**
 * The works the home shows: the live agents the Inbox's own list read already holds (the sidebar's Agents; no read of
 * its own) against each plan's `head_agent`. The same array while nothing changed, so no card redraws for a read that
 * brought nothing.
 */
function useWorks(plans: readonly PlanSummary[]): SpaceWork[] {
  const groups = useInboxAgents();
  const live = useMemo(() => new Set((groups ?? []).flatMap((group) => group.agents.filter((agent) => agent.live && agent.host).map((agent) => `${agent.host}:${agent.session}`))), [groups]);
  const next = useMemo(() => spaceWorks(plans, live), [plans, live]);
  const kept = useRef(next);
  const key = (works: readonly SpaceWork[]) => works.map((w) => `${w.plan}|${w.host}:${w.session}|${w.agent}`).join(',');
  if (key(kept.current) !== key(next)) kept.current = next;
  return kept.current;
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
