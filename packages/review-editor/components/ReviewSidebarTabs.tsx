import React, { useLayoutEffect, useRef } from 'react';
import type { ReviewSidebarTab } from './ReviewSidebar';

export interface ReviewSidebarTabItem {
  id: ReviewSidebarTab;
  label: string;
  title?: string;
  count?: number;
  attention?: boolean;
}

const TAB_ID = (id: ReviewSidebarTab) => `review-sidebar-tab-${id}`;
export const REVIEW_SIDEBAR_BODY_ID = 'review-sidebar-body';

export const ReviewSidebarTabs: React.FC<{
  tabs: ReviewSidebarTabItem[];
  active: ReviewSidebarTab;
  onSelect: (tab: ReviewSidebarTab) => void;
}> = ({ tabs, active, onSelect }) => {
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>(`#${TAB_ID(active)}`);
    if (!list || !tab) return;
    const left = tab.offsetLeft - list.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
  }, [active, tabs.length]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = tabs.findIndex((tab) => tab.id === active);
    if (index === -1) return;
    event.preventDefault();
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    onSelect(next.id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`#${TAB_ID(next.id)}`)?.focus());
  };

  return (
    <div ref={listRef} role="tablist" aria-label="Review panel" className="flex h-full min-w-0 flex-1 items-stretch gap-4 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" onKeyDown={onKeyDown} data-review-sidebar-tablist="">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={TAB_ID(tab.id)}
            aria-selected={selected}
            aria-controls={REVIEW_SIDEBAR_BODY_ID}
            tabIndex={selected ? 0 : -1}
            data-review-sidebar-tab={tab.id}
            title={tab.title}
            aria-label={tab.title ? (tab.count ? `${tab.title}, ${tab.count}` : tab.title) : undefined}
            onClick={() => onSelect(tab.id)}
            className={`relative flex flex-none items-center gap-1.5 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 rounded-sm ${
              selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-muted px-1 text-[12px] font-normal leading-none tabular-nums text-muted-foreground" data-tab-count="">{tab.count > 99 ? '99+' : tab.count}</span>
            )}
            {tab.attention && !selected && <span className="w-1.5 h-1.5 rounded-full bg-primary" aria-label="New activity" />}
            {selected && <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-foreground" />}
          </button>
        );
      })}
    </div>
  );
};
