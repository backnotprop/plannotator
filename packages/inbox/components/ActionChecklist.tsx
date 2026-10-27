/**
 * A message's action items as one checklist (approval "action-items-checklist",
 * option A, 2026-10-22; first approved as one card per item, "inbox-next-actions").
 * One card per run of adjacent `:::action` blocks: the header says how many
 * things only the person can do and how many are done, with one Stopped /
 * Holds up badge; one row per item, a round tick (Done), the task and a
 * chevron. Rows are disclosures and one is open at a time (the first open item
 * to start with): why, what it holds up in words, Open for its link, the whole
 * command with Copy, then Done / Can't do it… / Add note…. Done and Can't do
 * it are recorded at once and go to the agent after a 10 s Undo window (as
 * 👍 Looks good): nothing is sent inside the window.
 */

import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { InboxQuestion } from '@plannotator/core/inbox-types';
import { INBOX_ACTION_NOTE_MAX } from '@plannotator/core/inbox-actions';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { ContextMarkdown } from './ContextMarkdown';
import { actionCardState, type ActionCardState } from '../actions';
import { clockTime } from '../format';
import { Icon } from '../icons';

export interface ActionMark {
  outcome: 'done' | 'cant';
  note?: string | null;
}

export interface ActionChecklistProps {
  /** The run's action items, in body order (one or more). */
  actions: readonly InboxQuestion[];
  /** The agent that asked, as the person sees it ("Claude Code"). */
  agent: string;
  /** No Done (the thread is archived, a test). */
  readOnly?: boolean;
  /** Done or Can't do it (`mark`), or the Undo (`null`). Resolves false when it was refused. */
  onMark: (action: InboxQuestion, mark: ActionMark | null) => Promise<boolean>;
}

/** The row's chip once it is no longer open. */
const CHIP: Record<ActionCardState, { label: string; className: string } | null> = {
  open: null,
  pending: null, // Done or Can't do it, by its outcome (below)
  done: { label: 'Done', className: 'ib-badge ib-b-ok' },
  seen: { label: 'Done', className: 'ib-badge ib-b-ok' },
  cant: { label: "Can't do it", className: 'ib-badge ib-b-stop' },
  'set-aside': { label: 'Set aside', className: 'ib-badge ib-b-mut' },
  archived: { label: 'Closed', className: 'ib-badge ib-b-mut' },
  replaced: { label: 'Replaced', className: 'ib-badge ib-b-mut' },
};

function isDoneState(action: InboxQuestion, state: ActionCardState): boolean {
  if (state === 'done' || state === 'seen') return true;
  return state === 'pending' && action.action_result?.outcome === 'done';
}

/**
 * The task, for its row's toggle (a button): inline markdown as a question's
 * prompt draws it (bold, `code`), but never a link, which cannot sit inside a
 * button: `[label](url)` keeps its label, and a bare or `<…>` URL reads as
 * code. The row's Open button carries a `Where:` link.
 */
export function taskMarkdown(prompt: string): string {
  return prompt
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '`$1`')
    .replace(/(^|[^`\w])(https?:\/\/[^\s`]+)/g, '$1`$2`');
}

/** A sentence's end, kept: "…appear" gets a period, "…appear." keeps its own. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** The next item still open after `key` (then from the start), or null. */
function nextOpen(actions: readonly InboxQuestion[], key: string): string | null {
  const at = actions.findIndex((a) => a.key === key);
  const order = [...actions.slice(at + 1), ...actions.slice(0, Math.max(at, 0))];
  return order.find((a) => a.key !== key && actionCardState(a) === 'open')?.key ?? null;
}

export function ActionChecklist({ actions, agent, readOnly = false, onMark }: ActionChecklistProps) {
  const states = actions.map((a) => actionCardState(a));
  // Replaced items keep their rows (with a "Replaced" chip) but are counted apart, so the header never
  // contradicts the rows: "3 things only you can do · 1 of 3 done · 1 replaced", or, all replaced,
  // "2 action items, replaced".
  const replaced = states.filter((st) => st === 'replaced').length;
  const total = actions.length - replaced;
  const done = actions.filter((a, i) => isDoneState(a, states[i]!)).length;
  const openItems = actions.filter((_, i) => states[i] === 'open');
  const stopped = openItems.some((a) => a.stopped !== null);
  const holds = openItems.reduce((n, a) => n + a.holds_up.length, 0);
  const badge = stopped
    ? { label: 'Stopped', className: 'ib-badge ib-b-stop' }
    : holds > 0
      ? { label: `Holds up ${holds}`, className: 'ib-badge ib-b-hold' }
      : null;
  // What the agent watches, for the items still waiting (open, or inside their Undo window): a settled or replaced item's watch is over.
  const watching = useMemo(
    () => [...new Set(actions.filter((_, i) => states[i] === 'open' || states[i] === 'pending').map((a) => a.action?.watching).filter((w): w is string => !!w))],
    [actions],
  );
  const hint = !readOnly && openItems.length > 0;

  // One row open at a time: the first open item to start with.
  const [openKey, setOpenKey] = useState<string | null>(() => openItems[0]?.key ?? null);
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => {
    if (!focusKey) return;
    toggles.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  const headId = useId();

  const marked = (action: InboxQuestion, mark: ActionMark | null, from: 'tick' | 'panel') => {
    if (!mark) {
      // Undo from the line under the task: that line goes, so focus goes to the row's toggle.
      if (from === 'panel') setFocusKey(action.key);
      return;
    }
    // After Done (or Can't do it) the next open item opens; focus follows from the panel, whose buttons go.
    const next = nextOpen(actions, action.key);
    setOpenKey(next);
    if (from === 'panel') setFocusKey(next ?? action.key);
  };

  return (
    <div className="ib-chk" role="group" aria-labelledby={headId} data-action-group="" data-action-count={actions.length}>
      <div className="ib-chk-head">
        <Icon name="todo" />
        <span className="ib-chk-title" id={headId} data-action-title="">
          {total === 0
            ? `${replaced === 1 ? '1 action item' : `${replaced} action items`}, replaced`
            : total === 1
              ? '1 thing only you can do'
              : `${total} things only you can do`}
        </span>
        {total > 0 && (
          <span className="ib-chk-count" data-action-progress="">
            {done} of {total} done{replaced > 0 ? ` · ${replaced} replaced` : ''}
          </span>
        )}
        {badge && (
          <span className={badge.className} data-action-badge="">
            {badge.label}
          </span>
        )}
      </div>
      <ul className="ib-chk-rows">
        {actions.map((action, i) => (
          <ActionRow
            key={action.key}
            action={action}
            state={states[i]!}
            agent={agent}
            readOnly={readOnly}
            open={openKey === action.key}
            onToggle={() => setOpenKey((current) => (current === action.key ? null : action.key))}
            toggleRef={(el) => {
              if (el) toggles.current.set(action.key, el);
              else toggles.current.delete(action.key);
            }}
            onMark={async (mark, from) => {
              const ok = await onMark(action, mark);
              if (ok) marked(action, mark, from);
              return ok;
            }}
          />
        ))}
      </ul>
      {(watching.length > 0 || hint) && (
        <p className="ib-chk-foot" data-action-foot="">
          {watching.length > 0 && <Icon name="eye" />}
          <span>
            {watching.length > 0 && (
              <span data-action-watching="">
                {agent} is watching: {sentence(watching.join('; '))}
              </span>
            )}
            {watching.length > 0 && hint && ' '}
            {hint && <span data-action-hint="">Done reaches {agent} after 10 s, so you can undo.</span>}
          </span>
        </p>
      )}
    </div>
  );
}

interface ActionRowProps {
  action: InboxQuestion;
  state: ActionCardState;
  agent: string;
  readOnly: boolean;
  open: boolean;
  onToggle: () => void;
  toggleRef: (el: HTMLButtonElement | null) => void;
  onMark: (mark: ActionMark | null, from: 'tick' | 'panel') => Promise<boolean>;
}

function ActionRow({ action, state, agent, readOnly, open, onToggle, toggleRef, onMark }: ActionRowProps) {
  const facts = action.action ?? { where: null, where_url: null, run: null, watching: null };
  const result = action.action_result ?? null;
  const live = state === 'open';
  const pending = state === 'pending';
  const doneLike = isDoneState(action, state);
  const [composing, setComposing] = useState<'note' | 'cant' | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // When Done was last marked from the tick: a second click of a double-click must not undo it.
  const tickDoneAt = useRef(0);
  const panelId = useId();
  const noteId = useId();
  useEffect(() => {
    if (composing) areaRef.current?.focus();
  }, [composing]);
  useEffect(() => {
    if (!live) setComposing(null);
  }, [live]);

  const mark = async (next: ActionMark | null, from: 'tick' | 'panel') => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await onMark(next, from);
      if (ok) {
        setComposing(null);
        setText('');
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!facts.run) return;
    const ok = await copyTextToClipboard(facts.run);
    setCopied(ok ? 'ok' : 'failed');
    window.setTimeout(() => setCopied(null), 2000);
  };

  const when = result ? clockTime(result.at) : '';
  const chip = pending
    ? result?.outcome === 'cant'
      ? CHIP.cant
      : CHIP.done
    : CHIP[state];

  // The line under the task while it can still be undone, and for a reason the person gave.
  const underLine = (() => {
    if (pending && result) {
      return (
        <>
          <span>
            {result.outcome === 'cant'
              ? `Can't do it: “${result.note ?? ''}”. Goes to ${agent} in a few seconds.`
              : `Done ${when}${result.note ? ' with a note' : ''}. Goes to ${agent} in a few seconds.`}
          </span>
          {!readOnly && (
            <button type="button" className="ib-act-undo" data-action-undo="" onClick={() => void mark(null, 'panel')} disabled={busy}>
              Undo
            </button>
          )}
        </>
      );
    }
    if (state === 'cant' && result) return <span>Can't do it: “{result.note ?? ''}” Sent to {agent}.</span>;
    return null;
  })();
  // The settled line inside the open row.
  const settled = (() => {
    if (state === 'done' && result) return `You marked it done, ${when}${result.note ? ' with a note' : ''}. Sent to ${agent}.`;
    if (state === 'seen' && result) return `${agent} saw it done, ${when}.`;
    if (state === 'set-aside') return `Set aside when you marked the thread read. ${agent} was told not to wait.`;
    if (state === 'replaced') return `${agent} replaced this action item.`;
    if (state === 'archived') return 'Closed when the thread was archived.';
    return null;
  })();

  // Uncircled glyphs: the dot is the circle. A set-aside, closed or replaced item is a dashed, empty dot.
  const tickIcon = doneLike ? 'check' : state === 'cant' || (pending && result?.outcome === 'cant') ? 'x' : null;
  const onTick = (event: MouseEvent) => {
    // The second click of a double-click (or one within half a second of Done) never undoes it.
    if (event.detail > 1) return;
    if (pending) {
      if (Date.now() - tickDoneAt.current < 500) return;
      void mark(null, 'tick');
      return;
    }
    tickDoneAt.current = Date.now();
    void mark({ outcome: 'done' }, 'tick');
  };
  const tick =
    !readOnly && (live || pending) ? (
      <button
        type="button"
        className="ib-chk-tick"
        data-action-tick=""
        aria-pressed={pending}
        aria-label={`Done: ${action.prompt}`}
        // aria-disabled, not disabled: a disabled button drops keyboard focus to the page. mark() ignores clicks while busy.
        aria-disabled={busy || undefined}
        onClick={onTick}
      >
        <span className="ib-chk-dot" aria-hidden="true">
          {tickIcon && <Icon name={tickIcon} />}
        </span>
      </button>
    ) : (
      <span className="ib-chk-tick" aria-hidden="true">
        <span className="ib-chk-dot">{tickIcon && <Icon name={tickIcon} />}</span>
      </span>
    );

  return (
    <li
      className="ib-chk-row"
      data-action-card={action.key}
      data-action-state={state}
      data-action-outcome={result?.outcome ?? undefined}
      data-open={open ? '' : undefined}
    >
      <div className="ib-chk-line">
        {tick}
        <button
          type="button"
          className="ib-chk-toggle"
          ref={toggleRef}
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          data-action-toggle=""
        >
          <span className="ib-chk-do">
            <InlineMarkdown text={taskMarkdown(action.prompt)} />
          </span>
          {chip && <span className={chip.className}>{chip.label}</span>}
          <Icon name={open ? 'chevD' : 'chevR'} />
        </button>
      </div>
      {underLine && (
        <p className="ib-chk-under" data-action-settled="">
          {underLine}
        </p>
      )}
      <div className="ib-chk-panel" id={panelId} hidden={!open} data-action-panel="">
        {action.context && <ContextMarkdown className="ib-body ib-chk-why" data-action-why="" markdown={action.context} messageId={action.message_id} />}
        {live && action.stopped !== null && (
          <p className="ib-chk-holds" data-action-stopped="">
            <b>Stopped</b>
            {action.stopped !== '' ? ` ${action.stopped}` : ''}
          </p>
        )}
        {live && action.holds_up.length > 0 && (
          <p className="ib-chk-holds" data-action-holds="">
            <b>Holds up</b> {action.holds_up.join('; ')}
          </p>
        )}
        {live && facts.where && !facts.where_url && (
          <p className="ib-chk-where" data-action-where="">
            <Icon name="folder" />
            <span>{facts.where}</span>
          </p>
        )}
        {live && facts.where_url && (
          <a className="ib-chk-open" href={facts.where_url} target="_blank" rel="noopener noreferrer" data-action-open="">
            <span className="ib-chk-open-l">Open {facts.where ?? 'link'}</span>
            <Icon name="external" />
          </a>
        )}
        {live && facts.run && (
          <div className="ib-chk-run" data-action-run="">
            <div className="ib-chk-run-top">
              <span className="ib-chk-run-l">Command</span>
              <button type="button" className="ib-btn ib-sm" data-action-copy="" onClick={() => void copy()}>
                <Icon name={copied === 'ok' ? 'check' : 'copy'} />
                {copied === 'ok' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy'}
              </button>
              <span className="ib-chk-sr" role="status" data-action-copy-status="">
                {copied === 'ok' ? 'Command copied.' : copied === 'failed' ? "Couldn't copy the command." : ''}
              </span>
            </div>
            <code className="ib-chk-cmd" data-action-cmd="">
              <span className="ib-chk-ps" aria-hidden="true">
                ${' '}
              </span>
              {facts.run}
            </code>
          </div>
        )}
        {settled && (
          <p className="ib-chk-settled" data-action-settled="">
            {settled}
          </p>
        )}
        {live && !readOnly && (composing ? (
          <div className="ib-chk-compose">
            <label htmlFor={noteId}>{composing === 'cant' ? `Why can't you? ${agent} gets this word for word.` : `A note for ${agent} (optional)`}</label>
            <textarea
              id={noteId}
              ref={areaRef}
              className="ib-chk-note"
              value={text}
              rows={2}
              maxLength={INBOX_ACTION_NOTE_MAX}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setComposing(null);
                }
              }}
            />
            <div className="ib-chk-acts">
              {composing === 'cant' ? (
                <button
                  type="button"
                  className="ib-btn ib-sm ib-pri"
                  data-action-cant-send=""
                  disabled={busy || text.trim() === ''}
                  onClick={() => void mark({ outcome: 'cant', note: text.trim() }, 'panel')}
                >
                  Send “Can't do it”
                </button>
              ) : (
                <button type="button" className="ib-btn ib-sm ib-pri" data-action-done="" disabled={busy} onClick={() => void mark({ outcome: 'done', note: text.trim() || null }, 'panel')}>
                  <Icon name="check" />
                  Done
                </button>
              )}
              <button type="button" className="ib-btn ib-sm ib-ghost" onClick={() => setComposing(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="ib-chk-acts">
            <button type="button" className="ib-btn ib-sm ib-pri" data-action-done="" disabled={busy} onClick={() => void mark({ outcome: 'done' }, 'panel')}>
              <Icon name="check" />
              Done
            </button>
            <button type="button" className="ib-btn ib-sm ib-ghost" data-action-cant="" disabled={busy} onClick={() => setComposing('cant')}>
              Can't do it…
            </button>
            <button type="button" className="ib-btn ib-sm ib-ghost" data-action-note="" disabled={busy} onClick={() => setComposing('note')}>
              Add note…
            </button>
          </div>
        ))}
      </div>
    </li>
  );
}
