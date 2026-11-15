/**
 * A Tags row and a "Threads tagged …" row in the search palette (tagSearch.ts), drawn as the Shape rows are: the
 * mark, the name, the quiet words on the right. `common` is the palette's option wiring (id, role, selection, keys).
 */
import type { HTMLAttributes } from 'react';
import { AuthorMark } from '../icons';
import { TagIcon } from '../components/InitiativePeek';
import type { SearchOption } from './model';

export function TagSearchRow({ option, common }: { option: Extract<SearchOption, { kind: 'tag' | 'tag-thread' }>; common: HTMLAttributes<HTMLDivElement> }) {
  if (option.kind === 'tag') {
    const tag = option.tag;
    return (
      <div className="ib-sp-row" {...common} data-result="tag" data-result-id={tag.id}>
        <span className="ib-sp-mark" aria-hidden="true">
          <TagIcon className="ib-sp-mk" />
        </span>
        <span className="ib-sp-rs">
          <span className="ib-sp-p" dir="auto">
            {tag.name}
          </span>
        </span>
        <span className="ib-sp-time ib-sp-shape-meta">
          <span className="ib-sr">, </span>
          {tag.meta}
        </span>
      </div>
    );
  }
  const thread = option.thread;
  return (
    <div className="ib-sp-row" {...common} data-result="tagged" data-result-id={thread.id}>
      <span className="ib-sp-mark" aria-hidden="true">
        <AuthorMark author={thread.agent} />
      </span>
      <span className="ib-sp-rs">
        <span className="ib-sp-p" dir="auto">
          {thread.title}
        </span>
      </span>
      <span className="ib-sp-time ib-sp-shape-meta">
        <span className="ib-sr">, </span>
        {thread.meta}
      </span>
    </div>
  );
}
