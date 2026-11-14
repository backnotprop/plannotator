import type { MutableRefObject } from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { LiveReviewActions } from './useLiveReview';
import { LiveComposer } from './LiveComposer';
import type { PRReviewThread } from '@plannotator/shared/pr-types';
import { agentLabel, authorName, threadLines, type PlacedThread } from './model';
import { prThreadPlace } from './PRThreadCard';

const short = (path: string) => path.split('/').pop() ?? path;
const ICON = 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';

function UnsentRow({ comment, onSend }: { comment: CodeAnnotation; onSend: () => void }) {
  const lines = comment.scope === 'file' || comment.lineStart <= 0 ? 'file' : comment.lineStart === comment.lineEnd ? `${comment.lineStart}` : `${comment.lineStart}–${comment.lineEnd}`;
  return (
    <li className="flex items-start gap-2 px-3 py-1.5" data-live-unsent={comment.id}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-muted-foreground" title={comment.filePath}>{short(comment.filePath)}:{lines}</div>
        <div className="line-clamp-2 text-[13px] leading-5 text-foreground">{comment.text}</div>
      </div>
      <button type="button" className="h-7 shrink-0 rounded px-2 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onSend}>
        Send
      </button>
    </li>
  );
}

function ThreadRow({ thread, focused, posted, onOpen }: { thread: PlacedThread; focused: boolean; posted: boolean; onOpen: () => void }) {
  const { conversation, now } = thread;
  const last = conversation.messages[conversation.messages.length - 1]!;
  const state = conversation.resolved ? 'Resolved' : now.place === 'changed' ? 'Code changed' : now.place === 'unknown' ? 'Not in this diff' : null;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={focused ? 'true' : undefined}
        data-live-row={conversation.id}
        className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-muted ${focused ? 'bg-muted' : ''} ${conversation.resolved ? 'opacity-60' : ''}`}
      >
        <span className="flex gap-1.5 text-[12px] text-muted-foreground">
          <span className="truncate" title={conversation.anchor.file}>{short(conversation.anchor.file)}</span>
          <span>{threadLines(now)}</span>
          {state ? <span>· {state}</span> : null}
          {posted ? <span>· On the forge</span> : null}
        </span>
        <span className="line-clamp-2 text-[13px] leading-5 text-foreground">{conversation.messages[0]!.body}</span>
        {conversation.messages.length > 1 ? (
          <span className="text-[12px] text-muted-foreground">
            {conversation.messages.length - 1} {conversation.messages.length === 2 ? 'reply' : 'replies'}, last from {authorName(last)}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export function LiveThreadsTab(props: {
  placed: readonly PlacedThread[];
  unsent: readonly CodeAnnotation[];
  order: readonly string[];
  focused: string | null;
  onStep: (direction: 1 | -1) => void;
  threadUrl: string | null;
  pr: { forge: string; platform: string; threads: readonly PRReviewThread[] | null; load: () => void } | null;
  actions: MutableRefObject<LiveReviewActions>;
}) {
  const actions = props.actions.current;
  const to = actions.defaultTo ? agentLabel(actions.defaultTo) : null;
  const resolvedCount = props.placed.filter((p) => p.conversation.resolved).length;
  return (
    <div className="flex flex-col text-[13px]" data-live-tab>
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        <span className="whitespace-nowrap text-[12px] text-muted-foreground" data-live-count>
          {props.order.length} open{resolvedCount > 0 ? ` · ${resolvedCount} resolved` : ''}
        </span>
        <span className="flex-1" />
        {props.threadUrl ? (
          <a href={props.threadUrl} target="_blank" rel="noreferrer" title="Open in Inbox" aria-label="Open in Inbox" className={ICON} data-live-inbox-link>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </a>
        ) : null}
        <button type="button" disabled={props.order.length === 0} title="Previous open thread" aria-label="Previous open thread" className={ICON} onClick={() => props.onStep(-1)}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 10 4-4 4 4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button type="button" disabled={props.order.length === 0} title="Next open thread" aria-label="Next open thread" className={ICON} onClick={() => props.onStep(1)}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      {actions.error ? (
        <div role="alert" className="border-b border-border px-3 py-2 text-[12px] text-foreground">
          {actions.error}
        </div>
      ) : null}
      {props.unsent.length > 0 ? (
        <section className="border-b border-border py-1" aria-label="Not sent yet">
          <h3 className="px-3 py-1 text-[12px] font-medium text-muted-foreground">Not sent yet</h3>
          <ul>
            {props.unsent.map((comment) => (
              <UnsentRow key={comment.id} comment={comment} onSend={() => void actions.sendComments([comment], '', []).catch(() => {})} />
            ))}
          </ul>
          <div className="px-3 pb-2 pt-1">
            <LiveComposer
              agents={actions.agents}
              allowEmpty
              placeholder={to ? `To ${to}. Add a note or @ another agent` : '@ an agent to send these to'}
              sendLabel={props.unsent.length === 1 ? 'Send' : `Send all ${props.unsent.length}`}
              onFocus={actions.loadAgents}
              onSend={(words, tags) => actions.sendComments(props.unsent, words, tags)}
            />
          </div>
        </section>
      ) : null}
      {props.pr && actions.postToPR && props.order.some((id) => !actions.posted.has(id)) ? (
        <div className="flex items-center border-b border-border px-3 py-1.5">
          <button
            type="button"
            className="h-7 rounded px-2 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
            data-live-post-all
            onClick={() => void actions.postToPR?.(props.order.filter((id) => !actions.posted.has(id))).catch(() => {})}
          >
            Post {props.order.filter((id) => !actions.posted.has(id)).length} open threads to the {props.pr.forge === 'GitLab' ? 'merge request' : 'pull request'}
          </button>
        </div>
      ) : null}
      {props.pr ? <PRThreadsSection pr={props.pr} onOpen={(path, line, side) => actions.revealLines(path, line, side)} /> : null}
      {props.placed.length === 0 && props.unsent.length === 0 ? (
        <p className="px-3 py-3 text-[12px] leading-5 text-muted-foreground">
          Comments you send to an agent become threads here. Write a comment on a line, then send it from this tab.
        </p>
      ) : (
        <ul className="py-1">
          {[...props.placed].sort((a, b) => a.conversation.anchor.file.localeCompare(b.conversation.anchor.file) || a.now.line_start - b.now.line_start).map((thread) => (
            <ThreadRow key={thread.conversation.id} thread={thread} focused={props.focused === thread.conversation.id} posted={actions.posted.has(thread.conversation.id)} onOpen={() => actions.reveal(thread)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PRThreadsSection({ pr, onOpen }: { pr: { forge: string; threads: readonly PRReviewThread[] | null; load: () => void }; onOpen: (path: string, line: number, side: 'old' | 'new') => void }) {
  const where = pr.forge === 'GitLab' ? 'merge request' : 'pull request';
  const open = (pr.threads ?? []).filter((t) => !t.isResolved);
  return (
    <section className="border-b border-border py-1" aria-label={`On the ${where}`}>
      <h3 className="px-3 py-1 text-[12px] font-medium text-muted-foreground">On the {where}</h3>
      {pr.threads === null ? (
        <div className="px-3 pb-2">
          <button type="button" className="h-7 rounded px-2 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground" onClick={pr.load} data-pr-threads-load>
            Show its threads on the lines
          </button>
        </div>
      ) : open.length === 0 ? (
        <p className="px-3 pb-2 text-[12px] text-muted-foreground">No open threads on the {where}.</p>
      ) : (
        <ul>
          {open.map((thread) => {
            const place = prThreadPlace(thread);
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  disabled={!place}
                  onClick={() => place && onOpen(thread.path, place.line, place.side)}
                  className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-muted disabled:cursor-default"
                  data-pr-row={thread.id}
                >
                  <span className="flex gap-1.5 text-[12px] text-muted-foreground">
                    <span className="truncate" title={thread.path}>{short(thread.path)}</span>
                    {place ? <span>line {place.line}</span> : null}
                    {thread.isOutdated ? <span>· Outdated</span> : null}
                    <span>· {thread.comments[0]?.author ?? ''}</span>
                  </span>
                  <span className="line-clamp-2 text-[13px] leading-5 text-foreground">{thread.comments[0]?.body ?? ''}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
