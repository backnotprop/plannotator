/**
 * The project ⋯'s Add tag (projectTags.ts): the thread menu's item and list (AddTagMenu.tsx), on the project's tags.
 * The item sits in a group of its own after the batches, and swaps the menu for the tags in place, as a thread's
 * does; ‹ Add tag goes back, focus on the item. Offered on this Inbox's projects and on a linked machine's that takes
 * project tags; absent on an Inbox that keeps no tags.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { focusAfterSwap } from '@plannotator/ui/components/inbox-thread/SnoozeMenu';
import { useThreadTags } from '../threadTags';
import { AddTagItem, AddTagList } from './AddTagMenu';

export function useProjectTagSwap(projectId: string): { item: ReactNode; list: ReactNode } {
  const host = useThreadTags()?.projects;
  const target = host?.can(projectId) ? host.target(projectId) : null;
  const [open, setOpen] = useState(false);
  const backed = useRef(false);
  useLayoutEffect(() => {
    if (open || !backed.current) return;
    backed.current = false;
    return focusAfterSwap(() => document.querySelector<HTMLElement>(`[data-project-menu="${CSS.escape(projectId)}"] [data-add-tag-item]`));
  }, [open, projectId]);
  if (!target) return { item: null, list: null };
  return {
    item: (
      <>
        <Menu.Separator className="ib-pm-sep" />
        <AddTagItem target={target} onOpen={() => setOpen(true)} />
      </>
    ),
    list: open ? (
      <AddTagList
        target={target}
        onBack={() => {
          backed.current = true;
          setOpen(false);
        }}
      />
    ) : null,
  };
}
