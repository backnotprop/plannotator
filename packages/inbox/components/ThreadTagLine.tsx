/**
 * The thread header's tag line (approval "inbox-thread-tags", step 2): under the subject, one `#` and the thread's
 * tags as plain names (`#  Release  Docs move  +`); a name opens its tag's list, `+` opens Add tag's tick list in a
 * menu of its own (untick to take the thread out). A thread in no tag draws nothing: Add tag is in ⋯ and the row's
 * right-click menu. A linked machine's thread reads and writes its tags through the host, as Add tag does there.
 * Reads `ThreadTagsContext` itself, so a list read redraws this line and never the thread.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Icon } from '../icons';
import { tagById, tagHref, useThreadTags } from '../threadTags';
import { AddTagList } from './AddTagMenu';
import { TagIcon } from './InitiativePeek';
import { Tip } from './Tip';

export function ThreadTagLine({ threadId, phone }: { threadId: string; phone: boolean }) {
  const host = useThreadTags();
  const [open, setOpen] = useState(false);
  const add = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const root = add.current?.closest<HTMLElement>('.pn-inbox');
    if (root && root !== portal) setPortal(root);
  });
  // Opened by keyboard, the menu would put focus on the first tag and take letters for its type-ahead: Enter, Space and
  // Down open it as a click does, and the field takes focus (AddTagList), so a name can be typed at once.
  const openByKey = (event: KeyboardEvent<HTMLButtonElement> & { preventBaseUIHandler?: () => void }) => {
    if (open || (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    event.preventBaseUIHandler?.();
    setOpen(true);
  };
  if (!host) return null;
  const tags = host.tagsOf(threadId).flatMap((id) => tagById(host.tags, id) ?? []);
  if (tags.length === 0) return null;
  return (
    <div className="ib-ttags" data-thread-tags="">
      <span className="ib-ttags-mark">
        <TagIcon size={15} />
      </span>
      <ul className="ib-ttags-list" aria-label="Tags">
        {tags.map((tag) => (
          <li key={tag.id}>
            <a className="ib-ttag" href={tagHref(tag.id)} dir="auto" data-thread-tag={tag.id}>
              {tag.name}
            </a>
          </li>
        ))}
      </ul>
      {host.can(threadId) && (
        <Menu.Root open={open} onOpenChange={setOpen} modal={phone}>
          <Tip content="Add tag">
            <Menu.Trigger ref={add} className="ib-ttags-add" aria-label="Add tag" onKeyDown={openByKey} data-thread-tags-add="">
              <Icon name="plus" size={15} />
            </Menu.Trigger>
          </Tip>
          <Menu.Portal container={portal ?? undefined}>
            {phone && <Menu.Backdrop className="ib-pm-scrim" />}
            <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4} data-phone={phone ? '' : undefined}>
              <Menu.Popup className="ib-pm" aria-label="Add tag" data-thread-tags-menu="">
                {phone && (
                  <div className="ib-pm-title" aria-hidden="true">
                    Add tag
                  </div>
                )}
                <AddTagList threadId={threadId} />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      )}
    </div>
  );
}
