/**
 * "Review with an agent" (approval "pr-page-review-with-agent", the Inline take): the picker that starts a PR's or a
 * stack's one review thread. What to ask for first (a guided review, or the person's own curation), then one list of
 * agents: the running sessions of the PR's project, and "Start a new agent" only where this Inbox can start one
 * (compose's launch). Start review thread sends the first message to the picked session as a new thread and keeps
 * that thread as the PRs' review thread; a new agent opens compose with the same message.
 *
 * A pick is checked with the Inbox first (these PRs, an agent in that project); a refusal before the send sends
 * nothing. A stack of more open PRs than one review thread takes is refused before anything is sent. No new keyboard
 * shortcuts: Escape closes the picker, as every Inbox popover.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { INBOX_PULL_OWNER_KEYS_MAX, type InboxComposeSession, type InboxPullStack } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi } from '../api';
import { HostMark, Icon } from '../icons';
import { hostLabel } from '../compose/model';
import { builtinSkillContent, composeInboxSkillsBlock, INBOX_MESSAGE_SKILL_AUDIENCE, withSkillsBlock } from '../skills';
import { relativeTime, useRelativeClock } from '../relativeTime';
import { newUuid } from '../uuid';
import { handoffKeys, PULL_HANDOFF_CUSTOM_MAX, pullHandoffMessage, type PullHandoffAsk } from './model';
import { repoName } from './labels';

/** A running session of the PR's project, with the project it was found in (the owner check names it). */
type ReviewSession = InboxComposeSession & { project_id: string };

/**
 * What the picker offers: the running sessions, and `launch`, the agents a new session can be (compose's `launch`
 * block, additive): null when this Inbox can't start one, empty when it can but names none.
 */
interface ReviewTargets {
  sessions: ReviewSession[];
  launch: string[] | null;
}

/** Phase 1's approved /review-curate instructions, as the skills block a Send adds for a `/review-curate` it carries. */
function reviewCurateBlock(): string {
  const entry = { name: 'review-curate', root: 'plannotator' as const, humanOnly: true };
  const content = builtinSkillContent(entry);
  return content ? composeInboxSkillsBlock([entry], new Map([[entry.name, content]]), INBOX_MESSAGE_SKILL_AUDIENCE) : '';
}

/**
 * The hosts a new agent can be, from compose's sessions answer (`launch.agents`, each `{ agent: 'claude-code', … }`);
 * null when it has no launch block: this Inbox can't start one.
 */
export function launchHosts(model: unknown): string[] | null {
  const offer = (model as { launch?: { agents?: unknown[] } } | null)?.launch;
  if (!Array.isArray(offer?.agents) || offer.agents.length === 0) return null;
  return offer.agents.flatMap((a) => {
    const host = a && typeof a === 'object' ? (a as { agent?: unknown }).agent : null;
    return typeof host === 'string' && host ? [host] : [];
  });
}

/** "Claude Code, Codex or Pi": the agents "Start a new agent" can start; null when the Inbox did not name them. */
export function launchWords(hosts: readonly string[]): string | null {
  const names = [...new Set(hosts.map(hostLabel))];
  if (names.length < 2) return names[0] ?? null;
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

const PULL_AGENT_KEY = 'plannotator-inbox-pr-agent';
/** The session the person last started a review thread with: picked first next time while it runs. */
function lastPullAgent(): string | null {
  try {
    return window.localStorage.getItem(PULL_AGENT_KEY);
  } catch {
    return null;
  }
}
function rememberPullAgent(session: string): void {
  try {
    window.localStorage.setItem(PULL_AGENT_KEY, session);
  } catch {
    // Private mode: nothing is kept, the first running agent that is not working is picked.
  }
}

/** The running sessions of `projects`, without `exclude` (an ended thread's): read on open, and when the window comes back. */
function useReviewTargets(projects: readonly string[], exclude: readonly string[]): [ReviewTargets | null, () => void] {
  const [targets, setTargets] = useState<ReviewTargets | null>(null);
  const [readCount, setReadCount] = useState(0);
  const projectKey = projects.join('\u0000');
  useEffect(() => {
    const again = () => setReadCount((n) => n + 1);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, []);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const model = await inboxApi.composeSessions();
        const wanted = new Set(projects);
        const sessions = model.projects
          .filter((g) => g.project.id && wanted.has(g.project.id))
          .flatMap((g) => g.sessions.map((session) => ({ ...session, project_id: g.project.id! })))
          .filter((s) => !exclude.includes(s.session));
        if (live) setTargets({ sessions, launch: launchHosts(model) });
      } catch {
        if (live) setTargets({ sessions: [], launch: null });
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, exclude.join('\u0000'), readCount]);
  return [targets, () => setReadCount((n) => n + 1)];
}

export interface ReviewPickerProps {
  stack: InboxPullStack;
  /** The projects the stack's repository is checked out in (its running agents are theirs). */
  projects: readonly string[];
  /** The sessions of the ended review thread (its agent, and the one it was moved to): never offered again. */
  exclude: readonly string[];
  /** Labels the picker (the button that opened it says the same). */
  labelId: string;
  id: string;
  /** "Start a new agent": compose's New thread with the first message and the PRs it is for. */
  onLaunch: (body: string, opener: HTMLElement) => void;
  /** The review thread started with `session`: the list reads it. */
  onStarted: (session: string) => void;
  onCancel: () => void;
  /** The Inbox restarted and lost the list: read it again. */
  onReload: () => void;
}

/** The picker, inline under the stack's actions: every choice shows, one agent is picked, nothing covers the page. */
export function ReviewPicker({ stack, projects, exclude, labelId, id, onLaunch, onStarted, onCancel, onReload }: ReviewPickerProps) {
  const now = useRelativeClock(true);
  const [targets, readAgain] = useReviewTargets(projects, exclude);
  const [askKind, setAskKind] = useState<'guide' | 'custom'>('guide');
  const [words, setWords] = useState('');
  const ask: PullHandoffAsk = askKind === 'custom' ? { kind: 'custom', words } : { kind: 'guide' };
  const sessions = targets?.sessions ?? [];
  const launch = targets?.launch ?? null;
  const [pickedId, setPickedId] = useState<string | null>(null);
  // The person's pick, else the last one used, else the first running one that is not working, else a new agent.
  const picked: ReviewSession | 'new' | null =
    pickedId === 'new' && launch
      ? 'new'
      : (sessions.find((s) => s.session === pickedId) ??
        sessions.find((s) => s.session === lastPullAgent()) ??
        sessions.find((s) => !s.busy) ??
        sessions[0] ??
        (launch ? 'new' : null));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One idempotency key per send to one agent: a retry to the same agent reuses it, a new pick gets a new one.
  const keyRef = useRef<{ session: string; key: string } | null>(null);
  const askName = useId();
  const agentName = useId();
  const box = useRef<HTMLDivElement>(null);
  // Focus moves into the picker once its agents are read: the picked one (or Start, with none to pick).
  const read = targets !== null;
  useEffect(() => {
    if (read) box.current?.querySelector<HTMLElement>('[data-pulls-picker-list] input:checked, [data-pulls-start]')?.focus({ preventScroll: true });
  }, [read]);
  const keys = handoffKeys(stack);
  const waiting = askKind === 'custom' && !words.trim();

  const start = async (session: ReviewSession) => {
    if (sending) return;
    if (keys.length > INBOX_PULL_OWNER_KEYS_MAX) {
      setError(`A stack of more than ${INBOX_PULL_OWNER_KEYS_MAX} open pull requests can't go to one review thread.`);
      return;
    }
    setSending(true);
    setError(null);
    const idempotency = keyRef.current?.session === session.session ? keyRef.current : (keyRef.current = { session: session.session, key: newUuid() });
    try {
      // Checked first: a PR the Inbox can't keep for that agent is never sent to it.
      await inboxApi.pullOwnerCheck(keys, session.project_id);
      // The ask's instructions are phase 1's /review-curate, carried as the skills block a Send adds for it.
      const body = withSkillsBlock(pullHandoffMessage(stack, ask), reviewCurateBlock());
      const sent = await inboxApi.startThread({ to: { host: session.host, session: session.session }, body, idempotency_key: idempotency.key });
      try {
        await inboxApi.pullOwner(keys, sent.thread_id, ask.kind);
      } catch (cause) {
        // The Inbox restarted in between and has not read the list again: read it, then keep the thread once more.
        if (!(cause instanceof InboxApiError) || cause.code !== 'pull_unknown') throw cause;
        onReload();
        await inboxApi.pullOwner(keys, sent.thread_id, ask.kind);
      }
      keyRef.current = null;
      rememberPullAgent(session.session);
      onStarted(session.session);
    } catch (cause) {
      if (cause instanceof InboxApiError && cause.code === 'session_not_live') {
        // That agent has ended: drop the pick and read the running ones again.
        setPickedId(null);
        readAgain();
      }
      setError(cause instanceof InboxApiError || cause instanceof Error ? cause.message : 'The review thread was not started.');
    } finally {
      setSending(false);
    }
  };

  const where = repoName(stack.repo);
  const newWords = launch ? launchWords(launch) : null;
  return (
    <div
      ref={box}
      id={id}
      className="ib-pr-pick"
      role="group"
      aria-labelledby={labelId}
      data-pulls-picker=""
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !sending) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="ib-pr-pick-ask">
        <span className="ib-pr-pick-lab" id={`${askName}-l`}>
          Ask for
        </span>
        <div className="ib-seg ib-seg-sm" role="radiogroup" aria-labelledby={`${askName}-l`} data-pulls-ask-choice={askKind}>
          {(['guide', 'custom'] as const).map((value) => (
            <label key={value} className="ib-seg-o" data-on={askKind === value ? '' : undefined} data-pulls-ask-option={value}>
              <input type="radio" name={askName} checked={askKind === value} disabled={sending} onChange={() => setAskKind(value)} />
              {value === 'guide' ? 'Guided review' : 'Custom curation'}
            </label>
          ))}
        </div>
      </div>
      {askKind === 'custom' && (
        <input
          type="text"
          className="ib-pr-askin"
          value={words}
          maxLength={PULL_HANDOFF_CUSTOM_MAX}
          placeholder="/review-curate …"
          aria-label="Custom curation"
          disabled={sending}
          onChange={(event) => setWords(event.target.value)}
          data-pulls-ask-words=""
        />
      )}
      <div className="ib-pr-pick-list" role="radiogroup" aria-label={`Agent, running in ${where}`} data-pulls-picker-list="">
        <span className="ib-pr-pick-sub" aria-hidden="true">
          Running in {where}
        </span>
        {!read && <span className="ib-pr-pick-none">Looking for running agents…</span>}
        {read && sessions.length === 0 && <span className="ib-pr-pick-none">No agent is running in {where}.</span>}
        {sessions.map((session) => {
          const on = picked !== 'new' && picked?.session === session.session;
          return (
            <label key={session.session} className="ib-pr-opt" data-on={on ? '' : undefined} data-pulls-picker-session={session.session}>
              <input type="radio" name={agentName} checked={on} disabled={sending} onChange={() => setPickedId(session.session)} />
              <HostMark host={session.host} />
              <span className="ib-pr-opt-t">
                <b>{hostLabel(session.host)}</b>
                <span className="ib-pr-opt-s" dir="auto">
                  {session.label ?? 'No title yet'}
                </span>
              </span>
              <span className="ib-pr-opt-k">{session.busy ? 'Working' : `Started ${relativeTime(session.started_at, now)} ago`}</span>
            </label>
          );
        })}
        {launch && (
          <label className="ib-pr-opt" data-on={picked === 'new' ? '' : undefined} data-pulls-picker-new="">
            <input type="radio" name={agentName} checked={picked === 'new'} disabled={sending} onChange={() => setPickedId('new')} />
            <span className="ib-pr-opt-plus" aria-hidden="true">
              <Icon name="plus" size={14} />
            </span>
            <span className="ib-pr-opt-t">
              <b>Start a new agent</b>
              {newWords && <span className="ib-pr-opt-s">{newWords}</span>}
            </span>
          </label>
        )}
      </div>
      {error && (
        <div className="ib-error" role="alert">
          {error}
        </div>
      )}
      <div className="ib-pr-pick-go">
        <button
          type="button"
          className="ib-btn ib-pri"
          disabled={sending || waiting || picked === null}
          aria-busy={sending || undefined}
          onClick={(event) => {
            if (picked === 'new') onLaunch(pullHandoffMessage(stack, ask), event.currentTarget);
            else if (picked) void start(picked);
          }}
          data-pulls-start={picked === 'new' ? 'new' : (picked?.session ?? '')}
        >
          {sending ? 'Starting…' : 'Start review thread'}
        </button>
        <button type="button" className="ib-btn" onClick={onCancel} disabled={sending} data-pulls-picker-cancel="">
          Cancel
        </button>
      </div>
    </div>
  );
}
