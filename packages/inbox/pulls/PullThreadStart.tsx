/**
 * Start a thread (the owner, 2026-11-17, mock "V1, slim line"): pressing it on a PR's page turns the page, in place,
 * into an empty thread for that PR. The PR's bar stays; under it the PR's line (`PullContextLine`: title, branch,
 * size, checks, with Guided review and The diff as links); one quiet line in the middle; the reply box at the foot,
 * empty and focused, with who gets it in the box's own row (the reply box's list, `ReplyRecipient`, a phone's sheet,
 * `PhoneReplyRecipient`; `threadTo.ts`). To starts on New review's choice and never sends by itself.
 *
 * Nothing exists until Send (`startThread.ts`): leaving, closing or Escape leaves no thread and no link. A thread
 * that does not exist has no reply draft, so the words are kept in memory for this PR only while the window is open
 * (as New review keeps its words, `threadStarts.ts`), and come back when it opens again; Send clears them. Send starts
 * the thread with the words first and the PR's details after, keeps the PR as its own, and the window opens the thread
 * (`onStarted`), which is the PR's page from then on. A press while one is on its way does nothing; once a thread
 * started, a press only ties it (`threadStarts.ts`): the words it went with show as sent, and anything typed after
 * goes into the thread's reply box, not sent. A PR given to another thread meanwhile opens that one (`onTaken`), with
 * the words not sent in its reply box. Words are never dropped: what a Send did not send is carried, never cleared.
 * No keyboard shortcuts of its own: the registry's Send and Close (⌘↵, Escape), as in the reply box; Escape closes an
 * open list (`/`) first.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { InboxPull, InboxPullStack } from '@plannotator/core/inbox-types';
import { matchesShortcutBinding, resolveShortcutBindings } from '@plannotator/ui/shortcuts';
import { InboxApiError } from '../api';
import { InboxComposerField } from '../components/ComposerField';
import { PhoneReplyRecipient } from '../components/PhoneReplyRecipient';
import { ReplyRecipient } from '../components/ReplyRecipient';
import { ReplyRow } from '../components/ReplyRow';
import { Tip } from '../components/Tip';
import { VoiceMicButton, VoiceStatusLine } from '../components/VoiceMic';
import { useComposeSessions } from '../compose/useComposeSessions';
import { Icon } from '../icons';
import { useShortcutAria } from '../shortcuts/hint';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import { inboxSkillFilter } from '../skills';
import { useVoiceSession } from '../voice';
import { PullBar } from './PullLaunchpad';
import { PullContextLine } from './PullContextLine';
import { PullThreadNoAgent, sendPullThread } from './startThread';
import { keepUnsentPullWords, unsentPullWords, untiedPullStart } from './threadStarts';
import { pullThreadDefault, pullThreadOptions } from './threadTo';

/** The empty thread's one line. */
export const PULL_THREAD_EMPTY = 'Ask anything about this pull request. Your first message starts the thread.';
/** The box's placeholder. */
export const PULL_THREAD_PLACEHOLDER = 'Ask about this pull request. Type / for a skill';
/** The thread started but the PR could not be kept as its own: said with the reason; Send again ties it. */
export const PULL_THREAD_UNTIED = 'The thread started, but it isn’t tied to this pull request yet. Press Send again to tie it.';
/** No agent can take the thread: said in place of the empty line, before any typing, and Send stays off. */
export const PULL_THREAD_NO_AGENT = 'No agent is running in this project, and none can start here. Start one, then come back.';
/** The chosen session ended before the Send. */
export const PULL_THREAD_SESSION_GONE = 'That agent isn’t running any more, so nothing was sent. Pick another in To.';
/** The PR already has another thread (another window's, a hand-off): that one opened, and a toast says so. */
export const PULL_THREAD_TAKEN = 'Already has a thread';
/** Nothing was sent: the words are in that thread's reply box. */
export const PULL_THREAD_TAKEN_DETAIL = 'This pull request already has a thread, so nothing new started. That thread is open, with your words in its reply box, not sent.';
/** This page's thread had started but wasn't tied: it stays in the Inbox; anything typed after is in the other's box. */
export const PULL_THREAD_TAKEN_MINE = 'This pull request was given to another thread before yours was tied to it. That thread is open; yours stays in the Inbox.';
export const PULL_THREAD_TAKEN_MINE_WORDS = 'This pull request was given to another thread before yours was tied to it. That thread is open, with your new words in its reply box, not sent; yours stays in the Inbox.';
/** Over the words a thread that isn't tied yet went with. */
export const PULL_THREAD_SENT = 'Sent';
/** The box's placeholder while a Send only ties the thread. */
export const PULL_THREAD_MORE = 'Anything more you write goes into the thread’s reply box, not sent.';
/** Words of whitespace only. */
export const PULL_THREAD_NO_WORDS = 'Write a message first.';

const whyOf = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : 'It didn’t go. Try again.');
const SKILLS = inboxSkillFilter(false);
const SEND = resolveShortcutBindings(inboxThreadShortcuts.shortcuts.send);
const CLOSE = resolveShortcutBindings(inboxThreadShortcuts.shortcuts.close);

export function PullThreadStart({
  stack,
  pr,
  projects,
  phone,
  stacked = false,
  onClose,
  onHide,
  onLeave,
  onGuide,
  onDiff,
  onStarted,
  onTaken,
}: {
  stack: InboxPullStack;
  pr: InboxPull;
  /** The PR's projects (`stackProjects`): To offers only their agents. */
  projects: readonly string[];
  phone: boolean;
  stacked?: boolean;
  /** The pane's Close (or `‹ Reviews`): leaves nothing behind. */
  onClose: () => void;
  /** The bar's Hide, as on the PR's page: leaves nothing behind either. */
  onHide?: () => void;
  /** Escape, or the bin: back to the PR's page (focus on its Start a thread). */
  onLeave: () => void;
  /** Guided review: New review filled in with this PR (the launchpad's Start a guided review). Null: not offered. */
  onGuide: ((opener: HTMLElement) => void) | null;
  onDiff: () => void;
  /** The thread started and is kept as the PR's: the window opens it, with `carried` (words not sent) in its reply box. */
  onStarted: (threadId: string, carried: string) => void;
  /** The PR already has another thread: nothing started or tied; the window opens that one with `carried`, and says `detail`. */
  onTaken: (threadId: string, carried: string, detail: string) => void;
}) {
  const labelId = useId();
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const [section, setSection] = useState<HTMLElement | null>(null);
  const [words, setWords] = useState(() => unsentPullWords(pr.key));
  const { model } = useComposeSessions(true);
  const options = useMemo(() => pullThreadOptions(model, projects), [model, projects.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picked, setPicked] = useState<string | null>(null);
  const fallback = useMemo(() => pullThreadDefault(model, projects, options), [model, options]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosenId = picked && options.some((o) => o.row.session === picked) ? picked : fallback;
  const chosen = options.find((o) => o.row.session === chosenId) ?? null;
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  // A thread that started before and isn't tied yet: said at once; Send only ties it, and needs no agent.
  const [untied, setUntied] = useState(() => untiedPullStart(pr.key));
  const [error, setError] = useState<string | null>(() => (untied ? PULL_THREAD_UNTIED : null));
  const voice = useVoiceSession();
  // The reply box's own Send keys (the thread's registry), named for screen readers as every Send names them.
  const sendAria = useShortcutAria({ scope: inboxThreadShortcuts, action: 'send' });
  const labels = useMemo(() => Object.fromEntries((model?.projects ?? []).flatMap((g) => g.sessions.filter((s) => s.label).map((s) => [s.session, s.label!] as const))), [model]);
  const folderOf = (session: string) => options.find((o) => o.row.session === session)?.projectName ?? '';
  // Known once the sessions are read: no agent can take the thread here.
  const noAgent = model !== null && options.length === 0;
  const tieOnly = untied !== null;

  useEffect(() => {
    textRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => keepUnsentPullWords(pr.key, words), [pr.key, words]);

  // Set at once, before React draws the busy Send: two presses in one moment are one Send.
  const inFlight = useRef(false);
  const send = async () => {
    if (inFlight.current || voice.busy) return;
    const text = words.trim();
    if (!text && !tieOnly) {
      setError(PULL_THREAD_NO_WORDS);
      textRef.current?.focus();
      return;
    }
    if (!chosen && !tieOnly) {
      if (noAgent) setError(PULL_THREAD_NO_AGENT);
      return;
    }
    setError(null);
    inFlight.current = true;
    setSending(true);
    try {
      const result = await sendPullThread({ stack, pr: pr.key, words: text, to: chosen?.to ?? null, project: chosen?.project ?? null });
      if (result.kind === 'untied') {
        // Words that just went are sent: they show as such, and the box is for anything more.
        if (!tieOnly) {
          keepUnsentPullWords(pr.key, '');
          setWords('');
        }
        setUntied(untiedPullStart(pr.key));
        setError(`${PULL_THREAD_UNTIED} ${result.why}`);
        inFlight.current = false;
        setSending(false);
        return;
      }
      // What this Send did not send goes with the window into the thread's reply box: never lost.
      const carried = result.kind === 'taken' || tieOnly ? text : '';
      keepUnsentPullWords(pr.key, '');
      setWords('');
      if (result.kind === 'taken') onTaken(result.threadId, carried, result.mine ? (carried ? PULL_THREAD_TAKEN_MINE_WORDS : PULL_THREAD_TAKEN_MINE) : PULL_THREAD_TAKEN_DETAIL);
      else onStarted(result.threadId, carried);
    } catch (cause) {
      setError(cause instanceof PullThreadNoAgent ? PULL_THREAD_NO_AGENT : cause instanceof InboxApiError && cause.code === 'session_not_live' ? PULL_THREAD_SESSION_GONE : whyOf(cause));
      inFlight.current = false;
      setSending(false);
    }
  };

  const recipient = { rows: options.map((o) => o.row), chosen: chosen ? [chosen.row] : [], open, onOpen: setOpen, onOnly: (row: (typeof options)[number]['row']) => (setPicked(row.session), setOpen(false)), labels, folderOf, noun: 'message' as const };
  // A Send that only ties a thread that already started goes to no agent: To is not offered then.
  const pill = tieOnly ? null : phone ? <PhoneReplyRecipient {...recipient} section={section} /> : options.length > 0 ? <ReplyRecipient {...recipient} /> : null;

  return (
    <section
      ref={(el) => {
        sectionRef.current = el;
        if (el !== section) setSection(el);
      }}
      className="ib-pane ib-prpane ib-pth"
      aria-labelledby={labelId}
      data-pulls-stack={stack.id}
      data-pull-thread-start=""
    >
      <PullBar stack={stack} pr={pr} phone={phone} stacked={stacked} onClose={onClose} onHide={onHide} />
      <div className="ib-pbody ib-pth-body">
        <h2 id={labelId} className="ib-sr">
          New thread about {pr.title}
        </h2>
        <PullContextLine pr={pr} onGuide={onGuide ? () => onGuide(sectionRef.current?.querySelector<HTMLElement>('[data-pull-context-go="guide"]') ?? sectionRef.current!) : null} onDiff={onDiff} />
        {untied ? (
          // The words the thread went with: sent, so fixed here; the box below is for anything more.
          <div className="ib-pth-sent" data-pull-thread-sent="">
            <span className="ib-pth-sent-h">{PULL_THREAD_SENT}</span>
            <p dir="auto">{untied.sent}</p>
          </div>
        ) : (
          <div className="ib-pth-empty" data-pull-thread-empty={noAgent ? 'no-agent' : ''}>
            <p>{noAgent ? PULL_THREAD_NO_AGENT : PULL_THREAD_EMPTY}</p>
          </div>
        )}
      </div>
      <div className="ib-pfoot">
        <div className="ib-rbox" onMouseDown={(event) => event.target === event.currentTarget && textRef.current?.focus()}>
          <div className="ib-rscroll" data-reply-scroll="">
            <InboxComposerField
              value={words}
              onChange={(next) => {
                setWords(next);
                if (error && !tieOnly) setError(null);
              }}
              textareaRef={textRef}
              voice={voice}
              voiceNoteGlide
              ariaLabel={`Ask about ${pr.title}`}
              placeholder={tieOnly ? PULL_THREAD_MORE : PULL_THREAD_PLACEHOLDER}
              destination="your message"
              skillFilter={SKILLS}
              escapeClosesMenu
              onKeyDown={(event) => {
                // An IME's own keys (a composition's Enter or Escape; Safari's Escape comes as keyCode 229) are its own.
                if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (SEND.some((binding) => matchesShortcutBinding(event.nativeEvent, binding))) {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!event.repeat) void send();
                } else if (!open && CLOSE.some((binding) => matchesShortcutBinding(event.nativeEvent, binding))) {
                  event.preventDefault();
                  event.stopPropagation();
                  onLeave();
                }
              }}
            />
          </div>
          {error && (
            <div className="ib-rnote ib-pth-err" role="alert" data-pull-thread-error="">
              {error}
            </div>
          )}
          <ReplyRow
            phone={phone}
            keepOpen={false}
            fold={false}
            onFold={() => {}}
            fitKey=""
            send={
              <button
                type="button"
                className="ib-btn ib-pri ib-rsend"
                aria-keyshortcuts={sendAria}
                // Pale while there is nothing to send (the mock), or no agent to take it; a Send that only ties needs neither.
                disabled={sending || voice.busy || (!tieOnly && (noAgent || words.length === 0))}
                onClick={() => void send()}
                data-reply-send=""
              >
                {sending && <span className="ib-spin" aria-hidden="true" />}
                {phone && <Icon name="arrowUp" size={20} className="ib-rsend-i" />}
                <span className="ib-rsend-w">Send</span>
              </button>
            }
            clip={null}
            skills={
              <Tip content="Skills (or type / in the message)">
                <button
                  type="button"
                  className="ib-ricon"
                  aria-label="Skills"
                  data-reply-skills=""
                  onClick={() => {
                    const field = textRef.current;
                    if (!field) return;
                    field.focus();
                    const at = field.selectionStart ?? field.value.length;
                    const before = field.value.slice(0, at);
                    document.execCommand('insertText', false, at === 0 || /\s$/.test(before) ? '/' : ' /');
                  }}
                >
                  <Icon name="cube" size={phone ? 20 : 16} />
                </button>
              </Tip>
            }
            mic={<VoiceMicButton voice={voice} phone={phone} />}
            status={<VoiceStatusLine voice={voice} phone={phone} />}
            files={null}
            chips={null}
            summary={null}
            pill={pill}
            discard={
              phone ? null : (
                <Tip content="Discard, back to the pull request">
                  <button
                    type="button"
                    className="ib-ricon ib-rdiscard"
                    aria-label="Discard, back to the pull request"
                    data-reply-discard=""
                    onClick={() => {
                      keepUnsentPullWords(pr.key, '');
                      setWords('');
                      onLeave();
                    }}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </Tip>
              )
            }
          />
        </div>
      </div>
    </section>
  );
}
