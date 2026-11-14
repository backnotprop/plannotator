import React, { useRef } from 'react';
import type { Pane } from './paneLayout';
import { isReviewFilePreviewParams } from '../dock/reviewPanelTypes';
import { useSettledValue } from './useSettledValue';

export const TITLE_SETTLE_MS = 200;

const TabTitle: React.FC<{ title: string }> = ({ title }) => <>{useSettledValue(title, TITLE_SETTLE_MS)}</>;

function focusTreeRow() {
  const row = document.querySelector<HTMLElement>('[data-review-sidebar] .file-tree-item.active') ?? document.querySelector<HTMLElement>('[data-review-sidebar] .file-tree-item');
  row?.focus();
}

export const PaneTabs: React.FC<{
  pane: Pane;
  paneIndex: number;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onKeep?: (id: string) => void;
  inHeader?: boolean;
}> = ({ pane, paneIndex, onActivate, onClose, onKeep, inHeader = false }) => {
  const listRef = useRef<HTMLDivElement>(null);

  const focusTab = (id: string | null) => {
    if (!id) return;
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-pane-tab="${CSS.escape(id)}"]`)?.focus());
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const at = pane.tabs.findIndex((tab) => tab.id === pane.activeId);
    if (at === -1) return;
    event.preventDefault();
    const next = pane.tabs[(at + (event.key === 'ArrowRight' ? 1 : -1) + pane.tabs.length) % pane.tabs.length]!;
    onActivate(next.id);
    focusTab(next.id);
  };

  const close = (id: string) => {
    const at = pane.tabs.findIndex((tab) => tab.id === id);
    const neighbour = pane.tabs[at + 1] ?? pane.tabs[at - 1];
    onClose(id);
    if (neighbour) focusTab(neighbour.id);
    else requestAnimationFrame(focusTreeRow);
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={paneIndex === 0 ? 'Open files' : 'Open files beside'}
      data-pane-tabs=""
      onKeyDown={onKeyDown}
      data-pane-tabs-for={paneIndex}
      className={inHeader
        ? 'min-w-0 h-full flex items-stretch gap-4 overflow-x-auto [scrollbar-width:none]'
        : 'flex-none h-8 flex items-stretch gap-4 px-3 overflow-x-auto shadow-[inset_0_-1px_0_var(--border)] bg-background [scrollbar-width:none]'}
    >
      {pane.tabs.map((tab) => {
        const active = tab.id === pane.activeId;
        const preview = isReviewFilePreviewParams(tab.params);
        return (
          <div key={tab.id} className="group relative flex flex-none items-center gap-1">
            <button
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-pane-tab={tab.id}
              data-preview-tab={preview || undefined}
              title={preview ? `${tab.title} (preview: double-click to keep it open)` : tab.title}
              onClick={() => onActivate(tab.id)}
              onDoubleClick={preview && onKeep ? () => onKeep(tab.id) : undefined}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                close(tab.id);
              }}
              className={`h-full max-w-[16rem] truncate text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60 rounded-sm ${
                active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              } ${preview ? 'italic' : ''}`}
            >
              <TabTitle title={tab.title} />
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              data-pane-tab-close={tab.id}
              tabIndex={-1}
              onClick={() => close(tab.id)}
              className={`h-4 w-4 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-opacity ${
                active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70 [@media(hover:none)]:opacity-70 focus-visible:opacity-100'
              }`}
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            {active && <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-foreground" />}
          </div>
        );
      })}
    </div>
  );
};
