import { useState, type MutableRefObject } from 'react';
import type { LiveReviewActions } from './useLiveReview';
import { LiveComposer } from './LiveComposer';
import { authorName, deliveryWord, type LiveMessage, type PlacedThread } from './model';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function LiveMessageRow({ message, messages }: { message: LiveMessage; messages: readonly LiveMessage[] }) {
  const delivery = deliveryWord(message, messages);
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2" data-live-message={message.id} data-author={message.author.kind}>
      <div className="flex items-baseline gap-1.5 text-[12px] text-muted-foreground">
        <span className="font-medium text-foreground">{authorName(message)}</span>
        <span>{time(message.created_at)}</span>
        {delivery ? <span data-live-delivery={delivery}>· {delivery}</span> : null}
        {message.review_addressed ? <span>· marked addressed{message.review_addressed.commit ? ` in ${message.review_addressed.commit.slice(0, 7)}` : ''}</span> : null}
      </div>
      <div className="whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground">{message.body}</div>
    </div>
  );
}

export function LiveThreadCard({ thread, messages, actions }: { thread: PlacedThread; messages: readonly LiveMessage[]; actions: MutableRefObject<LiveReviewActions> }) {
  const { conversation, now } = thread;
  const [open, setOpen] = useState(false);
  const resolved = !!conversation.resolved;
  const last = conversation.messages[conversation.messages.length - 1]!;
  const first = conversation.messages[0]!;
  if (resolved && !open) {
    return (
      <div className="live-thread mx-2 my-1 flex items-center gap-2 rounded border border-border bg-card px-3 py-1.5 text-[12px] text-muted-foreground" data-live-thread={conversation.id} data-resolved>
        <span>Resolved</span>
        <span className="min-w-0 flex-1 truncate">{first.body}</span>
        <button type="button" className="text-foreground hover:underline" onClick={() => setOpen(true)}>Show</button>
      </div>
    );
  }
  return (
    <div className="live-thread mx-2 my-1 rounded border border-border bg-card" data-live-thread={conversation.id} data-place={now.place}>
      {now.place === 'changed' ? (
        <div className="border-b border-border px-3 py-2 text-[12px] text-muted-foreground" data-live-changed>
          <div>The code here changed since this comment. It was:</div>
          <pre className="mt-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-[12px] leading-5">{conversation.anchor.code.join('\n')}</pre>
        </div>
      ) : now.place === 'moved' ? (
        <div className="border-b border-border px-3 py-1.5 text-[12px] text-muted-foreground" data-live-moved>
          Moved here from line {conversation.anchor.line_start}.
        </div>
      ) : null}
      <div className="divide-y divide-border">
        {conversation.messages.map((message) => (
          <LiveMessageRow key={message.id} message={message} messages={messages} />
        ))}
      </div>
      <div className="border-t border-border px-3 py-2">
        <LiveComposer
          agents={actions.current.agents}
          placeholder="Reply, or @ an agent"
          sendLabel="Reply"
          onFocus={actions.current.loadAgents}
          onSend={(words, tags) => actions.current.reply(last.id, words, tags)}
        />
        <div className="mt-1 flex justify-start">
          <button
            type="button"
            className="h-7 rounded px-2 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
            data-live-resolve
            onClick={() => {
              void actions.current.resolve(conversation.id, !resolved).catch(() => {});
              setOpen(false);
            }}
          >
            {resolved ? 'Reopen' : 'Resolve'}
          </button>
        </div>
      </div>
    </div>
  );
}
