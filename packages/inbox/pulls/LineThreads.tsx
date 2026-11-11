import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { InboxPull, InboxPullDetailComment, InboxPullThread } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { relativeTime, relativeWords } from '../relativeTime';
import { DELETED, shortName } from './PullDetails';
import { Face } from './Face';
import { ForgeMarkdown } from './PullDescription';
import { foldedWhy, shownComments, type PlacedThread } from './threadPlaces';

export class ThreadMemory {
  private kept = new Map<string, boolean>();
  private listeners = new Set<() => void>();
  get(key: string): boolean | undefined {
    return this.kept.get(key);
  }
  set(key: string, value: boolean): void {
    this.kept.set(key, value);
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

function useRemembered(memory: ThreadMemory, key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(memory.subscribe, () => memory.get(key));
  return [value ?? initial, (next) => memory.set(key, next)];
}

const firstLine = (text: string) =>
  text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .split('\n')
    .map((row) => row.replace(/^\s*(?:[#>*-]+\s*)+/, '').replace(/[`*_]/g, '').trim())
    .find(Boolean) ?? '';

function When({ at }: { at: string }) {
  if (!at || Number.isNaN(Date.parse(at))) return null;
  const now = Date.now();
  const short = relativeTime(at, now);
  return <span className="ib-lt-at" aria-label={relativeWords(at, now)}>{/^\d+[mhd]$/.test(short) ? `${short} ago` : short}</span>;
}

function Who({ comment }: { comment: InboxPullDetailComment }) {
  const name = comment.author || DELETED;
  return (
    <>
      <Tip cut content={name}>
        <b className="ib-lt-name">{shortName(name)}</b>
      </Tip>
      {comment.bot && <span className="ib-lt-quiet">bot</span>}
    </>
  );
}

function Words({ comment, layer, memory, headSha }: { comment: InboxPullDetailComment; layer: InboxPull; memory: ThreadMemory; headSha?: string | null }) {
  const [all, setAll] = useRemembered(memory, `all:${comment.id}`, false);
  const box = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || all) return;
    const measure = () => setTall(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [all, comment.body]);
  return (
    <>
      <div ref={box} className="ib-lt-words" data-clamped={all ? undefined : ''}>
        <ForgeMarkdown markdown={comment.body} layer={layer} headSha={headSha} />
      </div>
      {(tall || all) && (
        <button type="button" className="ib-lt-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  );
}

function OneComment({ comment, layer, memory, headSha, link }: { comment: InboxPullDetailComment; layer: InboxPull; memory: ThreadMemory; headSha?: string | null; link?: ReactNode }) {
  const forge = layer.platform === 'gitlab' ? 'GitLab' : 'GitHub';
  const [shown, setShown] = useRemembered(memory, `hidden:${comment.id}`, false);
  return (
    <div className="ib-lt-c" data-pull-thread-comment={comment.id}>
      <Face login={comment.author} host={layer.host} size={20} bot={comment.bot} />
      <div className="ib-lt-cm">
        <div className="ib-lt-h">
          <Who comment={comment} />
          <When at={comment.at} />
          {link}
        </div>
        {comment.hidden !== undefined && !shown ? (
          <button type="button" className="ib-lt-more" onClick={() => setShown(true)} data-pull-thread-hidden={comment.hidden}>
            {`Hidden on ${forge}${comment.hidden ? ` as ${comment.hidden.replace(/-/g, ' ')}` : ''}. Show`}
          </button>
        ) : (
          <Words comment={comment} layer={layer} memory={memory} headSha={headSha} />
        )}
      </div>
    </div>
  );
}

const WHERE_WORDS: Record<PlacedThread['where'], string | null> = {
  line: null,
  outdated: 'Outdated: a later push changed its lines',
  elsewhere: 'On a line this diff does not show',
};

function FoldedWords({ thread, layer }: { thread: InboxPullThread; layer: InboxPull }) {
  const forge = layer.platform === 'gitlab' ? 'GitLab' : 'GitHub';
  const first = thread.comments[0]!;
  const count = thread.comments.length;
  const why = foldedWhy(thread);
  const whyWord = why === 'resolved' ? 'Resolved' : why === 'bot' ? 'Bots only' : null;
  return (
    <>
      <Face login={first.author} host={layer.host} size={20} bot={first.bot} />
      <b className="ib-lt-name">{shortName(first.author || DELETED)}</b>
      {first.bot && <span className="ib-lt-quiet">bot</span>}
      <span className="ib-lt-line">{first.hidden !== undefined ? `Hidden on ${forge}` : firstLine(first.body)}</span>
      {count > 1 && <span className="ib-lt-quiet ib-lt-n" aria-label={`${count} comments`}>{count}</span>}
      {whyWord && <span className="ib-lt-quiet" data-pull-thread-why="">{whyWord}</span>}
    </>
  );
}

function ThreadComments({ thread, layer, memory, headSha }: { thread: InboxPullThread; layer: InboxPull; memory: ThreadMemory; headSha?: string | null }) {
  const [whole, setWhole] = useRemembered(memory, `whole:${thread.id}`, false);
  const forge = layer.platform === 'gitlab' ? 'GitLab' : 'GitHub';
  const first = thread.comments[0]!;
  const { shown, between } = shownComments(thread.comments, whole);
  const link = first.url ? (
    <Tip content={`Open on ${forge}`}>
      <a className="ib-lt-open" href={first.url} target="_blank" rel="noreferrer noopener" aria-label={`Open this thread on ${forge}`}>
        <Icon name="external" size={13} />
      </a>
    </Tip>
  ) : null;
  return (
    <>
      {shown.map((comment, index) => (
        <div key={comment.id} className="ib-lt-step">
          <OneComment comment={comment} layer={layer} memory={memory} headSha={headSha} link={index === 0 ? link : undefined} />
          {between > 0 && index === 0 && (
            <button type="button" className="ib-lt-between" onClick={() => setWhole(true)} data-pull-thread-between={between}>
              {between} more
            </button>
          )}
        </div>
      ))}
    </>
  );
}

export function LineThread({ placed, layer, memory, headSha }: { placed: PlacedThread; layer: InboxPull; memory: ThreadMemory; headSha?: string | null }) {
  const { thread, where } = placed;
  const why = foldedWhy(thread);
  const [open, setOpen] = useRemembered(memory, `open:${thread.id}`, why === null);
  const whyWord = why === 'resolved' ? 'Resolved' : why === 'bot' ? 'Bots only' : null;
  const whereWords = WHERE_WORDS[where];
  const span = thread.start_line !== null && thread.line !== null && where === 'line' ? `Lines ${thread.start_line}–${thread.line}` : null;
  const common = { 'data-pull-thread': thread.id, 'data-pull-thread-where': where, 'data-voice': why === 'bot' ? 'bot' : 'person' };
  if (!open) {
    return (
      <button type="button" className="ib-lt ib-lt-fold" aria-expanded={false} onClick={() => setOpen(true)} data-pull-thread-folded={why ?? ''} {...common}>
        <FoldedWords thread={thread} layer={layer} />
        <Icon name="chevR" size={13} />
      </button>
    );
  }
  return (
    <div className="ib-lt" data-open="" {...common}>
      {(why || whereWords || span || thread.outdated) && (
        <div className="ib-lt-top">
          {why && (
            <button type="button" className="ib-lt-refold" aria-expanded onClick={() => setOpen(false)} data-pull-thread-refold="">
              <Icon name="chevD" size={13} />
              {whyWord}
            </button>
          )}
          {whereWords ? <span>{whereWords}</span> : thread.outdated ? <span>Outdated</span> : null}
          {span && <span>{span}</span>}
        </div>
      )}
      <ThreadComments thread={thread} layer={layer} memory={memory} headSha={headSha} />
    </div>
  );
}

/** A folded band's height, fixed so the file's header can be sized for it before it is drawn (one line; two on a phone). */
export const FILE_BAND_HEIGHT = 32;
export const FILE_BAND_HEIGHT_PHONE = 52;

export const fileThreadOpen = (memory: ThreadMemory, threadId: string): boolean => memory.get(`open:${threadId}`) ?? false;

export function FileThread({ thread, layer, memory, headSha, open, phone = false }: { thread: InboxPullThread; layer: InboxPull; memory: ThreadMemory; headSha?: string | null; open: boolean; phone?: boolean }) {
  const why = foldedWhy(thread);
  const setOpen = (value: boolean) => memory.set(`open:${thread.id}`, value);
  const count = thread.comments.length;
  const common = { 'data-pull-thread': thread.id, 'data-pull-thread-where': 'file', 'data-voice': why === 'bot' ? 'bot' : 'person' };
  const on = (
    <>
      <Icon name="comment" size={13} />
      <span className="ib-ft-on">On this file</span>
      <span className="ib-ft-dot" aria-hidden="true">·</span>
    </>
  );
  if (!open) {
    return (
      <button type="button" className={`ib-lt ib-lt-fold ib-ft${phone ? ' ib-ft-phone' : ''}`} aria-expanded={false} onClick={() => setOpen(true)} data-pull-thread-folded={why ?? ''} {...common}>
        <Icon name="chevR" size={13} />
        {on}
        <FoldedWords thread={thread} layer={layer} />
        <When at={thread.comments[0]!.at} />
      </button>
    );
  }
  return (
    <div className="ib-lt ib-ft" data-open="" {...common}>
      <button type="button" className="ib-ft-top" aria-expanded onClick={() => setOpen(false)} data-pull-thread-refold="">
        <Icon name="chevD" size={13} />
        {on}
        <span className="ib-ft-n">{count === 1 ? '1 comment' : `${count} comments`}</span>
        {why && <span className="ib-lt-quiet" data-pull-thread-why="">{why === 'resolved' ? 'Resolved' : 'Bots only'}</span>}
      </button>
      <div className="ib-ft-body">
        <ThreadComments thread={thread} layer={layer} memory={memory} headSha={headSha} />
      </div>
    </div>
  );
}
