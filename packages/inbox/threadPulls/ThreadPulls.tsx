/**
 * A thread's PRs in the window (approval "inbox-pr-binding", 2026-11-08; the
 * look: `.product/approved/inbox-pr-binding/approval.md`, round 2's pictures).
 *
 * - The row's mark (`RowPullsMark`): the state icon of the PR still in play,
 *   at the right end of the row; several PRs put a grey count over the
 *   icon's top-right corner. Inside the row's button, so it opens its card on
 *   a pointer's hover only; keyboard users hear the state in the row's name,
 *   and reach the card from the thread's button.
 * - The thread's button (`ThreadPullsButton`), left of the artifacts icon:
 *   the same icon and count, at the shapes icon's size. Hover or a click
 *   opens the card; a click keeps it open.
 * - The card (`PullsCard`): one PR is the existing hover card (RefCardView);
 *   several are a list in the same surface, each stack base first and joined,
 *   then "Related" in the order they were added, each with its live state.
 *   The person adds a PR (its ref or link) and removes one there; a removal
 *   says so with Undo. On a touch screen a tap opens it as a bottom sheet.
 *
 * Nothing here has a keyboard shortcut.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { InboxThreadPullsAnswer, InboxThreadPullsSummary, InboxThreadPullWire } from '@plannotator/core/inbox-types';
import { parseForgeRefUrl, type ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { REF_CARD_CLOSE_MS, REF_CARD_DELAY_MS, RefCardView } from '@plannotator/ui/components/RefHoverCard';
import { loadRefCard } from '@plannotator/ui/utils/refCard';
import { inboxApi } from '../api';
import { RefMarkIcon } from '../board/RefMark';
import { labelOfKey, pullCountText, pullExtras, pullHeadline, pullsHead, pullsMarkWords, pullStateWord, pullsSummaryOf, threadPullsBus } from './model';

const WIDTH = 400;
const EDGE = 12;
const GAP = 6;

const coarse = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

/** The state icon with the count of PRs over its top-right corner (several PRs only). */
export function PullsMarkIcon({ summary, size }: { summary: InboxThreadPullsSummary; size: number }) {
  return (
    <span className="ib-prc" data-pr-count={summary.count > 1 ? pullCountText(summary.count) : undefined} data-state={summary.headline.state}>
      <RefMarkIcon kind="pr" state={summary.headline.state} size={size} />
      {summary.count > 1 && (
        <span className="ib-prc-n" aria-hidden="true">
          {pullCountText(summary.count)}
        </span>
      )}
    </span>
  );
}

/** A thread's PRs, read when `active` and again whenever a `thread_pull` line names the thread. */
export function useThreadPulls(threadId: string, active: boolean, read: (threadId: string) => Promise<InboxThreadPullsAnswer> = inboxApi.threadPulls) {
  const [state, setState] = useState<{ thread: string; answer: InboxThreadPullsAnswer | null }>({ thread: threadId, answer: null });
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    read(threadId)
      .then((answer) => {
        // Only the newest read lands.
        if (mine === seq.current) setState({ thread: threadId, answer });
      })
      .catch(() => {
        // A failed read keeps what shows; the next event reads again.
      });
  }, [threadId, read]);
  useEffect(() => {
    if (!active) return;
    load();
    return threadPullsBus.subscribe((change) => {
      if (change === '*' || change === threadId) load();
    });
  }, [active, threadId, load]);
  const answer = state.thread === threadId ? state.answer : null;
  return { answer, setAnswer: (next: InboxThreadPullsAnswer) => setState({ thread: threadId, answer: next }), reload: load };
}

/** The card's open state and its pointer rules: a hover rests REF_CARD_DELAY_MS, leaving closes after REF_CARD_CLOSE_MS. */
function usePopover() {
  const [open, setOpen] = useState<{ anchor: HTMLElement; sheet: boolean; pinned: boolean } | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const clear = () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };
  useEffect(() => clear, []);
  const scheduleClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen((now) => (now && !now.pinned && !now.sheet ? null : now)), REF_CARD_CLOSE_MS);
  };
  const hover = {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'touch' || coarse()) return;
      const el = e.currentTarget;
      clear();
      openTimer.current = window.setTimeout(() => setOpen((now) => now ?? { anchor: el, sheet: false, pinned: false }), REF_CARD_DELAY_MS);
    },
    onPointerLeave: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'touch' || coarse()) return;
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      openTimer.current = null;
      scheduleClose();
    },
  };
  const cardHover = {
    onPointerEnter: () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    onPointerLeave: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'touch') scheduleClose();
    },
  };
  const close = () => {
    clear();
    setOpen(null);
  };
  return { open, setOpen, hover, cardHover, close };
}

/** The floating card (or the sheet), beside its anchor: below and right-aligned, above when there is no room. */
function PullsPopover({ anchor, sheet, label, onClose, cardHover, children }: { anchor: HTMLElement; sheet: boolean; label: string; onClose: (restoreFocus?: boolean) => void; cardHover: ReturnType<typeof usePopover>['cardHover']; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (sheet) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const h = ref.current?.offsetHeight ?? 200;
      const w = Math.min(WIDTH, window.innerWidth - EDGE * 2);
      const left = Math.max(EDGE, Math.min(r.right - w, window.innerWidth - w - EDGE));
      let top = r.bottom + GAP;
      if (top + h > window.innerHeight - EDGE) top = Math.max(EDGE, r.top - GAP - h);
      setPos({ left, top });
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (ref.current) observer?.observe(ref.current);
    return () => observer?.disconnect();
  }, [anchor, sheet]);
  // Escape closes (focus back on the anchor), and so do a press outside, a scroll outside and a resize.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    const onScroll = (e: Event) => {
      if (!sheet && !ref.current?.contains(e.target as Node)) onClose();
    };
    const onResize = () => onClose();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose, sheet]);
  // Inside a row's button the card's clicks and keys must never reach the row (it would open the thread).
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const surface = (
    <div
      ref={ref}
      id={`ib-prpop-${id.replace(/[^A-Za-z0-9_-]/g, '')}`}
      role="dialog"
      aria-label={label}
      className={`ib-prpop fixed z-[120] flex flex-col overflow-hidden border border-border bg-popover text-popover-foreground shadow-2xl ${sheet ? 'ib-prpop-sheet' : 'rounded-xl'}`}
      data-pr-popover=""
      data-sheet={sheet ? '' : undefined}
      style={sheet ? undefined : { width: Math.min(WIDTH, window.innerWidth - EDGE * 2), left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: 'min(560px, calc(100dvh - 24px))' }}
      onPointerEnter={cardHover.onPointerEnter}
      onPointerLeave={cardHover.onPointerLeave}
      onClick={stop}
      onPointerDown={stop}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') e.stopPropagation();
      }}
    >
      {sheet && <div aria-hidden="true" className="ib-prpop-grab" />}
      {children}
    </div>
  );
  return createPortal(
    sheet ? (
      <>
        <div
          className="ib-prpop-scrim"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        />
        {surface}
      </>
    ) : (
      surface
    ),
    anchor.closest<HTMLElement>('dialog[open], .pn-inbox') ?? document.body,
  );
}

/** One PR's full hover card when the forge answers; else the card from what the Inbox knows. */
function OnePull({ pull, sheet, onClose }: { pull: InboxThreadPullWire; sheet: boolean; onClose: () => void }) {
  const target = parseForgeRefUrl(pull.url);
  const [result, setResult] = useState<ForgeRefCardResult | null | undefined>(undefined);
  useEffect(() => {
    if (!target) return;
    let live = true;
    loadRefCard(pull.url, target)
      .then((answer) => live && setResult(answer))
      .catch(() => live && setResult(null));
    return () => {
      live = false;
    };
    // The card is per PR; its url says which.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pull.url]);
  if (!target) return null;
  // No forge answer (no gh or glab, signed out, a phone): the card from the Inbox's own state, never a failure line.
  const known: ForgeRefCardResult = {
    ok: true,
    fetchedAt: Date.now(),
    data: {
      platform: pull.platform,
      kind: 'pull',
      repo: pull.repo,
      number: pull.number,
      url: pull.url,
      title: pull.title ?? `${pull.repo}${pull.label}`,
      state: pull.state === 'unknown' ? 'open' : pull.state,
      author: null,
      createdAt: pull.added_at,
      updatedAt: pull.read_at ?? pull.added_at,
      closedAt: null,
      labels: [],
      assignees: [],
      comments: 0,
      body: '',
      bodyCut: false,
      lastComment: null,
      linked: [],
    },
  };
  const shown = result?.ok ? result : result === undefined ? undefined : pull.state === 'unknown' ? result : known;
  return <RefCardView target={target} href={pull.url} result={shown} sheet={sheet} onClose={onClose} />;
}

function PullRow({ pull, oneRepo, onRemove }: { pull: InboxThreadPullWire; oneRepo: boolean; onRemove: (pull: InboxThreadPullWire) => void }) {
  const extras = pullExtras(pull);
  return (
    <li className="ib-prpop-row" data-pr-row={pull.ref} data-state={pull.state}>
      <a className="ib-prpop-link" href={pull.url} target="_blank" rel="noopener noreferrer">
        <span className="ib-prpop-ic">
          <RefMarkIcon kind="pr" state={pull.state} size={16} />
        </span>
        <span className="ib-prpop-main">
          <span className="ib-prpop-t">
            <span className="ib-prpop-title">{pull.title ?? pull.ref}</span> <span className="ib-prpop-num">{pull.label}</span>
          </span>
          <span className="ib-prpop-sub">
            <span className={`ib-prpop-st ib-prpop-st-${pull.state}`}>{pullStateWord(pull.state)}</span>
            {!oneRepo && <span> · {pull.repo.split('/').at(-1)}</span>}
            {extras.map((word) => (
              <span key={word} className={word === 'checks failing' ? 'ib-prpop-bad' : undefined}>
                {' · '}
                {word}
              </span>
            ))}
          </span>
        </span>
      </a>
      <button type="button" className="ib-prpop-rm" aria-label={`Remove ${pull.ref} from this thread`} data-pr-remove={pull.ref} onClick={() => onRemove(pull)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </li>
  );
}

/** Several PRs: each stack base first and joined, then the related ones in the order they were added. */
function PullsList({ answer, onRemove }: { answer: InboxThreadPullsAnswer; onRemove: (pull: InboxThreadPullWire) => void }) {
  const head = pullsHead(answer);
  const byKey = new Map(answer.pulls.map((pull) => [pull.pull, pull]));
  const only = answer.groups.length === 1;
  const forges = new Set(answer.pulls.map((pull) => pull.platform));
  return (
    <div className="ib-prpop-list" data-pr-list="">
      <div className="ib-prpop-head">
        <span className="ib-prpop-repo">{head.repo}</span>
        <span className="ib-prpop-n">{head.count}</span>
      </div>
      {answer.groups.map((group, index) => (
        <section key={`${group.kind}-${index}`} className="ib-prpop-group" data-pr-group={group.kind} aria-label={group.kind === 'stack' ? `Stack of ${group.pulls.length}` : 'Related'}>
          {!only && <div className="ib-prpop-gh">{group.kind === 'stack' ? `Stack of ${group.pulls.length}` : 'Related'}</div>}
          <ol className={`ib-prpop-rows${group.kind === 'stack' ? ' ib-prpop-stack' : ''}`}>
            {group.pulls.flatMap((key) => byKey.get(key) ?? []).map((pull) => (
              <PullRow key={pull.pull} pull={pull} oneRepo={head.oneRepo} onRemove={onRemove} />
            ))}
          </ol>
        </section>
      ))}
      {forges.size > 1 && <div className="ib-prpop-foot">GitHub and GitLab</div>}
    </div>
  );
}

/**
 * The card's body: the PRs (one: the hover card; several: the list), then the person's edit, an Add field and,
 * after a removal, its Undo.
 */
export function PullsCard({ threadId, answer, onAnswer, sheet, onClose, adding = false }: { threadId: string; answer: InboxThreadPullsAnswer | null; onAnswer: (answer: InboxThreadPullsAnswer) => void; sheet: boolean; onClose: () => void; adding?: boolean }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState<InboxThreadPullWire | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) input.current?.focus({ preventScroll: true });
  }, [adding]);
  const change = async (body: { add?: string[]; remove?: string[] }): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      onAnswer(await inboxApi.changeThreadPulls(threadId, body));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^validation_error:\s*/, '') : 'That did not save. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const remove = async (pull: InboxThreadPullWire) => {
    if (await change({ remove: [pull.ref] })) setRemoved(pull);
  };
  const add = async () => {
    const refs = text.split(/[\s,]+/).filter(Boolean);
    if (refs.length === 0) return;
    if (await change({ add: refs })) {
      setText('');
      setRemoved(null);
    }
  };
  const pulls = answer?.pulls ?? [];
  return (
    <div className="ib-prpop-body flex min-h-0 flex-1 flex-col" data-pr-card="">
      {pulls.length === 1 ? (
        <div className="ib-prpop-one min-h-0 overflow-y-auto" data-pr-one="">
          <OnePull pull={pulls[0]!} sheet={false} onClose={onClose} />
        </div>
      ) : pulls.length > 1 ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <PullsList answer={answer!} onRemove={(pull) => void remove(pull)} />
        </div>
      ) : answer ? (
        <div className="ib-prpop-empty">No pull requests on this thread.</div>
      ) : (
        <div className="ib-prpop-empty" aria-busy="true">
          Loading…
        </div>
      )}
      <div className="ib-prpop-edit" data-pr-edit="">
        {removed && (
          <div className="ib-prpop-undo" role="status" data-pr-removed={removed.ref}>
            <span className="min-w-0 flex-1 truncate">Removed {removed.ref}</span>
            <button
              type="button"
              className="ib-prpop-tbtn"
              disabled={busy}
              onClick={() =>
                void change({ add: [removed.ref] }).then((ok) => {
                  if (ok) setRemoved(null);
                })
              }
              data-pr-undo=""
            >
              Undo
            </button>
          </div>
        )}
        <form
          className="ib-prpop-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            ref={input}
            className="ib-prpop-input"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            placeholder="Add a PR: owner/repo#123 or its link"
            aria-label="Add a pull request to this thread"
            aria-invalid={error ? true : undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            data-pr-add-input=""
          />
          <button type="submit" className="ib-prpop-tbtn" disabled={busy || text.trim() === ''} data-pr-add="">
            Add
          </button>
        </form>
        {error && (
          <div className="ib-prpop-err" role="alert" data-pr-error="">
            {error}
          </div>
        )}
        {pulls.length === 1 && (
          <button type="button" className="ib-prpop-tbtn ib-prpop-rm1" disabled={busy} onClick={() => void remove(pulls[0]!)} data-pr-remove={pulls[0]!.ref}>
            Remove {pulls[0]!.ref} from this thread
          </button>
        )}
        {sheet && (
          <button type="button" className="ib-prpop-close" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The row's mark: the state icon at the row's right end, the count over its corner for several. A pointer's hover
 * opens the card after the hover card's delay; on a touch screen a tap opens the sheet instead of the thread.
 */
export function RowPullsMark({ threadId, summary }: { threadId: string; summary: InboxThreadPullsSummary | undefined }) {
  const { open, setOpen, hover, cardHover, close } = usePopover();
  const { answer, setAnswer } = useThreadPulls(threadId, !!open);
  if (!summary) return null;
  // Once read, the card's answer is the newest (the row's summary follows on the next list read).
  const shown = (answer && pullsSummaryOf(answer)) ?? summary;
  const words = pullsMarkWords(shown, labelOfKey(shown.headline.key));
  return (
    <>
      <span
        className="ib-prmark"
        data-pr-mark={shown.headline.state}
        data-pr-n={shown.count}
        {...hover}
        onClickCapture={(e) => {
          if (!coarse()) return;
          // A tap on the mark opens its card, not the thread.
          e.preventDefault();
          e.stopPropagation();
          setOpen({ anchor: e.currentTarget, sheet: true, pinned: true });
        }}
      >
        <span className="ib-sr">{words}</span>
        <span aria-hidden="true">
          <PullsMarkIcon summary={shown} size={14} />
        </span>
      </span>
      {open && (
        <PullsPopover anchor={open.anchor} sheet={open.sheet} label={words} onClose={close} cardHover={cardHover}>
          <PullsCard threadId={threadId} answer={answer} onAnswer={setAnswer} sheet={open.sheet} onClose={close} />
        </PullsPopover>
      )}
    </>
  );
}

/**
 * The thread's button, left of the artifacts icon: the state icon only (no number), the count over its corner for
 * several. Hover opens the card; a click opens it and keeps it open (a tap: the sheet). `adding`: the thread's ⋯
 * menu asked to add a PR, so the button shows with none and its card opens on the Add field.
 */
export function ThreadPullsButton({ threadId, summary, adding = false, onAddingDone }: { threadId: string; summary: InboxThreadPullsSummary | undefined; adding?: boolean; onAddingDone?: () => void }) {
  const { open, setOpen, hover, cardHover, close } = usePopover();
  const button = useRef<HTMLButtonElement>(null);
  // The thread is open: its PRs are read now (states older than 30 s again), and on every change.
  const { answer, setAnswer } = useThreadPulls(threadId, true);
  const shown = answer ? pullsSummaryOf(answer) : summary;
  useEffect(() => {
    if (adding && button.current) setOpen({ anchor: button.current, sheet: coarse(), pinned: true });
  }, [adding, setOpen]);
  const closeAll = (restoreFocus?: boolean) => {
    close();
    onAddingDone?.();
    if (restoreFocus) button.current?.focus({ preventScroll: true });
  };
  if (!shown && !open) return null;
  const headline = answer ? pullHeadline(answer) : null;
  const words = shown ? pullsMarkWords(shown, headline?.label ?? labelOfKey(shown.headline.key)) : 'Pull requests';
  return (
    <>
      <button
        ref={button}
        type="button"
        className="ib-iconbtn ib-prbtn"
        aria-label={words}
        aria-haspopup="dialog"
        aria-expanded={!!open}
        data-pr-button={shown?.headline.state ?? 'none'}
        data-pr-n={shown?.count ?? 0}
        {...hover}
        onClick={(e) => {
          // Read now: React clears currentTarget once the handler returns, before the update runs.
          const anchor = e.currentTarget;
          setOpen((now) => (now?.pinned ? null : { anchor, sheet: coarse(), pinned: true }));
        }}
      >
        {shown ? <PullsMarkIcon summary={shown} size={17} /> : <RefMarkIcon kind="pr" state="unknown" size={17} />}
      </button>
      {open && (
        <PullsPopover anchor={open.anchor} sheet={open.sheet} label={words} onClose={closeAll} cardHover={cardHover}>
          <PullsCard threadId={threadId} answer={answer} onAnswer={setAnswer} sheet={open.sheet} onClose={() => closeAll(true)} adding={adding} />
        </PullsPopover>
      )}
    </>
  );
}
