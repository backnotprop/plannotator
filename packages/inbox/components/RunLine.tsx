import { useCallback, useEffect, useId, useState } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { INBOX_RUN_SESSION_PATTERN, inboxRunDuration, inboxRunOutcomeWords, isInboxRunHost, type InboxRunStatus, type InboxRunTurn } from '@plannotator/core/inbox-acp';
import type { InboxThread } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi } from '../api';
import { Icon } from '../icons';

/**
 * A session the Inbox runs itself (the ACP runner, packages/server/
 * inbox-acp-runner.ts): the run line under each person message (in place of
 * the delivery line), the permission card, and the thread foot's "Open in
 * Grok Build". Spec "Inbox replies as real turns for Cursor and Grok", step 1.
 */

/** The runner session a thread's messages go to: the first `run_` session named by `to` or by an agent author. */
export function runKeyOf(thread: Pick<InboxThread, 'messages'>): string | null {
  for (const message of thread.messages) {
    if (message.to && isInboxRunHost(message.to.host) && INBOX_RUN_SESSION_PATTERN.test(message.to.session)) return message.to.session;
    if (message.author.kind === 'agent' && isInboxRunHost(message.author.host) && message.author.session && INBOX_RUN_SESSION_PATTERN.test(message.author.session)) {
      return message.author.session;
    }
  }
  return null;
}

/**
 * The run's status: read when the thread opens, when the Inbox says it
 * changed (`version`, from `event: runs`), and every 3 s while a turn runs
 * (in case an event is missed). An older Inbox answers 404: null.
 */
export function useRunStatus(key: string | null, version: number): { run: InboxRunStatus | null; reload: () => Promise<void> } {
  const [run, setRun] = useState<InboxRunStatus | null>(null);
  const reload = useCallback(async () => {
    if (!key) return;
    try {
      setRun((await inboxApi.runStatus(key)).run);
    } catch {
      // Not a runner session on this Inbox (or it did not answer): leave what is there.
    }
  }, [key]);
  useEffect(() => {
    if (!key) {
      setRun(null);
      return;
    }
    void reload();
  }, [key, version, reload]);
  const active = run !== null && run.state !== 'idle';
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [active, reload]);
  return { run, reload };
}

/** A clock that ticks every second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** One turn, compared by what it is (the wire carries `turn` and `turns` as separate copies). */
export function sameTurn(a: InboxRunTurn | null, b: InboxRunTurn | null): boolean {
  return !!a && !!b && a.started_at === b.started_at && a.replies.join(',') === b.replies.join(',');
}

/** The turn that carried a message (the latest one, when a retry carried it again), or null. */
export function turnOf(run: InboxRunStatus, messageId: string): InboxRunTurn | null {
  for (let i = run.turns.length - 1; i >= 0; i--) if (run.turns[i]!.replies.includes(messageId)) return run.turns[i]!;
  return null;
}

/**
 * The run line under one person message: Queued, Starting…, working with its
 * clock and Stop (and Show activity), waiting on the person's OK, then Done,
 * Stopped, Interrupted or why it was not sent (with Try again).
 */
export function RunLine({ run, messageId, onChanged }: { run: InboxRunStatus; messageId: string; onChanged: () => void }) {
  const turn = turnOf(run, messageId);
  const current = sameTurn(turn, run.turn) && run.state !== 'idle';
  const queued = run.queued.includes(messageId);
  const now = useNow(current);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activityId = useId();
  if (!turn && !queued) return null;
  const label = run.label;

  const act = async (what: 'stop' | 'retry') => {
    setBusy(true);
    setError(null);
    try {
      if (what === 'stop') await inboxApi.stopRun(run.key);
      else await inboxApi.retryRun(run.key);
      onChanged();
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : what === 'stop' ? 'It did not stop. Try again.' : 'It did not start. Try again.');
    } finally {
      setBusy(false);
    }
  };

  let state: string;
  let words: string;
  let icon: 'clock' | 'check' | 'warn' | 'send' | 'x' = 'clock';
  if (queued && !turn) {
    state = 'queued';
    words = run.state === 'idle' ? `Queued · ${label} gets this as its next turn.` : `Queued · ${label} gets this when its current turn ends.`;
  } else if (current) {
    const took = inboxRunDuration(now - Date.parse(turn!.started_at));
    state = run.state;
    icon = 'send';
    words = run.state === 'starting' ? `Starting ${label}…` : run.state === 'permission' ? `${label} needs your OK · ${took}` : `${label} is working · ${took}`;
  } else {
    state = turn!.outcome ?? 'done';
    icon = turn!.outcome === 'done' ? 'check' : turn!.outcome === 'stopped' ? 'x' : 'warn';
    words = inboxRunOutcomeWords(turn!, label);
  }
  const lastTurn = run.turns.at(-1);
  const retry = !current && turn?.outcome === 'failed' && sameTurn(lastTurn ?? null, turn) && run.state === 'idle';
  const activity = (current || sameTurn(turn, run.turn)) && (run.activity.tools.length > 0 || run.activity.text.trim() !== '');

  return (
    <div className="ib-run" data-run-line={state} data-run-message={messageId}>
      <div className="ib-run-main">
        <Icon name={icon} size={14} />
        <span className="ib-run-text" aria-live="polite">
          {words}
        </span>
        {current && (
          <button type="button" className="ib-run-btn" data-run-stop="" disabled={busy} onClick={() => void act('stop')}>
            Stop
          </button>
        )}
        {retry && (
          <button type="button" className="ib-run-btn" data-run-retry="" disabled={busy} onClick={() => void act('retry')}>
            Try again
          </button>
        )}
        {activity && (
          <button type="button" className="ib-run-lnk" aria-expanded={open} aria-controls={activityId} data-run-activity-toggle="" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide activity' : 'Show activity'}
            <Icon name={open ? 'chevD' : 'chevR'} size={13} />
          </button>
        )}
      </div>
      {activity && open && (
        <div className="ib-run-activity" id={activityId} data-run-activity="">
          {run.activity.tools.length > 0 && (
            <ul>
              {run.activity.tools.map((tool) => (
                <li key={tool.id} data-tool-status={tool.status}>
                  <span className="ib-run-tool">{tool.title}</span>
                  <span className="ib-run-st">{toolStatusWord(tool.status)}</span>
                </li>
              ))}
            </ul>
          )}
          {run.activity.text.trim() !== '' && <p className="ib-run-said">{run.activity.text.trim()}</p>}
        </div>
      )}
      {current && run.permission && <PermissionCard run={run} onChanged={onChanged} />}
      {error && (
        <p className="ib-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function toolStatusWord(status: string): string {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'in_progress') return 'running';
  if (status === 'stopped') return 'stopped';
  return 'waiting';
}

/**
 * A permission request, with every option the agent offered, in its order
 * (its own settings decide what it asks; Plannotator never answers for the
 * person). No timeout. "Allow for the rest of this turn" answers this one with
 * the agent's allow-once option and the rest of the turn's the same way.
 */
export function PermissionCard({ run, onChanged }: { run: InboxRunStatus; onChanged: () => void }) {
  const permission = run.permission!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const answer = async (optionId: string, approveRest = false) => {
    setBusy(true);
    setError(null);
    try {
      await inboxApi.answerRunPermission(run.key, { permission_id: permission.id, option_id: optionId, ...(approveRest ? { approve_rest: true } : {}) });
      onChanged();
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The answer did not reach it. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const allowOnce = permission.options.find((o) => o.kind === 'allow_once');
  return (
    <div className="ib-perm" role="group" aria-labelledby={titleId} data-run-permission={permission.id}>
      <div className="ib-perm-head" id={titleId}>
        <Icon name="warn" size={15} />
        <b>{run.label} needs your OK</b>
      </div>
      <code className="ib-perm-title" data-run-permission-title="">
        {permission.title}
      </code>
      <div className="ib-perm-opts">
        {permission.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`ib-btn ib-sm${option.kind === 'allow_once' ? ' ib-pri' : ''}`}
            data-run-option={option.id}
            data-run-option-kind={option.kind}
            disabled={busy}
            onClick={() => void answer(option.id)}
          >
            {optionWords(option.name)}
          </button>
        ))}
      </div>
      {allowOnce && (
        <button type="button" className="ib-run-lnk ib-perm-rest" data-run-approve-rest="" disabled={busy} onClick={() => void answer(allowOnce.id, true)}>
          Allow this and the rest of this turn
        </button>
      )}
      <p className="ib-perm-note">It waits until you answer, or Stop.</p>
      {error && (
        <p className="ib-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** "allow once" → "Allow once": the agent's own words, capitalized. */
function optionWords(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0]!.toUpperCase() + trimmed.slice(1) : 'Choose';
}

/**
 * The thread foot's line: open this session in the agent's own CLI, and close
 * it there before replying. "Open in Grok Build: `grok -r <id>` in ~/billing ·
 * Copy" (Copy takes the whole `cd … && grok -r …`). On a phone it folds behind
 * one line, so the thread keeps its room.
 */
export function RunFoot({ run, phone = false }: { run: InboxRunStatus; phone?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!run.resume_command) return null;
  const command = run.resume?.command ?? run.resume_command;
  const body = (
    <>
      <code className="ib-runfoot-cmd" data-run-resume="">
        {command}
      </code>
      {run.resume && (
        <span className="ib-runfoot-in">
          in <bdi>{run.resume.folder}</bdi>
        </span>
      )}
      <button
        type="button"
        className="ib-copy"
        aria-label={copied ? 'Copied' : `Copy the command that opens this session in ${run.label}`}
        onClick={async () => {
          if (await copyTextToClipboard(run.resume_command!)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <span className="ib-runfoot-note">Close it in {run.label} before you reply here.</span>
    </>
  );
  if (phone) {
    return (
      <details className="ib-runfoot ib-runfoot-fold" data-run-foot="">
        <summary>
          <Icon name="terminal" size={15} />
          Open in {run.label}
        </summary>
        <div className="ib-runfoot-body">{body}</div>
      </details>
    );
  }
  return (
    <div className="ib-runfoot" data-run-foot="">
      <span className="ib-runfoot-l">Open in {run.label}:</span>
      {body}
    </div>
  );
}
