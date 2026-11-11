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
 *   several are a list in the same surface, each stack base first and joined
 *   ("Stack of 3"), then the others under a divider with no heading, in the
 *   order they were added, each with its live state.
 *   The person adds a PR (its ref or link) and removes one there; a removal
 *   says so with Undo. On a touch screen a tap opens it as a bottom sheet.
 *
 * Nothing here has a keyboard shortcut.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { InboxThreadPullsAnswer, InboxThreadPullsSummary, InboxThreadPullWire } from '@plannotator/core/inbox-types';
import { forgePullRefShort, parseForgeRefUrl, type ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { REF_CARD_CLOSE_MS, REF_CARD_DELAY_MS, RefCardView } from '@plannotator/ui/components/RefHoverCard';
import { forgetRefCard, loadRefCard } from '@plannotator/ui/utils/refCard';
import { cardProblem } from '@plannotator/core/problem-words';
import { PullProblems, pullProblems } from './PullProblems';
import { inboxApi } from '../api';
import { INBOX_UNREACHABLE } from '../toastError';
import { RefMarkIcon } from '../board/RefMark';
import { CountBadge, countBadgeText } from '../components/CountBadge';
import { labelOfKey, pullExtras, pullHeadline, pullsHead, pullsMarkWords, pullStateWord, pullsSummaryOf, threadPullsBus } from './model';

const WIDTH = 400;
const EDGE = 12;
const GAP = 6;

const coarse = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

/** The state icon with the count of PRs over its top-right corner (several PRs only): the shared CountBadge. */
export function PullsMarkIcon({ summary, size }: { summary: InboxThreadPullsSummary; size: number }) {
  return (
    <span className="ib-prc ib-cnt-host" data-pr-count={summary.count > 1 ? countBadgeText(summary.count) : undefined} data-state={summary.headline.state}>
      <RefMarkIcon kind="pr" state={summary.headline.state} size={size} />
      {summary.count > 1 && <CountBadge count={summary.count} />}
    </span>
  );
}

/**
 * A thread's PRs, read when `active` and again whenever a `thread_pull` line (or `event: thread-pulls`) names the
 * thread. A read is aborted when a newer one starts or `active` ends (the hover left, the thread closed), so an
 * unanswered read never holds one of the browser's few connections to the Inbox. `failed`: the last read got no
 * answer and nothing is known yet; the card says so instead of loading for ever.
 */
export function useThreadPulls(
  threadId: string,
  active: boolean,
  read: (threadId: string, signal?: AbortSignal, options?: { retry?: boolean }) => Promise<InboxThreadPullsAnswer> = inboxApi.threadPulls,
) {
  const [state, setState] = useState<{ thread: string; answer: InboxThreadPullsAnswer | null; failed: boolean }>({ thread: threadId, answer: null, failed: false });
  // The person's Try again is in flight (its button says so); what shows stays until it answers, so nothing flickers.
  const [retrying, setRetrying] = useState(false);
  const seq = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const load = useCallback(
    (options?: { retry?: boolean }) => {
      const mine = ++seq.current;
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      // A new read: "Loading…" again until it answers.
      setState((now) => (now.failed ? { ...now, failed: false } : now));
      setRetrying(!!options?.retry);
      read(threadId, controller.signal, options?.retry ? { retry: true } : undefined)
        .then((answer) => {
          // Only the newest read lands.
          if (mine === seq.current) setState({ thread: threadId, answer, failed: false });
        })
        .catch(() => {
          // A read this hook aborted says nothing. A failed one keeps what shows; with nothing shown yet, the card says
          // so (hovering again, or the next event, reads again).
          if (mine !== seq.current || controller.signal.aborted) return;
          setState((now) => (now.thread === threadId && now.answer ? now : { thread: threadId, answer: null, failed: true }));
        })
        .finally(() => {
          if (inFlight.current === controller) inFlight.current = null;
          if (mine === seq.current) setRetrying(false);
        });
    },
    [threadId, read],
  );
  useEffect(() => {
    if (!active) return;
    load();
    const unsubscribe = threadPullsBus.subscribe((change) => {
      if (change === '*' || change === threadId) load();
    });
    return () => {
      unsubscribe();
      // The card closed (or the thread changed): its read is no longer wanted.
      seq.current++;
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [active, threadId, load]);
  const answer = state.thread === threadId ? state.answer : null;
  const failed = state.thread === threadId && !answer && state.failed;
  return {
    answer,
    failed,
    retrying,
    setAnswer: (next: InboxThreadPullsAnswer) => setState({ thread: threadId, answer: next, failed: false }),
    reload: () => load(),
    retry: () => load({ retry: true }),
  };
}

/**
 * The card's open state and its pointer rules: a hover rests REF_CARD_DELAY_MS; once open, the card closes
 * REF_CARD_CLOSE_MS after the pointer MOVES off both the mark and the card, or leaves the window. A leave the pointer
 * did not make (the list shifted the row from under a resting pointer: a banner or a line drawn above it) closes
 * nothing: nothing closes under the person.
 */
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
  const keep = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  // While a hover card is open, where the pointer moves decides: over the mark or the card keeps it, anywhere else
  // closes it; leaving the window closes it too.
  const hovering = !!open && !open.pinned && !open.sheet;
  const anchor = open?.anchor ?? null;
  useEffect(() => {
    if (!hovering || !anchor) return;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const t = e.target instanceof Element ? e.target : null;
      if (t && (anchor.contains(t) || t.closest('[data-pr-popover]'))) keep();
      else if (closeTimer.current === null) scheduleClose();
    };
    const onOut = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' && e.relatedTarget === null) scheduleClose();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerout', onOut);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerout', onOut);
    };
    // scheduleClose and keep only touch refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovering, anchor]);
  const hover = {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'touch' || coarse()) return;
      const el = e.currentTarget;
      clear();
      openTimer.current = window.setTimeout(() => setOpen((now) => now ?? { anchor: el, sheet: false, pinned: false }), REF_CARD_DELAY_MS);
    },
    onPointerLeave: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'touch' || coarse()) return;
      // Not open yet: the hover did not rest, nothing opens. Open: the pointer's next move decides (above).
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      openTimer.current = null;
    },
  };
  const cardHover = {
    onPointerEnter: keep,
    onPointerLeave: () => undefined,
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
    // The card stays with its row when the list moves it (a banner or a line drawn above): checked each frame while open.
    let last = `${anchor.getBoundingClientRect().top},${anchor.getBoundingClientRect().right}`;
    let frame = requestAnimationFrame(function follow() {
      const r = anchor.getBoundingClientRect();
      const now = `${r.top},${r.right}`;
      if (now !== last) {
        last = now;
        place();
      }
      frame = requestAnimationFrame(follow);
    });
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
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

/**
 * One PR: the full hover card when the forge answers (its loading state meanwhile); else (no gh or glab, signed
 * out, a phone) the list's row from what the Inbox knows, never a card that makes up a description or comments.
 */
function OnePull({ pull, sheet, onClose, onRetry, retrying }: { pull: InboxThreadPullWire; sheet: boolean; onClose: () => void; onRetry?: () => void; retrying?: boolean }) {
  const target = parseForgeRefUrl(pull.url);
  const [result, setResult] = useState<ForgeRefCardResult | null | undefined>(undefined);
  const problemCode = pull.problem?.code ?? null;
  const lastCode = useRef(problemCode);
  useEffect(() => {
    if (!target) return;
    // The PR's problem changed (signed in since, a Try again): a failure kept for this ref is asked again.
    if (lastCode.current !== problemCode) forgetRefCard(target);
    lastCode.current = problemCode;
    let live = true;
    loadRefCard(pull.url, target)
      .then((answer) => live && setResult(answer))
      .catch(() => live && setResult(null));
    return () => {
      live = false;
    };
    // The card is per PR; its url says which.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pull.url, problemCode]);
  // The full card once the forge answers. While it loads, its skeleton, unless the Inbox already knows why the PR
  // can't be read: then what is known and why show at once, never a skeleton that turns into a failure.
  if (target && (result?.ok || (result === undefined && !pull.problem))) return <RefCardView target={target} href={pull.url} result={result} sheet={sheet} onClose={onClose} />;
  const problem = pull.problem ?? (target ? cardProblem(result, target) : null);
  return (
    <>
      <PullsList answer={{ pulls: [pull], groups: [{ kind: 'related', pulls: [pull.pull] }], removed: [] }} />
      <PullProblems problems={problem ? [problem] : []} onRetry={onRetry} retrying={retrying} touch={sheet} linked={pull.url} />
    </>
  );
}

/** How the card names a PR whose title is not known yet, and in Remove: short, never the URL (`forgePullRefShort`). */
function shortOf(pull: InboxThreadPullWire): string {
  const at = pull.repo.lastIndexOf('/');
  if (!pull.host || at <= 0 || !pull.number) return pull.ref;
  return forgePullRefShort({ platform: pull.platform, host: pull.host, owner: pull.repo.slice(0, at), repo: pull.repo.slice(at + 1), number: pull.number });
}

function PullRow({ pull, oneRepo, onRemove }: { pull: InboxThreadPullWire; oneRepo: boolean; onRemove?: (pull: InboxThreadPullWire) => void }) {
  const extras = pullExtras(pull);
  return (
    <li className="ib-prpop-row" data-pr-row={pull.ref} data-state={pull.state}>
      <a className="ib-prpop-link" href={pull.url} target="_blank" rel="noopener noreferrer">
        <span className="ib-prpop-ic">
          <RefMarkIcon kind="pr" state={pull.state} size={16} />
        </span>
        <span className="ib-prpop-main">
          <span className="ib-prpop-t">
            <span className="ib-prpop-title">{pull.title ?? shortOf(pull)}</span> <span className="ib-prpop-num">{pull.label}</span>
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
      {onRemove && (
        <button type="button" className="ib-prpop-rm" aria-label={`Remove ${shortOf(pull)} from this thread`} data-pr-remove={pull.ref} onClick={() => onRemove(pull)}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
    </li>
  );
}

/** Several PRs: each stack base first and joined, then the others (no heading) in the order they were added. */
function PullsList({ answer, onRemove }: { answer: InboxThreadPullsAnswer; onRemove?: (pull: InboxThreadPullWire) => void }) {
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
        // The thread's other PRs follow the stacks under the divider, with no heading (the owner, 2026-11-08: "it's
        // intuitive already"); only a stack is named.
        <section key={`${group.kind}-${index}`} className="ib-prpop-group" data-pr-group={group.kind} aria-label={group.kind === 'stack' ? `Stack of ${group.pulls.length}` : undefined}>
          {!only && group.kind === 'stack' && <div className="ib-prpop-gh">Stack of {group.pulls.length}</div>}
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
export function PullsCard({
  threadId,
  answer,
  failed = false,
  onAnswer,
  sheet,
  onClose,
  adding = false,
  onRetry,
  retrying = false,
}: {
  threadId: string;
  answer: InboxThreadPullsAnswer | null;
  failed?: boolean;
  onAnswer: (answer: InboxThreadPullsAnswer) => void;
  sheet: boolean;
  onClose: () => void;
  adding?: boolean;
  /** Try again on a problem that offers it (the read asks the forge again at once). */
  onRetry?: () => void;
  retrying?: boolean;
}) {
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
          <OnePull pull={pulls[0]!} sheet={false} onClose={onClose} onRetry={onRetry} retrying={retrying} />
        </div>
      ) : pulls.length > 1 ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <PullsList answer={answer!} onRemove={(pull) => void remove(pull)} />
          <PullProblems problems={pullProblems(pulls)} onRetry={onRetry} retrying={retrying} touch={sheet} />
        </div>
      ) : answer ? (
        <div className="ib-prpop-empty">No pull requests on this thread.</div>
      ) : failed ? (
        // The read got no answer: said plainly, never "Loading…" for ever. Hovering again reads again.
        <div className="ib-prpop-empty" role="status" data-pr-failed="">
          {INBOX_UNREACHABLE}
        </div>
      ) : (
        <div className="ib-prpop-empty" aria-busy="true">
          Loading…
        </div>
      )}
      <div className="ib-prpop-edit" data-pr-edit="">
        {removed && (
          <div className="ib-prpop-undo" role="status" data-pr-removed={removed.ref}>
            <span className="min-w-0 flex-1 truncate">Removed {shortOf(removed)}</span>
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
            Remove {shortOf(pulls[0]!)} from this thread
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
  const { answer, failed, retrying, setAnswer, retry } = useThreadPulls(threadId, !!open);
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
          <PullsCard threadId={threadId} answer={answer} failed={failed} onAnswer={setAnswer} sheet={open.sheet} onClose={close} onRetry={retry} retrying={retrying} />
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
  const { answer, failed, retrying, setAnswer, retry } = useThreadPulls(threadId, true);
  const shown = answer ? pullsSummaryOf(answer) : summary;
  useEffect(() => {
    if (adding && button.current) setOpen({ anchor: button.current, sheet: coarse(), pinned: true });
  }, [adding, setOpen]);
  const closeAll = (restoreFocus?: boolean) => {
    close();
    onAddingDone?.();
    if (restoreFocus) button.current?.focus({ preventScroll: true });
  };
  // No PRs: no button, unless the ⋯ menu asked to add one (the card opens on it, at the button's place).
  if (!shown && !open && !adding) return null;
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
          <PullsCard threadId={threadId} answer={answer} failed={failed} onAnswer={setAnswer} sheet={open.sheet} onClose={() => closeAll(true)} adding={adding} onRetry={retry} retrying={retrying} />
        </PullsPopover>
      )}
    </>
  );
}
