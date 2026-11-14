import React, { useLayoutEffect, useRef, useState } from 'react';
import { Crosshair } from 'lucide-react';
import type { Pane } from './paneLayout';
import { isReviewFilePreviewParams } from '../dock/reviewPanelTypes';
import { TITLE_SETTLE_MS, useSettledValue } from './useSettledValue';
import { PaneTabsMenu } from './PaneTabsMenu';
import { isClosableTab, isReferencesTab, tabLabel } from './tabLabel';

export { TITLE_SETTLE_MS };

export const TAB_MIN_WIDTH = 72;

const MENU_RESERVE = 44;

type HiddenTabs = { ids: Set<string>; end: number };
const NONE_HIDDEN: HiddenTabs = { ids: new Set(), end: 0 };

function useHiddenTabs(ref: React.RefObject<HTMLElement | null>, key: string, single: boolean): HiddenTabs {
  const [hidden, setHidden] = useState<HiddenTabs>(NONE_HIDDEN);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const ids = new Set<string>();
      let end = 0;
      if (!single) {
        const items = [...element.querySelectorAll<HTMLElement>('[data-pane-tab-item]')];
        const overflows = items.some((item) => item.offsetLeft + item.offsetWidth > element.clientWidth + 1);
        const limit = element.clientWidth - (overflows ? MENU_RESERVE : 0) + 1;
        for (const item of items) {
          const right = item.offsetLeft + item.offsetWidth;
          if (overflows && right > limit) ids.add(item.getAttribute('data-pane-tab-item')!);
          else end = Math.max(end, right);
        }
      }
      setHidden((before) => (before.end === end && before.ids.size === ids.size && [...ids].every((id) => before.ids.has(id)) ? before : ids.size ? { ids, end } : NONE_HIDDEN));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, key, single]);
  return hidden;
}

const FILE_EXTENSION = /^(.+?)(\.[A-Za-z0-9]{1,8})$/;

export function splitTabTitle(title: string): { stem: string; extension: string } {
  const match = FILE_EXTENSION.exec(title);
  return match ? { stem: match[1]!, extension: match[2]! } : { stem: title, extension: '' };
}

const TabTitle: React.FC<{ title: string; keepExtension: boolean }> = ({ title, keepExtension }) => {
  const settled = useSettledValue(title, TITLE_SETTLE_MS);
  const { stem, extension } = keepExtension ? splitTabTitle(settled) : { stem: settled, extension: '' };
  return (
    <>
      <span className="truncate min-w-0">{stem}</span>
      {extension && <span className="flex-none">{extension}</span>}
    </>
  );
};

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
  const hidden = useHiddenTabs(listRef, pane.tabs.map((tab) => `${tab.id}\0${tab.title}`).join('\n'), pane.tabs.length < 2 || !inHeader);

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

  const list = (
    <div
      ref={listRef}
      role="tablist"
      aria-label={paneIndex === 0 ? 'Open files' : 'Open files beside'}
      data-pane-tabs=""
      onKeyDown={onKeyDown}
      data-pane-tabs-for={paneIndex}
      className={inHeader
        ? 'min-w-0 h-full flex items-stretch gap-4 overflow-hidden'
        : 'flex-none h-8 flex items-stretch gap-4 px-3 overflow-x-auto shadow-[inset_0_-1px_0_var(--border)] bg-background [scrollbar-width:none]'}
    >
      {pane.tabs.map((tab) => {
        const active = tab.id === pane.activeId;
        const preview = isReviewFilePreviewParams(tab.params);
        const closable = isClosableTab(tab);
        return (
          <div
            key={tab.id}
            data-pane-tab-item={tab.id}
            aria-hidden={hidden.ids.has(tab.id) || undefined}
            style={inHeader && pane.tabs.length === 1 ? { minWidth: TAB_MIN_WIDTH } : undefined}
            className={`group relative flex items-center gap-1 ${inHeader && pane.tabs.length === 1 ? 'min-w-0 shrink' : 'flex-none'} ${hidden.ids.has(tab.id) ? 'invisible' : ''}`}
          >
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
                if (event.button !== 1 || !closable) return;
                event.preventDefault();
                close(tab.id);
              }}
              className={`h-full min-w-0 max-w-[180px] flex items-center text-[13px] font-medium transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 rounded-sm ${
                active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              } ${preview ? 'italic' : ''}`}
            >
              {isReferencesTab(tab) && <Crosshair className="w-3.5 h-3.5 flex-none mr-1" aria-hidden="true" data-references-tab-icon="" />}
              <span className="min-w-0 flex"><TabTitle title={tabLabel(tab)} keepExtension={!isReferencesTab(tab)} /></span>
            </button>
            {closable && <button
              type="button"
              aria-label={`Close ${tab.title}`}
              data-pane-tab-close={tab.id}
              tabIndex={-1}
              onClick={() => close(tab.id)}
              className={`h-4 w-4 flex-none flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-opacity ${
                active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70 [@media(hover:none)]:opacity-70 focus-visible:opacity-100'
              }`}
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>}
            {active && <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-foreground" />}
          </div>
        );
      })}
    </div>
  );
  if (!inHeader) return list;
  return (
    <div className="relative min-w-0 h-full flex items-stretch">
      {list}
      {hidden.ids.size > 0 && (
        <div className="absolute inset-y-0 flex items-center" style={{ left: hidden.end + 8 }}>
          <PaneTabsMenu pane={pane} onActivate={onActivate} onClose={onClose} overflow={hidden.ids.size} />
        </div>
      )}
    </div>
  );
};
