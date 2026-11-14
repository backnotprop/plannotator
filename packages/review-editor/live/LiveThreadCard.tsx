import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { LiveReviewActions } from './useLiveReview';
import { LiveComposer } from './LiveComposer';
import { LiveAuthorMark } from './LiveMark';
import { LiveBody } from './LiveBody';
import { authorName, deliveryWord, type LiveMessage, type PlacedThread } from './model';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const QUIET = 'inline-flex h-6 -my-0.5 items-center rounded px-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground';
export const LIVE_THREAD_SHOWN_WHOLE = 3;

export function LiveMessageRow({ message, messages, onTakeBack, tail }: { message: LiveMessage; messages: readonly LiveMessage[]; onTakeBack?: (id: string) => void; tail?: ReactNode }) {
  const delivery = deliveryWord(message, messages);
  return (
    <div className="flex gap-2 px-3 py-1" data-live-message={message.id} data-author={message.author.kind}>
      <LiveAuthorMark message={message} big />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-[12px] leading-5 text-muted-foreground">
          <span className="flex min-w-0 max-w-full items-baseline gap-x-1.5 whitespace-nowrap">
            <span className="min-w-0 truncate font-medium text-foreground" title={authorName(message)} data-live-author>{authorName(message)}</span>
            <span className="shrink-0">{time(message.created_at)}</span>
            {delivery ? <span className="shrink-0" data-live-delivery={delivery}>· {delivery}</span> : null}
            {delivery === 'Queued' && onTakeBack ? (
              <button type="button" className={`${QUIET} shrink-0`} data-live-take-back data-pn-touch-target onClick={() => onTakeBack(message.id)}>
                Take back
              </button>
            ) : null}
          </span>
          {tail ? <span className="ml-auto flex shrink-0 items-baseline gap-0.5 whitespace-nowrap">{tail}</span> : null}
        </div>
        <LiveBody body={message.body} quiet={QUIET} />
      </div>
    </div>
  );
}

export function LiveThreadCard({ thread, messages, actions }: { thread: PlacedThread; messages: readonly LiveMessage[]; actions: MutableRefObject<LiveReviewActions> }) {
  const { conversation, now } = thread;
  const [open, setOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const replyButton = useRef<HTMLButtonElement>(null);
  const wasReplying = useRef(false);
  useEffect(() => {
    if (wasReplying.current && !replying) replyButton.current?.focus();
    wasReplying.current = replying;
  }, [replying]);
  const shown = useRef<Set<string> | null>(null);
  const firstPaint = shown.current === null;
  if (!shown.current) shown.current = new Set(conversation.messages.map((m) => m.id));
  const resolved = !!conversation.resolved;
  const all = conversation.messages;
  const last = all[all.length - 1]!;
  const first = all[0]!;
  if (resolved && !open) {
    return (
      <div className="live-thread mx-2 my-1 flex items-center gap-2 rounded border border-border bg-card px-3 py-1 text-[12px] leading-5 text-muted-foreground" data-live-thread={conversation.id} data-resolved>
        <span>Resolved</span>
        <span className="min-w-0 flex-1 truncate">{first.body}</span>
        <button type="button" className={QUIET} data-pn-touch-target onClick={() => setOpen(true)}>Show</button>
      </div>
    );
  }
  const folded = !expanded && all.length > LIVE_THREAD_SHOWN_WHOLE ? all.length - 3 : 0;
  const visible = folded > 0 ? [first, ...all.slice(-2)] : all;
  const takeBack = (id: string) => void actions.current.takeBack(id).catch(() => {});
  const controls = (
    <>
      <button ref={replyButton} type="button" className={QUIET} data-live-reply data-pn-touch-target onClick={() => setReplying(true)}>
        Reply
      </button>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        className={QUIET}
        data-live-resolve
        data-pn-touch-target
        onClick={() => {
          void actions.current.resolve(conversation.id, !resolved).catch(() => {});
          setOpen(false);
        }}
      >
        {resolved ? 'Reopen' : 'Resolve'}
      </button>
      {actions.current.postToPR ? (
        actions.current.posted.has(conversation.id) ? (
          <span className="px-1">· On the forge</span>
        ) : (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" className={QUIET} data-live-post data-pn-touch-target onClick={() => void actions.current.postToPR?.([conversation.id]).catch(() => {})}>
              Post
            </button>
          </>
        )
      ) : null}
    </>
  );
  return (
    <div className="live-thread mx-2 my-1 rounded border border-border bg-card py-1" data-live-thread={conversation.id} data-place={now.place}>
      {now.place === 'changed' ? (
        <div className="px-3 py-1 text-[12px] leading-5 text-muted-foreground" data-live-changed>
          <div>Code changed since this comment. It was:</div>
          <pre className="mt-0.5 overflow-x-auto rounded bg-muted px-2 py-0.5 font-mono text-[12px] leading-5 text-muted-foreground">{conversation.anchor.code.join('\n')}</pre>
        </div>
      ) : now.place === 'moved' ? (
        <div className="px-3 py-0.5 text-[12px] leading-5 text-muted-foreground" data-live-moved>
          Moved here from line {conversation.anchor.line_start}.
        </div>
      ) : null}
      {visible.map((message, index) => {
        const arriving = !firstPaint && !shown.current!.has(message.id);
        shown.current!.add(message.id);
        const isLast = message.id === last.id;
        const row = <LiveMessageRow message={message} messages={messages} onTakeBack={takeBack} tail={isLast && !replying ? controls : undefined} />;
        return (
          <div key={message.id}>
            {folded > 0 && index === 1 ? (
              <button type="button" className={`${QUIET} mx-2`} data-live-earlier data-pn-touch-target onClick={() => setExpanded(true)}>
                {folded} earlier {folded === 1 ? 'reply' : 'replies'}
              </button>
            ) : null}
            {arriving ? (
              <div className="live-arrive">
                <div>{row}</div>
              </div>
            ) : (
              row
            )}
          </div>
        );
      })}
      {replying ? (
        <div className="mt-1 border-t border-border px-3 pb-1 pt-2">
          <LiveComposer
            agents={actions.current.agents}
            placeholder="Reply, or @ an agent"
            sendLabel="Reply"
            autoFocus
            onFocus={actions.current.loadAgents}
            onCancel={() => setReplying(false)}
            onSend={async (words, tags) => {
              await actions.current.reply(last.id, words, tags);
              setReplying(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
