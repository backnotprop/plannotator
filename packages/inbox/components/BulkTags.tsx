/**
 * Add tag on the picked threads (PickBar.tsx), swapped in place as a single thread's Add tag list is (AddTagMenu.tsx):
 * each tag ticked when every picked thread is in it, half ticked with "2 of 3" when some are. A press on a tag that not
 * all are in puts the rest in it; on a ticked tag it takes them all out. One toast and one Undo (useThreadTagsHost.ts
 * `setMany`). Only the threads that take tags from here count (a linked machine's on an Inbox that keeps none do not).
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Menu } from '@base-ui/react/menu';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { focusAfterSwap } from '@plannotator/ui/components/inbox-thread/SnoozeMenu';
import { Icon } from '../icons';
import { findTags, useThreadTags } from '../threadTags';

/** Add tag is offered on the picks: the Inbox keeps tags and one of the picked threads takes them. */
export function useBulkTagsShown(rows: readonly InboxListRow[]): boolean {
  const host = useThreadTags();
  return !!host?.setMany && rows.some((row) => host.can(row.thread_id));
}

export function BulkTagList({ threadIds, onBack }: { threadIds: readonly string[]; onBack: () => void }) {
  const host = useThreadTags();
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => focusAfterSwap(() => field.current), []);
  if (!host?.setMany) return null;
  const ids = threadIds.filter((id) => host.can(id));
  const shown = findTags(host.tags, query);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') return;
    event.stopPropagation();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      body.current?.querySelector<HTMLElement>('[data-tag-pick]')?.focus({ preventScroll: true });
    }
  };
  return (
    <div ref={body} data-add-tag-list="" data-bulk-tags="">
      <Menu.Item className="ib-pmi ib-zb" label="Add tag" closeOnClick={false} onClick={onBack} data-add-tag-back="">
        <Icon name="chevL" size={14} />
        Add tag
      </Menu.Item>
      <Menu.Separator className="ib-pm-sep" />
      <label className="ib-tagm-find">
        <Icon name="search" size={15} />
        <input ref={field} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Find a tag" aria-label="Find a tag" autoComplete="off" spellCheck={false} data-tag-find="" />
      </label>
      {shown.map((tag) => {
        const inIt = ids.filter((id) => host.tagsOf(id).includes(tag.id));
        const all = inIt.length > 0 && inIt.length === ids.length;
        const some = inIt.length > 0 && !all;
        return (
          <Menu.CheckboxItem
            key={tag.id}
            className="ib-pmi"
            label={tag.name}
            checked={all}
            aria-checked={some ? 'mixed' : all}
            closeOnClick={false}
            onCheckedChange={() => host.setMany!(all ? ids : ids.filter((id) => !inIt.includes(id)), tag, !all)}
            data-tag-pick={tag.id}
          >
            <span className="ib-tagm-l" dir="auto">
              {tag.name}
            </span>
            {some && <span className="ib-tagm-n">{`${inIt.length} of ${ids.length}`}</span>}
            {all ? <Icon name="check" size={15} className="ib-pmi-check ib-tagm-tick" /> : some ? <Icon name="minus" size={15} className="ib-pmi-check ib-tagm-tick" /> : <span className="ib-tagm-slot" aria-hidden="true" />}
          </Menu.CheckboxItem>
        );
      })}
    </div>
  );
}
