/**
 * A project's drawing in Reviews (approval "system-inbox", screens 4a and 4b): the pane that says "Pick a pull
 * request" shows the project's drawing (`SystemView` from `@plannotator/system/react`), and under it "Open PRs that
 * change this": each open PR of the project's repo whose changed files touch a drawn part (the package's gate, on
 * the server), with the parts it changes. The drawing marks those parts amber at rest, each tagged with its PRs
 * (`touches`, "PR 2850"). A row opens today's PR pane. "Open full window" gives the same drawing the whole window,
 * the PRs beside it; "‹ Reviews", at the start of the drawing's bar (`leading`), or Escape goes back. A phone draws
 * it in the list's place.
 *
 * The drawing's single-key shortcuts stay off (`keys={false}`, approval "system-navigation"). No shortcut of its own:
 * Escape backs out one layer (App.tsx: the full window, then the pane), as everywhere in the window.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { SystemView, type Reading } from '@plannotator/system/react';
import type { GateResult, SystemModel, Touch } from '@plannotator/system';
import type { SystemProjectRow, SystemPullsAnswer } from '@plannotator/core/inbox-system';
import type { InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { plural } from '@plannotator/core/inbox-format';
import { inboxApi } from '../api';
import { Icon } from '../icons';
import { findStack, inboxPullLabel, pullGroups, rowMeta } from '../pulls/model';
import { stackLink } from '../pulls/topology';
import { openSystemSetup } from './opener';

/** Simple or Full, kept for the window's life: the Inbox remembers the reading, the drawing only draws it. */
let lastReading: Reading = 'full';

export interface SystemPaneProps {
  /** The project's id. */
  project: string;
  /** The sheet on screen (`&sheet=`), or null for the landing sheet. */
  sheet: string | null;
  /** The drawing has the whole window (`&full=1`). */
  full: boolean;
  phone: boolean;
  /** The Reviews list's answer: the rows read their titles and agents from it. */
  pulls: InboxPullsAnswer | null;
  onSheet: (sheet: string) => void;
  onFull: (full: boolean) => void;
  onClose: () => void;
  /** Open a PR's pane (any layer's key). */
  onOpenStack: (key: string) => void;
  /** Tests: the reads. */
  api?: { drawing: typeof inboxApi.systemDrawing; pulls: typeof inboxApi.systemPulls };
}

type Drawing = { project: SystemProjectRow; model: SystemModel | null };
/** The server's answer: each PR's touched parts and lines only (what the drawing marks), not the gate's whole result. */
type PullTouches = SystemPullsAnswer<Pick<GateResult, 'touched'>>;

/** The drawing's marks at rest: one per open PR that touches it, labelled "PR <number>" with the parts and lines it touches. */
export function touchesOf(answer: PullTouches | null): Touch[] {
  return (answer?.pulls ?? []).map((touch) => ({
    label: `PR ${touch.number}`,
    change: { touched: touch.change.touched, wake: false, why: [], ignored: [] },
  }));
}

/** "Desktop app", "Desktop app and The Inbox", "A, B and 2 more". */
export function partsWords(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

export function SystemPane({ project, sheet, full, phone, pulls, onSheet, onFull, onClose, onOpenStack, api }: SystemPaneProps) {
  const read = api ?? { drawing: inboxApi.systemDrawing, pulls: inboxApi.systemPulls };
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The last answer, with the project it is for: kept while the next read is out, so the marks (and the drawing's
  // zoom) don't drop each time the Reviews list is read again; another project's answer is not this one's.
  const [answer, setAnswer] = useState<{ project: string; touches: PullTouches } | null>(null);
  const touches = answer?.project === project ? answer.touches : null;
  // One array per answer: the drawing keeps its sheet while the same PRs mark it.
  const marks = useMemo(() => touchesOf(touches), [touches]);
  const [reading, setReading] = useState<Reading>(lastReading);
  useEffect(() => {
    let live = true;
    setDrawing(null);
    setError(null);
    read
      .drawing(project)
      .then((got) => live && setDrawing({ project: got.project, model: got.model }))
      .catch((cause: unknown) => live && setError(cause instanceof Error ? cause.message : 'The drawing could not be read.'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);
  // The PRs that change it: read again when the Reviews list is (its PRs and their heads are what the server reads).
  const listedAt = pulls?.fetched_at ?? null;
  useEffect(() => {
    let live = true;
    read
      .pulls(project)
      .then((next) => live && setAnswer({ project, touches: next }))
      // A failed read keeps this project's last answer; with none yet, no PR changes it.
      .catch(() => live && setAnswer((last) => (last?.project === project ? last : { project, touches: { pulls: [], unread: 0 } })));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, listedAt]);

  const name = drawing?.project.name ?? '';
  const pickReading = (next: Reading) => {
    lastReading = next;
    setReading(next);
  };
  const back = useRef<HTMLButtonElement>(null);
  const pane = useRef<HTMLElement>(null);
  const wasFull = useRef(full);
  // The drawing on screen: its bar holds "‹ Reviews" (else a strip of its own above the note does).
  const viewShown = !error && !!drawing?.model;
  useEffect(() => {
    if (full) back.current?.focus({ preventScroll: true });
    else if (wasFull.current && !phone) {
      // Back from the full window: focus returns to its way in ("Open full window"), else the pane.
      const el = pane.current;
      const way = el ? Array.from(el.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Open full window') : null;
      (way ?? el)?.focus({ preventScroll: true });
    }
    wasFull.current = full;
  }, [full, phone, viewShown]);
  // The full window covers the page: what it covers can't take the focus either (Tab stays in the drawing and its PRs).
  useEffect(() => {
    if (!full || phone || !pane.current) return;
    return inertAround(pane.current);
  }, [full, phone]);

  const body = (layout: 'pane' | 'window') => {
    if (error) {
      return (
        <div className="ib-sysp-note" role="alert">
          {error}
        </div>
      );
    }
    if (!drawing) return <div className="ib-sysp-note">Opening the drawing…</div>;
    if (!drawing.model) {
      return (
        <div className="ib-sysp-note" data-system-pane-none={drawing.project.state}>
          <p>{drawing.project.state === 'broken' ? 'This drawing can’t be read. Set the project up again to redraw it.' : `${name} is not drawn yet.`}</p>
          {drawing.project.repo && (
            <button type="button" className="ib-btn" onClick={() => openSystemSetup(project)}>
              Set up
            </button>
          )}
        </div>
      );
    }
    return (
      <SystemView
        key={project}
        model={drawing.model}
        project={name}
        sheet={sheet ?? undefined}
        reading={reading}
        layout={layout}
        keys={false}
        onNavigate={onSheet}
        onReading={pickReading}
        touches={marks}
        leading={full || phone ? backButton : undefined}
        onOpenFull={layout === 'pane' && !phone ? () => onFull(true) : undefined}
        // In the pane, the close button and Escape on the landing sheet close the drawing; a full window's Escape
        // goes back to the pane (App.tsx), and its way back is "Reviews".
        onClose={layout === 'pane' && !phone ? onClose : undefined}
      />
    );
  };
  // "‹ Reviews": the full window's way back to the pane, a phone's back to the list. In the drawing's bar when it shows.
  const backButton = (
    <button ref={back} type="button" className="ib-sysfull-back" onClick={() => (phone ? onClose() : onFull(false))} data-system-back="">
      <Icon name="back" size={15} />
      Reviews
    </button>
  );
  const rows = drawing?.model && drawing.project.repo ? <SystemPulls touches={touches} pulls={pulls} onOpenStack={onOpenStack} /> : null;

  if (full || phone) {
    return (
      <section ref={pane} tabIndex={-1} className={`ib-sysfull${phone ? ' ib-sysfull-phone' : ''}`} aria-label={name ? `System: ${name}` : 'System'} data-system-full={phone ? 'phone' : ''} data-system-pane={project}>
        {!viewShown && <div className="ib-sysfull-top">{backButton}</div>}
        <div className="ib-sysfull-body">
          <div className="ib-sysfull-draw">{body(phone ? 'pane' : 'window')}</div>
          {rows && <aside className="ib-sysfull-aside">{rows}</aside>}
        </div>
      </section>
    );
  }
  return (
    <section ref={pane} tabIndex={-1} className="ib-pane ib-syspane" aria-label={name ? `System: ${name}` : 'System'} data-system-pane={project}>
      <div className="ib-syspane-draw">{body('pane')}</div>
      {rows}
    </section>
  );
}

/**
 * Makes everything around `el` inert (each sibling of it and of its ancestors up to the body), leaving live regions
 * so a toast is still heard; gives back exactly what it set.
 */
export function inertAround(el: HTMLElement): () => void {
  const set: HTMLElement[] = [];
  for (let node: HTMLElement | null = el; node && node !== document.body && node.parentElement; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert || sibling.matches('[aria-live], [role="status"], [role="alert"], script, style')) continue;
      sibling.inert = true;
      set.push(sibling);
    }
  }
  return () => {
    for (const sibling of set) sibling.inert = false;
  };
}

/** "Open PRs that change this": one row per open PR whose files touch the drawing; a row opens the PR's pane. */
function SystemPulls({ touches, pulls, onOpenStack }: { touches: PullTouches | null; pulls: InboxPullsAnswer | null; onOpenStack: (key: string) => void }) {
  const groups = useMemo(() => (pulls ? pullGroups(pulls, null) : null), [pulls]);
  const rows = (touches?.pulls ?? []).flatMap((touch) => {
    const item = groups ? findStack(groups, touch.key) : null;
    const pull = item?.stack.layers.find((l) => l.key === touch.key) ?? pulls?.pulls.find((p) => p.key === touch.key) ?? null;
    if (!pull) return [];
    const meta = item ? rowMeta(item, stackLink(item.stack, pulls!.links)) : null;
    return [{ touch, pull, also: meta?.agent?.words ?? (item?.stack.layers.length === 1 ? meta?.rest : null) ?? null }];
  });
  return (
    <section className="ib-sysprs" aria-labelledby="ib-sysprs-h" data-system-pulls="">
      <h3 id="ib-sysprs-h" className="ib-sysprs-h">
        Open PRs that change this
      </h3>
      {touches === null ? (
        <p className="ib-sysprs-quiet">Reading the open pull requests…</p>
      ) : rows.length === 0 ? (
        <p className="ib-sysprs-quiet" data-system-pulls-none="">
          No open pull request changes it.
        </p>
      ) : (
        <ul className="ib-sysprs-list">
          {rows.map(({ touch, pull, also }) => (
            <li key={touch.key}>
              <button type="button" className="ib-sysprs-row" onClick={() => onOpenStack(touch.key)} data-system-pull={touch.key}>
                <span className="ib-sysprs-num">{inboxPullLabel(pull)}</span>
                <span className="ib-sysprs-main">
                  <span className="ib-sysprs-t" dir="auto">
                    {pull.title}
                  </span>
                  <span className="ib-sysprs-l">
                    changes{' '}
                    <span className="ib-sysprs-parts" data-system-pull-parts="">
                      {partsWords(touch.parts.map((p) => p.name))}
                    </span>
                    {also && ` · ${also}`}
                  </span>
                </span>
                <span className="ib-sysprs-go" aria-hidden="true">
                  Open review
                  <Icon name="chevR" size={13} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {touches !== null && touches.unread > 0 && (
        <p className="ib-sysprs-quiet" data-system-pulls-unread={touches.unread}>
          {plural(touches.unread, 'pull request')} could not be read.
        </p>
      )}
    </section>
  );
}
