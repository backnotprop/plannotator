import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { holdPageMarkAbove } from '@plannotator/ui/utils/pageMarks';
import { inboxAgentName, type InboxMessage } from '@plannotator/core/inbox-types';
import type { InboxThreadSwarm } from '@plannotator/core/inbox-swarm-types';
import { InlineMarkdown, SoftLineBreaksContext } from '@plannotator/ui/components/InlineMarkdown';
import { AuthorMark, Icon } from '../icons';
import { whenTime } from '../format';
import { Tip } from '../components/Tip';
import { GhostGlyph } from './GhostGlyph';
import { GhostTo } from './GhostTo';
import { swarmApi, type SwarmRead } from './swarmApi';
import { ghostFromWords, ghostToWords } from './swarmModel';

/**
 * The ghost pane (approval "inbox-swarm-thread-ui", shots 5 and 7): a swarm thread's ghost thread, beside the thread
 * the way a file is (useThreadSwarm.ts says when it covers the thread instead). Its header: the ghost (GhostGlyph, the
 * full cut), "Ghost thread" and how many messages it holds. Then the agents' words, oldest first, each headed "X to Y" or
 * "X to everyone", drawn as the thread draws a message (the person's own to the left, like the rest). Its box writes to
 * every member, or to one picked in its "to" (the reply's recipient chip), as the person (`POST .../swarm` `say`).
 * No Pause in this piece. A phone shows it as its own page; "‹ <thread title>" goes back.
 */
export function GhostPane({
  threadId,
  title,
  swarm,
  phone,
  full,
  onClose,
}: {
  threadId: string;
  /** The thread's title: the way back's words on a phone (and a covered thread). */
  title: string;
  swarm: InboxThreadSwarm;
  phone: boolean;
  /** It covers the thread (a phone, a window too narrow for both). */
  full: boolean;
  onClose: () => void;
}) {
  const [read, setRead] = useState<SwarmRead | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Read on open and whenever the thread's swarm changed (a member's words, its state; the stream reads the thread
  // again for each). New words while it is open are seen at once: the Ghost button's count stays at none.
  const key = JSON.stringify(swarm);
  useEffect(() => {
    let live = true;
    const unread = swarm.ghost_unread ?? 0;
    (unread > 0 ? swarmApi.seen(threadId) : swarmApi.read(threadId)).then(
      (answer) => {
        if (!live) return;
        setRead(answer);
        setFailed(null);
      },
      (cause: unknown) => live && setFailed(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      live = false;
    };
    // `key` is the swarm as the thread read last said it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, key]);

  useEffect(() => {
    sectionRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!sectionRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ghost = read?.ghost ?? [];
  // The newest words in view, as a thread opens at its end.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [ghost.length]);

  // Beside the thread, the list column steps aside (swarm.css): `.pn-inbox` holds `data-ib-ghost-beside` while it is,
  // an attribute in place of a `:has()` on the window's root (packages/inbox/pageMarks.ts says why).
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (full || !section) return;
    return holdPageMarkAbove(section, '.pn-inbox', 'data-ib-ghost-beside');
  }, [full]);

  const members = (read?.swarm ?? swarm).members.filter((m) => m.joined);
  const on = (read?.swarm ?? swarm).on;
  return (
    <section ref={sectionRef} tabIndex={-1} className={`ib-view ib-ghostpane${full ? ' ib-full' : ''}${phone ? ' ib-phone' : ''}`} aria-label="Ghost thread" data-ghost-pane="">
      {full && (
        <div className="ib-ghost-back">
          <button type="button" className="ib-pback" onClick={onClose} aria-label={`Back to ${title}`} data-ghost-back="">
            <Icon name="chevL" size={18} />
            <span className="ib-pback-l">{title}</span>
          </button>
        </div>
      )}
      <div className="ib-ghost-head">
        <GhostGlyph size={phone ? 24 : 22} className="ib-ghost-accent" />
        <h2 className="ib-ghost-t">Ghost thread</h2>
        {read && ghost.length > 0 && (
          <span className="ib-ghost-n" data-ghost-count="">
            {ghost.length}
          </span>
        )}
        {!full && (
          <span className="ib-ghost-of" dir="auto">
            · {title}
          </span>
        )}
        <span className="ib-sp" />
        {!full && (
          <Tip content="Close the ghost thread">
            <button type="button" className="ib-iconbtn" aria-label="Close the ghost thread" onClick={onClose} data-ghost-close="">
              <Icon name="x" size={16} />
            </button>
          </Tip>
        )}
      </div>
      <div ref={bodyRef} className="ib-ghost-body" data-ghost-body="">
        {failed && !read && (
          <p className="ib-ghost-err" role="alert">
            {failed}
          </p>
        )}
        {read && ghost.length === 0 && (
          <div className="ib-ghost-empty" data-ghost-empty="">
            <GhostGlyph size={76} className="ib-ghost-accent" />
            <p className="ib-ghost-empty-t">No ghost messages yet</p>
            <p className="ib-ghost-empty-s">When the agents talk to each other, it shows up here.</p>
          </div>
        )}
        {ghost.map((message) => (
          <GhostMessage key={message.id} message={message} />
        ))}
      </div>
      {on ? (
        <GhostBox threadId={threadId} members={members.map((m) => m.name)} onSaid={setRead} />
      ) : (
        <p className="ib-ghost-offline" data-ghost-off="">
          The swarm is off: nothing is sent from here.
        </p>
      )}
    </section>
  );
}

/** One message of the ghost thread: who wrote it, to whom, when, then its words. */
function GhostMessage({ message }: { message: InboxMessage }) {
  const from = ghostFromWords(message, (author) => (author.kind === 'agent' ? (author.name ?? inboxAgentName(author)) : 'You'));
  const paragraphs = message.body.split(/\n{2,}/).filter((p) => p.trim() !== '');
  return (
    <article className="ib-ghost-msg" data-ghost-message={message.id} data-from={message.author.kind}>
      <span className="ib-ghost-mk" aria-hidden="true">
        {message.author.kind === 'agent' ? (
          <AuthorMark author={message.author} />
        ) : (
          <span className="ib-mk">
            <Icon name="reply" />
          </span>
        )}
      </span>
      <div className="ib-ghost-main">
        <div className="ib-ghost-line">
          <b className="ib-ghost-from">
            <bdi>{from}</bdi>
          </b>
          <span className="ib-ghost-msgto">to {ghostToWords(message)}</span>
          <span className="ib-sp" />
          <time className="ib-ghost-tm" dateTime={message.created_at}>
            {whenTime(message.created_at)}
          </time>
        </div>
        <SoftLineBreaksContext.Provider value={true}>
          <div className="ib-ghost-words" dir="auto">
            {paragraphs.map((p, i) => (
              <p key={i}>
                <InlineMarkdown text={p} />
              </p>
            ))}
          </div>
        </SoftLineBreaksContext.Provider>
      </div>
    </article>
  );
}

/** The person's words to the agents: to everyone, or to the one the "to" names. */
function GhostBox({ threadId, members, onSaid }: { threadId: string; members: readonly string[]; onSaid: (read: SwarmRead) => void }) {
  const [text, setText] = useState('');
  const [to, setTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A member who left is no longer one to pick.
  useEffect(() => {
    if (to && !members.includes(to)) setTo(null);
  }, [to, members]);
  const send = () => {
    const words = text.trim();
    if (!words || sending) return;
    setSending(true);
    setError(null);
    swarmApi.say(threadId, words, to).then(
      (read) => {
        setSending(false);
        setText('');
        onSaid(read);
      },
      (cause: unknown) => {
        setSending(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };
  return (
    <div className="ib-ghost-box" data-ghost-box="">
      {error && (
        <p className="ib-ghost-err" role="alert">
          {error}
        </p>
      )}
      <div className="ib-ghost-field">
        <GhostTo members={members} to={to} onTo={setTo} />
        <textarea className="ib-ghost-in" rows={1} value={text} placeholder="Write to the agents" aria-label={`Write to ${to ?? 'every agent'} in the ghost thread`} onChange={(event) => setText(event.target.value)} data-ghost-input="" />
      </div>
      <div className="ib-ghost-acts">
        <button type="button" className="ib-btn ib-pri" disabled={!text.trim() || sending} onClick={send} data-ghost-send="">
          Send
        </button>
      </div>
    </div>
  );
}
