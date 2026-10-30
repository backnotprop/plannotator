/**
 * A message's action items as one checklist (approval "action-items-checklist",
 * option A, 2026-10-22; first approved as one card per item, "inbox-next-actions").
 * One card per run of adjacent `:::action` blocks: the header says how many
 * things only the person can do and how many are done, with one Stopped /
 * Holds up badge; one row per item, a round tick (Done), the task and a
 * chevron. Rows are disclosures and one is open at a time (the first open item
 * to start with): why, what it holds up in words, Open for its link, the whole
 * command with Copy, then Done / Can't do it….
 *
 * Done and Can't do it go into the person's reply draft, like a pick
 * (approval "inbox-action-items-in-reply", 2026-10-26): recorded at once, sent
 * only with their Send, under "Action items you asked for". The marked row
 * shows a note field ("Add a note for <agent>") and "Done 3:12 PM · in your
 * draft"; the tick takes the mark back. No timer, no toast. A mark made
 * through the timed path (decision mode, the phone door) still shows its
 * "Goes to <agent> in a few seconds" line and Undo.
 */

import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { inboxActionInDraft, inboxActionPersonMark, type InboxQuestion } from '@plannotator/core/inbox-types';
import { INBOX_ACTION_NOTE_MAX } from '@plannotator/core/inbox-actions';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { CROSS_REPO_REF_PATTERN } from '@plannotator/core/forge-refs';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { ContextMarkdown } from './ContextMarkdown';
import { actionCardState, type ActionCardState } from '../actions';
import { clockTime } from '../format';
import { Icon } from '../icons';
import { registerActionFlush, trackActionSave } from '../actionSaves';
import { inboxApi } from '../api';

/** A Done or Can't do it as the window marks it: always into the reply draft (`staged` on the wire). */
export interface ActionMark {
  outcome: 'done' | 'cant';
  note?: string | null;
  /** A note typed under the marked row: saved without a word for a screen reader. */
  quiet?: boolean;
}

export interface ActionChecklistProps {
  /** The run's action items, in body order (one or more). */
  actions: readonly InboxQuestion[];
  /** The agent that asked, as the person sees it ("Claude Code"). */
  agent: string;
  /** The thread's repo: refs in an item's why link into it. Never in the task (a button): its refs stay plain. */
  refRepo?: { display: string; host?: string } | null;
  /** No Done (the thread is archived, a test). */
  readOnly?: boolean;
  /** Done or Can't do it into the reply draft (`mark`), or taking it back (`null`). Resolves false when it was refused. */
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

const CROSS_REPO_REF_GLOBAL = new RegExp(CROSS_REPO_REF_PATTERN.source, 'g');

/**
 * The task, for its row's toggle (a button): inline markdown as a question's
 * prompt draws it (bold, `code`), but never a link, which cannot sit inside a
 * button: `[label](url)` keeps its label, and a bare or `<…>` URL reads as
 * code. An `owner/repo#123` ref stays plain text (its `#` escaped). The row's
 * Open button carries a `Where:` link.
 */
export function taskMarkdown(prompt: string): string {
  return prompt
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '`$1`')
    .replace(/(^|[^`\w])(https?:\/\/[^\s`]+)/g, '$1`$2`')
    // Outside code spans only (an escape inside one would show).
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(CROSS_REPO_REF_GLOBAL, (ref) => ref.replace('#', '\\#'))))
    .join('');
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

export function ActionChecklist({ actions, agent, refRepo = null, readOnly = false, onMark }: ActionChecklistProps) {
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
  // What the agent watches, for the items it still waits on (open, or marked and not sent): a settled or replaced item's watch is over.
  const watching = useMemo(
    () => [...new Set(actions.filter((_, i) => states[i] === 'open' || states[i] === 'pending').map((a) => a.action?.watching).filter((w): w is string => !!w))],
    [actions],
  );

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
            refRepo={refRepo}
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
      {watching.length > 0 && (
        <p className="ib-chk-foot" data-action-foot="">
          <Icon name="eye" />
          <span data-action-watching="">
            {agent} is watching: {sentence(watching.join('; '))}
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
  refRepo: { display: string; host?: string } | null;
  readOnly: boolean;
  open: boolean;
  onToggle: () => void;
  toggleRef: (el: HTMLButtonElement | null) => void;
  onMark: (mark: ActionMark | null, from: 'tick' | 'panel') => Promise<boolean>;
}

function ActionRow({ action, state, agent, refRepo, readOnly, open, onToggle, toggleRef, onMark }: ActionRowProps) {
  const facts = action.action ?? { where: null, where_url: null, run: null, watching: null };
  const result = action.action_result ?? null;
  const live = state === 'open';
  const pending = state === 'pending';
  /** The person's mark waits in their reply draft: their Done or Can't do it, or (the agent saw it done) their note. */
  const inDraft = inboxActionInDraft(action);
  /** Marked through the timed path (decision mode, the phone door): sent once its Undo window passes. */
  const timed = pending && result?.staged !== true;
  const doneLike = isDoneState(action, state);
  const [composing, setComposing] = useState<'cant' | null>(null);
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
      const ok = await trackActionSave(onMark(next, from));
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
  const mine = inboxActionPersonMark(result);
  const chip = pending
    ? result?.outcome === 'cant'
      ? CHIP.cant
      : CHIP.done
    : CHIP[state];

  // The line under the task: a timed mark's Undo, a reason the person sent, the agent's own done over a note in the draft.
  const underLine = (() => {
    if (timed && result) {
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
    if (state === 'cant' && result) return <span>Can't do it: “{result.note ?? ''}” Sent to {agent}{result.staged ? ' with your reply' : ''}.</span>;
    if (state === 'seen' && result && inDraft) return <span>{agent} saw it done, {when}.</span>;
    return null;
  })();
  // The settled line inside the open row.
  const settled = (() => {
    if (state === 'done' && result) return `You marked it done, ${when}${result.note ? ' with a note' : ''}. Sent to ${agent}${result.staged ? ' with your reply' : ''}.`;
    if (state === 'seen' && result && inDraft) return null;
    if (state === 'seen' && result && mine?.note) return `${agent} saw it done, ${when}. Your note went with your reply.`;
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
      {inDraft && mine && (
        <DraftNote
          mark={mine}
          seen={state === 'seen'}
          agent={agent}
          readOnly={readOnly}
          onSave={(next) => trackActionSave(onMark(next, 'tick'))}
          onLeave={(next) => inboxApi.markActionOnLeave(action.message_id, action.key, next)}
        />
      )}
      <div className="ib-chk-panel" id={panelId} hidden={!open} data-action-panel="">
        {action.context && <ContextMarkdown className="ib-body ib-chk-why" data-action-why="" markdown={action.context} messageId={action.message_id} refRepo={refRepo} />}
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
            <label htmlFor={noteId}>{`Why can't you? ${agent} gets this word for word.`}</label>
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
              <button
                type="button"
                className="ib-btn ib-sm ib-pri"
                data-action-cant-send=""
                disabled={busy || text.trim() === ''}
                onClick={() => void mark({ outcome: 'cant', note: text.trim() }, 'panel')}
              >
                Can't do it
              </button>
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
          </div>
        ))}
      </div>
    </li>
  );
}

/**
 * A mark waiting in the reply draft, under its row (approval
 * "inbox-action-items-in-reply"): the note for the agent, saved as it is
 * typed (and on leaving the field, so a Send right after carries it), then
 * "Done 3:12 PM · in your draft", the question card's own words for a pick.
 * Can't do it's note is its reason, so it never empties: emptied, it is not
 * saved, and leaving the field puts the saved reason back, so the field never
 * shows less than what goes. `seen`: the agent saw the item done itself, and
 * the note is what still goes (Q3). A reload or a closed tab inside the typing
 * pause sends the note as the page goes (`onLeave`, a keepalive request).
 */
function DraftNote({
  mark,
  seen,
  agent,
  readOnly,
  onSave,
  onLeave,
}: {
  mark: { outcome: 'done' | 'cant'; note: string | null; at: string };
  seen: boolean;
  agent: string;
  readOnly: boolean;
  onSave: (mark: ActionMark | null) => Promise<boolean>;
  /** The page is going (pagehide) with words inside their typing pause: sent so the request outlives the page. */
  onLeave: (mark: ActionMark | null) => void;
}) {
  const [text, setText] = useState(mark.note ?? '');
  const saved = useRef(mark.note ?? '');
  const timer = useRef<number | null>(null);
  /** The words as typed, for a flush (before a Send, or as the row goes away) that runs outside a render. */
  const typed = useRef(text);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const noteId = useId();
  const cant = mark.outcome === 'cant';
  /** What saving `value` sends, now counted as saved; undefined when there is nothing to save. */
  const toSave = (value: string): ActionMark | null | undefined => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const note = value.trim();
    if (note === saved.current.trim() || (cant && note === '')) return undefined;
    saved.current = note;
    // The agent saw it done: an emptied note leaves nothing of the person's to send.
    return seen && note === '' ? null : { outcome: mark.outcome, note: note || null, quiet: true };
  };
  const save = (value: string) => {
    const next = toSave(value);
    if (next !== undefined) void onSave(next);
  };
  // Grows with its words: one line until there are more.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  // Words still inside their typing pause are saved at once before a Send, and when the row goes away
  // (the pane closed, the thread changed, the mark sent), never dropped.
  const saveRef = useRef(save);
  saveRef.current = save;
  const leaveRef = useRef(() => {
    const next = toSave(typed.current);
    if (next !== undefined) onLeave(next);
  });
  leaveRef.current = () => {
    const next = toSave(typed.current);
    if (next !== undefined) onLeave(next);
  };
  useEffect(() => {
    const flush = () => {
      if (timer.current !== null) saveRef.current(typed.current);
    };
    const unregister = registerActionFlush(flush);
    // A reload or a closed tab inside the typing pause: the unmount flush never runs then.
    const onHide = () => {
      if (timer.current !== null) leaveRef.current();
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      unregister();
      flush();
    };
  }, []);
  return (
    <div className="ib-chk-draft" data-action-draft="">
      <label className="ib-chk-sr" htmlFor={noteId}>
        {cant ? `Why you can't, for ${agent}` : `A note for ${agent}`}
      </label>
      <textarea
        id={noteId}
        ref={areaRef}
        className="ib-chk-dnote"
        data-action-draft-note=""
        rows={1}
        value={text}
        readOnly={readOnly}
        maxLength={INBOX_ACTION_NOTE_MAX}
        placeholder={`Add a note for ${agent}`}
        onChange={(event) => {
          const value = event.target.value;
          typed.current = value;
          setText(value);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => save(value), 600);
        }}
        onBlur={() => {
          save(text);
          // An emptied reason is not saved: the field shows again the one that goes.
          if (cant && text.trim() === '') {
            typed.current = saved.current;
            setText(saved.current);
          }
        }}
      />
      <p className="ib-chk-dline" data-action-draft-line="">
        {seen ? (cant ? 'Your reason' : 'Your note') : cant ? "Can't do it" : 'Done'}
        {seen ? '' : ` ${clockTime(mark.at)}`} · in your draft
      </p>
    </div>
  );
}
