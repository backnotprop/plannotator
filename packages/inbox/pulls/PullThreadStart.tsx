/**
 * Start a thread (the owner, 2026-11-17, mock "V1, slim line"): pressing it on a PR's page turns the page, in place,
 * into an empty thread for that PR. The PR's bar stays; under it the PR's line (`PullContextLine`: title, branch,
 * size, checks, with Guided review and The diff as links); one quiet line in the middle; the reply box at the foot,
 * empty and focused, with who gets it in the box's own row (the reply box's list, `ReplyRecipient`, a phone's sheet,
 * `PhoneReplyRecipient`; `threadTo.ts`). To starts on New review's choice and never sends by itself.
 *
 * Nothing exists until Send (`startThread.ts`): leaving, closing or Escape leaves no thread and no link. A thread
 * that does not exist has no reply draft, so the words are kept in memory for this PR only while the window is open
 * (as New review keeps its words), and come back when it opens again; Send clears them. Send starts the thread with
 * the words first and the PR's details after, keeps the PR as its own, and the window opens the thread (`onStarted`),
 * which is the PR's page from then on. A press while one is on its way does nothing, and a press again after a failure
 * replays the same Send (its key is kept while the words and To stay as they were), so one press series is one thread.
 * No keyboard shortcuts of its own: ⌘↵ sends and Escape leaves, as in the reply box.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { InboxPull, InboxPullStack } from '@plannotator/core/inbox-types';
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
import { newUuid } from '../uuid';
import { useVoiceSession } from '../voice';
import { PullBar } from './PullLaunchpad';
import { PullContextLine } from './PullContextLine';
import { startPullThread } from './startThread';
import { pullThreadDefault, pullThreadOptions } from './threadTo';

/** The empty thread's one line. */
export const PULL_THREAD_EMPTY = 'Ask anything about this pull request. Your first message starts the thread.';
/** The box's placeholder. */
export const PULL_THREAD_PLACEHOLDER = 'Ask about this pull request. Type / for a skill';
/** The thread started but the PR could not be kept as its own: said with the reason; Send again ties it. */
export const PULL_THREAD_UNTIED = 'The thread started, but it isn’t tied to this pull request yet. Press Send again to tie it.';
/** To's list: who gets the first message. */
export const PULL_THREAD_TO = 'Who gets this message';
/** Send with nothing that can take the thread. */
export const PULL_THREAD_NO_AGENT = 'Nothing sent: no agent is running in this project, and none can start here.';

/** Words typed for a PR whose thread was never started, by PR key: kept while the window is open, never saved. */
const unsent = new Map<string, string>();
/** For the tests. */
export const forgetUnsentPullThreads = () => unsent.clear();

const whyOf = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : 'It didn’t go. Try again.');
const SKILLS = inboxSkillFilter(false);

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
  /** Escape, or the bin: back to the PR's page. */
  onLeave: () => void;
  /** Guided review: New review filled in with this PR (the launchpad's Start a guided review). Null: not offered. */
  onGuide: ((opener: HTMLElement) => void) | null;
  onDiff: () => void;
  /** The thread started and is kept as the PR's: the window opens it. */
  onStarted: (threadId: string) => void;
}) {
  const labelId = useId();
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const [section, setSection] = useState<HTMLElement | null>(null);
  const [words, setWords] = useState(() => unsent.get(pr.key) ?? '');
  const { model } = useComposeSessions(true);
  const options = useMemo(() => pullThreadOptions(model, projects), [model, projects.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picked, setPicked] = useState<string | null>(null);
  const fallback = useMemo(() => pullThreadDefault(model, projects, options), [model, options]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosenId = picked && options.some((o) => o.row.session === picked) ? picked : fallback;
  const chosen = options.find((o) => o.row.session === chosenId) ?? null;
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const voice = useVoiceSession();
  // The reply box's own Send keys (the thread's registry), named for screen readers as every Send names them.
  const sendAria = useShortcutAria({ scope: inboxThreadShortcuts, action: 'send' });
  // One key per press series: the same words to the same agent replay the same Send.
  const key = useRef(newUuid());
  const keyFor = useRef('');
  const labels = useMemo(() => Object.fromEntries((model?.projects ?? []).flatMap((g) => g.sessions.filter((s) => s.label).map((s) => [s.session, s.label!] as const))), [model]);
  const folderOf = (session: string) => options.find((o) => o.row.session === session)?.projectName ?? '';

  useEffect(() => {
    textRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (words.trim()) unsent.set(pr.key, words);
    else unsent.delete(pr.key);
  }, [pr.key, words]);

  // Set at once, before React draws the busy Send: two presses in one moment are one Send.
  const inFlight = useRef(false);
  const send = async () => {
    if (inFlight.current || voice.busy) return;
    const text = words.trim();
    if (!text) {
      setError('Write a message first.');
      textRef.current?.focus();
      return;
    }
    if (!chosen) {
      setError(PULL_THREAD_NO_AGENT);
      return;
    }
    const series = `${chosen.row.session}\u0000${text}`;
    if (keyFor.current !== series) {
      key.current = newUuid();
      keyFor.current = series;
    }
    setError(null);
    inFlight.current = true;
    setSending(true);
    try {
      const started = await startPullThread({ stack, words: text, to: chosen.to, project: chosen.project, key: key.current });
      if (started.untied) {
        // The thread is there but not the PR's yet: Send again replays the same start (the same thread) and ties it.
        setError(`${PULL_THREAD_UNTIED} ${started.untied}`);
        inFlight.current = false;
        setSending(false);
        return;
      }
      unsent.delete(pr.key);
      onStarted(started.threadId);
    } catch (cause) {
      setError(whyOf(cause));
      inFlight.current = false;
      setSending(false);
    }
  };

  const pill = phone ? (
    <PhoneReplyRecipient rows={options.map((o) => o.row)} chosen={chosen ? [chosen.row] : []} open={open} onOpen={setOpen} onOnly={(row) => (setPicked(row.session), setOpen(false))} section={section} labels={labels} folderOf={folderOf} title={PULL_THREAD_TO} />
  ) : options.length > 0 ? (
    <ReplyRecipient rows={options.map((o) => o.row)} chosen={chosen ? [chosen.row] : []} open={open} onOpen={setOpen} onOnly={(row) => (setPicked(row.session), setOpen(false))} labels={labels} folderOf={folderOf} title={PULL_THREAD_TO} />
  ) : null;

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
        <div className="ib-pth-empty" data-pull-thread-empty="">
          <p>{PULL_THREAD_EMPTY}</p>
        </div>
      </div>
      <div className="ib-pfoot">
        <div className="ib-rbox" onMouseDown={(event) => event.target === event.currentTarget && textRef.current?.focus()}>
          <div className="ib-rscroll" data-reply-scroll="">
            <InboxComposerField
              value={words}
              onChange={(next) => {
                setWords(next);
                if (error) setError(null);
              }}
              textareaRef={textRef}
              voice={voice}
              voiceNoteGlide
              ariaLabel={`Ask about ${pr.title}`}
              placeholder={PULL_THREAD_PLACEHOLDER}
              destination="your message"
              skillFilter={SKILLS}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.stopPropagation();
                  void send();
                } else if (event.key === 'Escape' && !open) {
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
              <button type="button" className="ib-btn ib-pri ib-rsend" data-reply-send="" onClick={() => void send()} disabled={sending || voice.busy} aria-keyshortcuts={sendAria}>
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
                      unsent.delete(pr.key);
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
