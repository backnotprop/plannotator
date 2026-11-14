/**
 * Add tag (approval "inbox-thread-tags", step 1), for the row's right-click menu and the thread's ⋯: the item, and the
 * list it swaps the menu for in place, as Snooze swaps in its times. `‹ Add tag` goes back; a "Find or make a tag" field
 * (focused) narrows the tags; each tag is a plain name with its quiet count and a tick, and a tick never closes the menu
 * (several tags allowed; untick takes the thread out). A typed name that is no tag offers `New tag “Billing”`, which
 * makes it and tags the thread; Enter in the field ticks the tag it names, or makes it.
 * Draw inside a Base UI `Menu.Popup` or `ContextMenu.Popup`; the tags come from `ThreadTagsContext`.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Menu } from '@base-ui/react/menu';
import { focusAfterSwap } from '@plannotator/ui/components/inbox-thread/SnoozeMenu';
import { Icon } from '../icons';
import { findTags, tagNamed, useThreadTags } from '../threadTags';
import { TagIcon } from './InitiativePeek';

/** The menu's Add tag item: how many tags the thread is in, and the chevron of a list that swaps in. */
export function AddTagItem({ threadId, onOpen }: { threadId: string; onOpen: () => void }) {
  const host = useThreadTags();
  if (!host || !host.can(threadId)) return null;
  const n = host.tagsOf(threadId).length;
  return (
    <Menu.Item className="ib-pmi" label="Add tag" closeOnClick={false} onClick={onOpen} data-add-tag-item="">
      <TagIcon size={15} />
      Add tag
      <span className="ib-zsub">
        {n > 0 && <span className="ib-tagm-n">{n}</span>}
        <Icon name="chevR" size={13} />
      </span>
    </Menu.Item>
  );
}

/** The swapped-in list. */
export function AddTagList({ threadId, onBack }: { threadId: string; onBack: () => void }) {
  const host = useThreadTags();
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // The menu keeps focus on an item the swap took away: the field takes it.
  useLayoutEffect(() => focusAfterSwap(() => field.current), []);
  if (!host) return null;
  const on = new Set(host.tagsOf(threadId));
  const shown = findTags(host.tags, query);
  const typed = query.trim();
  const exact = typed ? tagNamed(host.tags, typed) : null;
  const create = () => {
    host.createAndSet(threadId, typed);
    setQuery('');
    field.current?.focus({ preventScroll: true });
  };
  // The field's keys are its own (the menu would take letters for its type-ahead); Escape still closes the menu,
  // Down goes to the first tag, Enter ticks the tag the field names or makes it.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') return;
    event.stopPropagation();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      body.current?.querySelector<HTMLElement>('[data-tag-pick], [data-tag-new]')?.focus({ preventScroll: true });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (exact) host.set(threadId, exact, !on.has(exact.id));
      else if (typed) create();
    }
  };
  return (
    <div ref={body} data-add-tag-list="">
      <Menu.Item className="ib-pmi ib-zb" label="Add tag" closeOnClick={false} onClick={onBack} data-add-tag-back="">
        <Icon name="chevL" size={14} />
        Add tag
      </Menu.Item>
      <Menu.Separator className="ib-pm-sep" />
      <label className="ib-tagm-find">
        <Icon name="search" size={15} />
        <input ref={field} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Find or make a tag" aria-label="Find or make a tag" autoComplete="off" spellCheck={false} data-tag-find="" />
      </label>
      {shown.map((tag) => {
        const ticked = on.has(tag.id);
        const count = host.counts.get(tag.id) ?? 0;
        return (
          <Menu.CheckboxItem key={tag.id} className="ib-pmi" label={tag.name} checked={ticked} onCheckedChange={(next: boolean) => host.set(threadId, tag, next)} closeOnClick={false} data-tag-pick={tag.id}>
            <span className="ib-tagm-l" dir="auto">
              {tag.name}
            </span>
            {count > 0 && <span className="ib-tagm-n">{count}</span>}
            {ticked ? <Icon name="check" size={15} className="ib-pmi-check ib-tagm-tick" /> : <span className="ib-tagm-slot" aria-hidden="true" />}
          </Menu.CheckboxItem>
        );
      })}
      {(shown.length > 0 || typed) && <Menu.Separator className="ib-pm-sep" />}
      {typed && !exact ? (
        <Menu.Item className="ib-pmi" label={`New tag “${typed}”`} closeOnClick={false} onClick={create} data-tag-new="">
          <Icon name="plus" size={15} />
          <span className="ib-tagm-l" dir="auto">
            New tag “{typed}”
          </span>
        </Menu.Item>
      ) : !typed ? (
        <Menu.Item className="ib-pmi ib-tagm-quiet" label="New tag" closeOnClick={false} onClick={() => field.current?.focus({ preventScroll: true })} data-tag-new-focus="">
          <Icon name="plus" size={15} />
          New tag…
        </Menu.Item>
      ) : null}
    </div>
  );
}
