/**
 * The Pull requests page, "the Sheet" (approval "inbox-pr-dashboard"; the owner's answers of 2026-11-09): one full
 * page, a section per repository, each open PR a number tile, stacks as joined tiles (one strip past 8 PRs). The
 * header counts; a filter field (title, author, repository, number), Open | Merged (the last 14 days), and the forge's
 * own closed search as a link. A tile's popover (hover or focus; Enter or a tap pins it, a bottom sheet on a phone)
 * says what the PR is and offers Open, Open on GitHub, and Merge when the forge said it can (a second click confirms).
 *
 * Keyboard: Tab and Enter only (arrow keys are deferred, q-38094e68). A tile's popover actions join the Tab order only
 * once Enter pins it; Escape closes it back to the tile.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { inboxPullIsOpen, inboxPullLabel, type InboxPull, type InboxPullStack, type InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { SidebarTrigger } from '../shell/sidebar';
import { inboxApi } from '../api';
import { forgeName, hostName } from '../pulls/labels';
import { pullsEmptyWords, pullsNotices } from '../pulls/notices';
import { usePullRisk } from '../pulls/usePullRisk';
import { Named, Person } from '../pulls/Face';
import { facesOnce } from '../pulls/words';
import { ChecksMark, checksLabel } from './ChecksMark';
import {
  agoWords,
  closedLinks,
  foldsToStrip,
  isStack,
  matchesQuery,
  mergedModel,
  mergeOffered,
  needsYou,
  sheetModel,
  stackCounts,
  statusParts,
  type RiskLevels,
} from './sheetModel';

export type SheetView = 'open' | 'merged';

export interface SheetPageProps {
  model: InboxPullsAnswer | null;
  error: string | null;
  loading: boolean;
  phone: boolean;
  view: SheetView;
  /** The agent's risk levels by PR key; absent: read here (`GET /api/inbox/pulls/risk`), as the Reviews page does. */
  risk?: RiskLevels;
  onView: (view: SheetView) => void;
  /** Open a PR's own view (the Inbox's PR review), from the Sheet. */
  onOpenPull: (pull: InboxPull, stack: InboxPullStack) => void;
  /** Open a stack's own page. */
  onOpenStack: (stack: InboxPullStack) => void;
  /** A merge went: read the list again. */
  onMerged: () => void;
  /** For tests and shots: the clock. */
  now?: number;
  /**
   * `page`: its own page (`#prs`, a phone's way in from Reviews); `pane`: Reviews' right pane while no review is open
   * there (approval "inbox-pr-dashboard", the owner's pick "in Reviews", take C), with no sidebar button of its own.
   */
  mode?: 'page' | 'pane';
  /** The page's back arrow, to Reviews (in place of the sidebar button). */
  onBack?: () => void;
}

/** The popover: the PR it is of, the tile it hangs from, and whether Enter or a tap pinned it (its actions take focus). */
interface Pop {
  pull: InboxPull;
  stack: InboxPullStack;
  anchor: HTMLElement;
  pinned: boolean;
}

const HOVER_OPEN_MS = 280;
const HOVER_CLOSE_MS = 180;
/** How long "✓ Merged" stays in the popover before it closes and the PR leaves Open. */
export const MERGED_SHOWN_MS = 1500;

/** The list with the PRs merged from this page shown merged, before the next read says so. */
function withMergedHere(model: InboxPullsAnswer | null, merged: ReadonlyMap<string, string>): InboxPullsAnswer | null {
  if (!model || merged.size === 0) return model;
  return { ...model, pulls: model.pulls.map((pull) => (merged.has(pull.key) && inboxPullIsOpen(pull) ? { ...pull, state: 'merged' as const, merged_at: pull.merged_at ?? merged.get(pull.key)! } : pull)) };
}

export function SheetPage(props: SheetPageProps) {
  const { phone, view } = props;
  // A PR merged here leaves Open as its popover closes, whatever the list on screen still says.
  const [mergedHere, setMergedHere] = useState<ReadonlyMap<string, string>>(() => new Map());
  const model = useMemo(() => withMergedHere(props.model, mergedHere), [props.model, mergedHere]);
  // A merge under way or just done holds its popover open: the pointer leaving or another tile doesn't close it.
  const held = useRef(false);
  // The clock moves with the list (ages and "this week" are read against the answer on screen).
  const readAt = useMemo(() => Date.now(), [model]);
  const now = props.now ?? readAt;
  const [query, setQuery] = useState('');
  const [pop, setPop] = useState<Pop | null>(null);
  const titleId = useId();
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  const riskAnswer = usePullRisk(props.risk ? null : model).answer;
  const risk = useMemo<RiskLevels>(
    () => props.risk ?? Object.fromEntries(Object.entries(riskAnswer?.judgments ?? {}).map(([key, judgment]) => [key, judgment.level])),
    [props.risk, riskAnswer],
  );
  const sheet = useMemo(() => (model ? sheetModel(model, now, risk) : null), [model, now, risk]);
  const merged = useMemo(() => (model && view === 'merged' ? mergedModel(model, now) : null), [model, now, view]);
  const notices = useMemo(() => (model ? pullsNotices(model) : []), [model]);
  const q = query.trim();

  const show = useCallback((next: Pop) => {
    clearTimers();
    setPop(next);
  }, []);
  const hide = useCallback((returnFocus: boolean) => {
    clearTimers();
    setPop((was) => {
      if (was && returnFocus) queueMicrotask(() => was.anchor.isConnected && was.anchor.focus());
      return null;
    });
  }, []);

  /** A tile's handlers: hover and focus show the popover, a mouse click opens the PR, Enter or a tap pins the popover. */
  const tileHandlers = (pull: InboxPull, stack: InboxPullStack) => ({
    onPointerEnter: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType !== 'mouse' || phone) return;
      const anchor = event.currentTarget;
      clearTimers();
      if (held.current) return;
      if (pop && !pop.pinned) setPop({ pull, stack, anchor, pinned: false });
      else if (!pop) openTimer.current = setTimeout(() => setPop({ pull, stack, anchor, pinned: false }), HOVER_OPEN_MS);
    },
    onPointerLeave: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType !== 'mouse' || phone) return;
      if (openTimer.current) clearTimeout(openTimer.current);
      openTimer.current = null;
      closeTimer.current = setTimeout(() => setPop((was) => (was && !was.pinned && !held.current ? null : was)), HOVER_CLOSE_MS);
    },
    onFocus: (event: ReactFocusEvent<HTMLButtonElement>) => {
      if (phone || held.current || !event.currentTarget.matches(':focus-visible')) return;
      show({ pull, stack, anchor: event.currentTarget, pinned: false });
    },
    onBlur: (event: ReactFocusEvent<HTMLButtonElement>) => {
      // Into the pinned popover is not away.
      const to = event.relatedTarget as Node | null;
      if (to && document.querySelector('[data-pr-pop]')?.contains(to)) return;
      setPop((was) => (was && !was.pinned && !held.current && was.anchor === event.currentTarget ? null : was));
    },
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      const anchor = event.currentTarget;
      // A mouse click on a desktop opens the PR: hovering already showed what the popover says.
      if (!phone && event.detail > 0) {
        hide(false);
        props.onOpenPull(pull, stack);
        return;
      }
      show({ pull, stack, anchor, pinned: true });
    },
  });

  const tile = (pull: InboxPull, stack: InboxPullStack, inStack: boolean) => {
    const you = needsYou(pull);
    const dim = !!q && !matchesQuery(pull, q);
    const checks = checksLabel(pull.checks);
    const words = [inboxPullLabel(pull), pull.title, pull.state === 'draft' ? 'draft' : pull.state === 'merged' ? 'merged' : null, you === 'review' ? 'needs your review' : you === 'changes' ? 'changes requested' : null, checks]
      .filter(Boolean)
      .join(', ');
    return (
      <button
        key={pull.key}
        type="button"
        className="ib-prt"
        data-pr-tile={pull.key}
        data-state={pull.state}
        data-you={you ? '' : undefined}
        data-dim={dim ? '' : undefined}
        data-in-stack={inStack ? '' : undefined}
        aria-label={words}
        aria-haspopup="dialog"
        aria-expanded={pop?.pull.key === pull.key && pop.pinned ? true : undefined}
        {...tileHandlers(pull, stack)}
      >
        {pull.state === 'merged' && <Icon name="pullRequest" size={12} />}
        <span className="ib-prt-n">{inboxPullLabel(pull)}</span>
        {inboxPullIsOpen(pull) && <ChecksMark checks={pull.checks} />}
      </button>
    );
  };

  const stackMark = (stack: InboxPullStack) => (
    <button type="button" className="ib-prs-mark" aria-label={`Open the stack: ${stack.layers.length} layers`} title={`Open the stack: ${stack.layers.length} layers`} onClick={() => props.onOpenStack(stack)} data-pr-stack-mark="">
      <Icon name="layers" size={14} />
    </button>
  );

  const strip = (stack: InboxPullStack) => {
    const counts = stackCounts(stack);
    const dim = !!q && !stack.layers.some((l) => matchesQuery(l, q));
    const bottomOpen = stack.layers.find(inboxPullIsOpen) ?? stack.layers[0]!;
    const many = stack.layers.length > 24;
    return (
      <button
        key={stack.id}
        type="button"
        className="ib-prs-strip"
        data-dim={dim ? '' : undefined}
        data-pr-strip={stack.id}
        onClick={() => props.onOpenStack(stack)}
        aria-label={`Stack of ${stack.layers.length}, ${counts.open} open${counts.needYou ? `, ${counts.needYou} need you` : ''}${counts.failing ? `, ${counts.failing} failing` : ''}: ${bottomOpen.title}. Open the stack.`}
        title={bottomOpen.title}
      >
        <Icon name="layers" size={14} />
        <span className="ib-prs-strip-t">
          Stack of {stack.layers.length} · {counts.open} open
        </span>
        <span className="ib-prs-strip-marks" data-many={many ? '' : undefined} style={{ '--n': stack.layers.length } as CSSProperties} aria-hidden="true">
          {stack.layers.map((l) => (
            <i key={l.key} data-state={l.state} data-you={needsYou(l) ? '' : undefined} data-fail={inboxPullIsOpen(l) && l.checks === 'failure' ? '' : undefined} />
          ))}
        </span>
        {counts.needYou > 0 && <span className="ib-prs-you">{counts.needYou} need you</span>}
        {counts.failing > 0 && <span className="ib-prs-bad">{counts.failing} failing</span>}
        <Icon name="chevR" size={13} />
      </button>
    );
  };

  const unit = (stack: InboxPullStack) => {
    if (!isStack(stack)) return tile(stack.layers[0]!, stack, false);
    if (foldsToStrip(stack)) return strip(stack);
    return (
      <span key={stack.id} className="ib-prs-stack" role="group" aria-label={`Stack of ${stack.layers.length}`} data-pr-stack={stack.id}>
        {stackMark(stack)}
        {stack.layers.map((layer, i) => (
          <span key={layer.key} className="ib-prs-join">
            {i > 0 && <i className="ib-prs-link" aria-hidden="true" />}
            {tile(layer, stack, true)}
          </span>
        ))}
      </span>
    );
  };

  const head = sheet?.head;
  const closed = model ? closedLinks(model.hosts) : [];
  const empty = model && sheet && sheet.sections.length === 0 ? pullsEmptyWords(model, notices) : null;
  const visible = sheet ? sheet.sections.filter((s) => !q || s.units.some((u) => u.layers.some((l) => matchesQuery(l, q)))) : [];

  let body: ReactNode;
  if (!model && props.error) {
    body = (
      <div className="ib-prs-empty" role="alert">
        <h2>Couldn’t read your pull requests</h2>
        <p>{props.error}</p>
      </div>
    );
  } else if (!model || !sheet) {
    body = <div className="ib-prs-loading" aria-busy="true" />;
  } else if (view === 'merged') {
    body = (
      <>
        <p className="ib-prs-note">
          Merged in the last 14 days: yours, and the layers under your stacks.
          {closed[0] && (
            <>
              {' '}
              Older ones:{' '}
              <a href={closed[0].url.replace('is%3Aclosed', 'is%3Amerged')} target="_blank" rel="noreferrer">
                search on {hostName(closed[0].host)}
              </a>
            </>
          )}
        </p>
        {merged!.sections.map((section) => {
          const shown = section.pulls.filter((p) => !q || matchesQuery(p, q));
          if (shown.length === 0) return null;
          return (
            <section key={section.key} className="ib-prs-sec" aria-label={section.label}>
              <div className="ib-prs-sech">
                <h2>{section.label}</h2>
                <span className="ib-prs-secn">{section.pulls.length} merged</span>
              </div>
              <div className="ib-prs-tiles">{shown.map((p) => tile(p, { id: p.key, platform: p.platform, host: p.host, repo: p.repo, layers: [p], parents: { [p.key]: null }, base: p.base, open_base: p.base }, false))}</div>
            </section>
          );
        })}
        {merged!.sections.length === 0 && <p className="ib-prs-note">Nothing merged in the last 14 days.</p>}
        {merged!.quiet.length > 0 && merged!.sections.length > 0 && <p className="ib-prs-note">Nothing merged in {joinOr(merged!.quiet)}</p>}
      </>
    );
  } else if (empty) {
    body = (
      <div className="ib-prs-empty">
        <h2>{empty.kind === 'nothing' ? 'Nothing open' : empty.head}</h2>
        {(empty.kind === 'nothing' ? ['Pull requests that ask for your review, that are yours or that are assigned to you show here, from any repository, with every open one in your projects.'] : empty.lines).map(
          (line) => (
            <p key={line}>{line}</p>
          ),
        )}
      </div>
    );
  } else {
    body = (
      <>
        {visible.map((section) => (
          <section key={section.key} className="ib-prs-sec" aria-label={section.label} data-pr-repo={section.key}>
            <div className="ib-prs-sech">
              <h2 title={`${section.host}/${section.repo}`}>{section.label}</h2>
              {section.outside && <span className="ib-prs-outside">not a project</span>}
              <span className="ib-prs-secn">
                {section.open} open{section.landedWeek > 0 ? ` · ${section.landedWeek} landed this week` : ''}
              </span>
            </div>
            <div className="ib-prs-tiles">{section.units.map(unit)}</div>
          </section>
        ))}
        {q && visible.length === 0 && <p className="ib-prs-note">No open pull request matches “{q}”.</p>}
      </>
    );
  }

  const mode = props.mode ?? 'page';
  const popover = pop && (
    <TilePopover
      key={pop.pull.key}
      pop={pop}
      phone={phone}
      now={now}
      onEnter={() => clearTimers()}
      onLeave={() => {
        if (pop.pinned) return;
        closeTimer.current = setTimeout(() => setPop((was) => (was && !was.pinned && !held.current ? null : was)), HOVER_CLOSE_MS);
      }}
      onClose={(returnFocus) => hide(returnFocus)}
      onOpen={() => {
        hide(false);
        props.onOpenPull(pop.pull, pop.stack);
      }}
      onOpenStack={() => {
        hide(false);
        props.onOpenStack(pop.stack);
      }}
      onHold={(hold) => {
        held.current = hold;
      }}
      onMerged={(key) => {
        held.current = false;
        setMergedHere((was) => new Map(was).set(key, new Date().toISOString()));
        hide(false);
        props.onMerged();
      }}
    />
  );
  return (
    <section className={`ib-prs${mode === 'pane' ? ' ib-pane ib-prs-inpane' : ''}`} aria-labelledby={titleId} data-prs-page="" data-phone={phone ? '' : undefined}>
      <div className="ib-prs-scroll">
        <header className="ib-prs-head">
          <div className="ib-prs-title">
            {props.onBack ? (
              <button type="button" className="ib-iconbtn" onClick={props.onBack} aria-label="Back to Reviews" data-prs-back="">
                <Icon name="chevL" size={18} />
              </button>
            ) : mode === 'page' ? (
              <SidebarTrigger />
            ) : null}
            <h1 id={titleId} tabIndex={-1}>
              Pull requests
            </h1>
          </div>
          {/* Nothing listed: the empty words below say so; "0 open in 0 repositories" would only repeat them. */}
          {head && (head.open > 0 || head.landedWeek > 0) && (
            <p className="ib-prs-sum" data-pr-summary="">
              <span>
                {head.open} open in {head.repos} {head.repos === 1 ? 'repository' : 'repositories'}
              </span>
              {head.needYou > 0 && <span className="ib-prs-you">{head.needYou} need you</span>}
              {head.failing > 0 && <span className="ib-prs-bad">{head.failing} with failing checks</span>}
              {head.landedWeek > 0 && <span>{head.landedWeek} landed this week</span>}
            </p>
          )}
        </header>
        <div className="ib-prs-bar">
          <label className="ib-prs-field">
            <Icon name="search" size={14} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={phone ? 'Filter by title, author, repo or #' : 'Filter by title, author, repository or number'}
              aria-label="Filter pull requests"
              spellCheck={false}
              autoComplete="off"
              data-pr-filter=""
            />
          </label>
          <div className="ib-seg ib-prs-seg" role="group" aria-label="State">
            {(['open', 'merged'] as const).map((v) => (
              <button key={v} type="button" className="ib-seg-o" data-on={view === v ? '' : undefined} aria-pressed={view === v} onClick={() => props.onView(v)} data-pr-view={v}>
                {v === 'open' ? 'Open' : 'Merged'}
              </button>
            ))}
          </div>
          {closed.map((link) => (
            <a key={link.host} className="ib-prs-closed" href={link.url} target="_blank" rel="noreferrer">
              {link.label}
              <Icon name="external" size={12} />
            </a>
          ))}
        </div>
        {model && notices.length > 0 && !empty && (
          <div className="ib-prs-notices">
            {notices.map((n) => (
              <p key={n.key}>
                {n.line}
                {n.link && (
                  <>
                    {' '}
                    <a href={n.link.href} target="_blank" rel="noreferrer">
                      {n.link.label}
                    </a>
                  </>
                )}
              </p>
            ))}
          </div>
        )}
        {model && props.error && <p className="ib-prs-notices">Couldn’t read the list again: {props.error} Showing the last read.</p>}
        <div className="ib-prs-body">{body}</div>
      </div>
      {popover}
    </section>
  );
}

function joinOr(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

const MERGE_WORDS = ['Merge', 'Confirm merge', 'Merging…', 'Merged'] as const;

type MergePhase = { at: 'idle' } | { at: 'confirm' } | { at: 'merging' } | { at: 'done' } | { at: 'failed'; message: string };

function TilePopover(props: {
  pop: Pop;
  phone: boolean;
  now: number;
  onEnter: () => void;
  onLeave: () => void;
  onClose: (returnFocus: boolean) => void;
  onOpen: () => void;
  onOpenStack: () => void;
  /** A merge under way or done: keep the popover open (true), or let it go again (false). */
  onHold: (hold: boolean) => void;
  /** The merge went and "Merged" was shown for `MERGED_SHOWN_MS`: close, and the PR leaves Open. */
  onMerged: (key: string) => void;
}) {
  const { pop, phone, now } = props;
  const { pull, stack } = pop;
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const [merge, setMerge] = useState<MergePhase>({ at: 'idle' });
  const labelId = useId();
  const pinned = pop.pinned || phone;

  // Below the tile, or above it when there is no room; never past the window's edges.
  useLayoutEffect(() => {
    if (phone) return;
    const placeIt = () => {
      const el = ref.current;
      if (!el || !pop.anchor.isConnected) return;
      const rect = pop.anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
      const below = rect.bottom + 6;
      const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, rect.top - 6 - h);
      setPlace({ top, left });
    };
    placeIt();
    window.addEventListener('resize', placeIt);
    window.addEventListener('scroll', placeIt, true);
    return () => {
      window.removeEventListener('resize', placeIt);
      window.removeEventListener('scroll', placeIt, true);
    };
  }, [pop.anchor, phone]);

  // Pinned: its first action takes focus; Escape closes it back to the tile; a click outside closes it.
  useEffect(() => {
    if (!pinned) return;
    ref.current?.querySelector<HTMLElement>('[data-pr-pop-first]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        props.onClose(true);
      }
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || pop.anchor.contains(target)) return;
      props.onClose(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned, pop.anchor]);

  const you = needsYou(pull);
  const open = inboxPullIsOpen(pull);
  const canMerge = open && mergeOffered(pull);
  const checks = checksLabel(pull.checks);
  const status = statusParts(pull, now);
  const layerAt = isStack(stack) ? stack.layers.findIndex((l) => l.key === pull.key) + 1 : 0;

  const pressMerge = () => {
    if (merge.at === 'idle') {
      setMerge({ at: 'confirm' });
      return;
    }
    if (merge.at !== 'confirm' || !pull.head_sha) return;
    setMerge({ at: 'merging' });
    props.onHold(true);
    inboxApi.pullMerge(pull.key, pull.head_sha).then(
      () => {
        setMerge({ at: 'done' });
        // Long enough to read; the timer runs on if the popover is closed meanwhile, so the PR still leaves Open.
        setTimeout(() => props.onMerged(pull.key), MERGED_SHOWN_MS);
      },
      (cause: unknown) => {
        props.onHold(false);
        setMerge({ at: 'failed', message: cause instanceof Error ? cause.message : 'The merge didn’t go.' });
      },
    );
  };

  const tabIndex = pinned ? undefined : -1;
  // The confirm hint and a refusal: under the buttons on a desktop (the popover grows down, the buttons stay); above
  // them on a phone's bottom sheet (it grows up, the buttons stay at the bottom).
  const notes = (
    <>
      {merge.at === 'confirm' && (
        <p className="ib-prpop-hint" id={`${labelId}-confirm`}>
          Click again to merge {inboxPullLabel(pull)} into {pull.base}.
        </p>
      )}
      {merge.at === 'failed' && (
        <p className="ib-prpop-err" role="alert">
          {merge.message}
        </p>
      )}
    </>
  );
  return (
    <>
      {phone && <div className="ib-prpop-scrim" onClick={() => props.onClose(false)} aria-hidden="true" />}
      <div
        ref={ref}
        className="ib-prpop"
        role="dialog"
        aria-labelledby={labelId}
        data-pr-pop={pull.key}
        data-phone={phone ? '' : undefined}
        data-pinned={pinned ? '' : undefined}
        style={phone ? undefined : { top: place?.top ?? -9999, left: place?.left ?? -9999 }}
        onPointerEnter={props.onEnter}
        onPointerLeave={props.onLeave}
      >
        <div className="ib-prpop-top">
          <span className="ib-prpop-n">{inboxPullLabel(pull)}</span>
          <span className="ib-prpop-state" data-state={pull.state}>
            {pull.state === 'open' ? 'Open' : pull.state === 'draft' ? 'Draft' : pull.state === 'merged' ? 'Merged' : 'Closed'}
          </span>
          <span className="ib-prpop-repo" title={`${pull.host}/${pull.repo}`}>
            {pull.repo}
          </span>
          {phone && (
            <button type="button" className="ib-iconbtn ib-prpop-x" aria-label="Close" onClick={() => props.onClose(true)}>
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
        <p className="ib-prpop-title" id={labelId} dir="auto">
          {pull.title || inboxPullLabel(pull)}
        </p>
        <p className="ib-prpop-meta">
          {pull.author && <span>{pull.mine ? 'You' : <Person login={pull.author} host={pull.host} />}</span>}
          <span>updated {agoWords(pull.updated_at, now)}</span>
          <span className="ib-prpop-diff">
            +{pull.additions.toLocaleString()} −{pull.deletions.toLocaleString()}
          </span>
        </p>
        <p className="ib-prpop-status" data-tone={you ? 'you' : pull.checks === 'failure' && open ? 'bad' : undefined}>
          <Named words={facesOnce(status)} host={pull.host} />
        </p>
        {open && checks && (
          <p className="ib-prpop-checks">
            <ChecksMark checks={pull.checks} />
            {checks.replace(/^./, (c) => c.toUpperCase())}
          </p>
        )}
        {layerAt > 0 && (
          <button type="button" className="ib-prpop-stack" onClick={props.onOpenStack} tabIndex={tabIndex} data-pr-pop-stack="">
            <Icon name="layers" size={13} />
            Layer {layerAt} of a stack of {stack.layers.length}
            <span className="ib-prpop-go">
              Open the stack <Icon name="chevR" size={12} />
            </span>
          </button>
        )}
        {phone && notes}
        <div className="ib-prpop-acts">
          <button type="button" className="ib-prpop-btn" data-primary="" onClick={props.onOpen} tabIndex={tabIndex} data-pr-pop-first="" data-pr-pop-open="">
            Open
          </button>
          <a className="ib-prpop-btn" href={pull.url} target="_blank" rel="noreferrer" tabIndex={tabIndex} data-pr-pop-forge="">
            Open on {forgeName(pull)}
            <Icon name="external" size={12} />
          </a>
          {/* Refused by the forge: its words say why, and Merge is not offered again until the list says otherwise. One
              slot as wide as its widest word, so Merge, Confirm merge, Merging… and Merged stay where the pointer is. */}
          {canMerge && merge.at !== 'failed' && (
            <span className="ib-prpop-mslot" data-pr-pop-mslot="">
              {MERGE_WORDS.map((words) => (
                <span key={words} className="ib-prpop-btn ib-prpop-msize" aria-hidden="true">
                  {words === 'Merged' && <Icon name="check" size={13} />}
                  {words}
                </span>
              ))}
              {merge.at === 'done' ? (
                <span className="ib-prpop-btn ib-prpop-merged" role="status" data-pr-pop-merged="">
                  <Icon name="check" size={13} />
                  Merged
                </span>
              ) : (
                <button
                  type="button"
                  className="ib-prpop-btn"
                  data-merge={merge.at}
                  onClick={pressMerge}
                  disabled={merge.at === 'merging'}
                  tabIndex={tabIndex}
                  data-pr-pop-merge=""
                  aria-describedby={merge.at === 'confirm' ? `${labelId}-confirm` : undefined}
                >
                  {merge.at === 'confirm' ? 'Confirm merge' : merge.at === 'merging' ? 'Merging…' : 'Merge'}
                </button>
              )}
            </span>
          )}
        </div>
        {!phone && notes}
      </div>
    </>
  );
}
