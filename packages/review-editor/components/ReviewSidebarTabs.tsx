import React, { useLayoutEffect, useRef, useState } from 'react';
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

const FADE = '24px';

function fadeMask({ start, end }: { start: boolean; end: boolean }): React.CSSProperties | undefined {
  if (!start && !end) return undefined;
  const mask = `linear-gradient(to right, ${start ? `transparent, #000 ${FADE}` : '#000, #000'}, ${end ? `#000 calc(100% - ${FADE}), transparent` : '#000'})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

export const ReviewSidebarTabs: React.FC<{
  tabs: ReviewSidebarTabItem[];
  active: ReviewSidebarTab;
  onSelect: (tab: ReviewSidebarTab) => void;
}> = ({ tabs, active, onSelect }) => {
  const listRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState({ start: false, end: false });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = () => {
      const start = list.scrollLeft > 1;
      const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      setHidden((before) => (before.start === start && before.end === end ? before : { start, end }));
    };
    update();
    list.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(list);
    return () => {
      list.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [tabs.length]);

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
    <div ref={listRef} role="tablist" aria-label="Review panel" className="flex h-full min-w-0 flex-1 items-stretch gap-2 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" style={fadeMask(hidden)} onKeyDown={onKeyDown} data-review-sidebar-tablist="" data-hidden-start={hidden.start || undefined} data-hidden-end={hidden.end || undefined}>
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
            className={`relative flex min-w-6 flex-none items-center justify-center gap-1.5 px-1 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 rounded-sm ${
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
