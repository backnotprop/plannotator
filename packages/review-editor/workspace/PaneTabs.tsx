import React, { useLayoutEffect, useRef, useState } from 'react';
import { Crosshair, Diff, FileText } from 'lucide-react';
import { EllipsisName, fitDirectory } from '../components/EllipsisName';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import type { Pane, PaneTab } from './paneLayout';
import { REVIEW_ALL_FILES_PANEL_ID, isReviewFilePreviewParams } from '../dock/reviewPanelTypes';
import { TITLE_SETTLE_MS, useSettledValue } from './useSettledValue';
import { PaneTabsMenu } from './PaneTabsMenu';
import { isClosableTab, isReferencesTab, tabDirectory, tabKind, tabLabel, tabTooltip } from './tabLabel';

export { TITLE_SETTLE_MS };

export const TAB_MIN_WIDTH = 72;

const MENU_RESERVE = 44;
const TAB_GAP = 16;
const ACTIVE_NEED_WIDTH = 150;

function naturalWidth(item: HTMLElement): number {
  let width = item.offsetWidth;
  for (const name of item.querySelectorAll<HTMLElement>('[data-ellipsis-name]')) {
    const full = Number.parseFloat(name.style.width);
    if (full > name.clientWidth) width += full - name.clientWidth;
  }
  const directory = item.querySelector<HTMLElement>('[data-pane-tab-directory]');
  return directory ? width - directory.offsetWidth : width;
}

type HiddenTabs = { ids: Set<string>; directoryRoom: number };
const NONE_HIDDEN: HiddenTabs = { ids: new Set(), directoryRoom: 0 };

function useHiddenTabs(ref: React.RefObject<HTMLElement | null>, key: string, single: boolean, activeId: string | null): HiddenTabs {
  const [hidden, setHidden] = useState<HiddenTabs>(NONE_HIDDEN);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      element.scrollLeft = 0;
      const ids = new Set<string>();
      const items = [...element.querySelectorAll<HTMLElement>('[data-pane-tab-item]')].map((item) => ({ id: item.getAttribute('data-pane-tab-item')!, width: naturalWidth(item) }));
      const total = items.reduce((sum, item, index) => sum + item.width + (index ? TAB_GAP : 0), 0);
      let used = total;
      let room = element.clientWidth;
      if (!single && total > element.clientWidth + 1) {
        room = element.clientWidth - MENU_RESERVE;
        const kept = items.filter((item) => item.id === activeId || item.id === REVIEW_ALL_FILES_PANEL_ID);
        used = kept.reduce((sum, item, index) => sum + (item.id === REVIEW_ALL_FILES_PANEL_ID ? item.width : Math.min(item.width, ACTIVE_NEED_WIDTH)) + (index ? TAB_GAP : 0), 0);
        for (const item of items) {
          if (kept.includes(item)) continue;
          if (used + TAB_GAP + item.width <= room) used += TAB_GAP + item.width;
          else ids.add(item.id);
        }
        const active = items.find((item) => item.id === activeId);
        if (active && active.width > ACTIVE_NEED_WIDTH) used += active.width - ACTIVE_NEED_WIDTH;
      }
      const directoryRoom = Math.max(0, Math.floor(room - used - 4));
      setHidden((before) => (before.directoryRoom === directoryRoom && before.ids.size === ids.size && [...ids].every((id) => before.ids.has(id)) ? before : { ids, directoryRoom }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, key, single, activeId]);
  return hidden;
}

const DirectoryPrefix: React.FC<{ directory: string; room: number }> = ({ directory, room }) => {
  const probeRef = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState('');
  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (!probe || typeof probe.getBoundingClientRect !== 'function') return;
    const width = (text: string) => {
      probe.textContent = text;
      return probe.getBoundingClientRect().width;
    };
    const next = width('M') === 0 ? directory : room > 0 ? fitDirectory(directory, room, width) : '';
    probe.textContent = '';
    setShown(next);
  }, [directory, room]);
  return (
    <span aria-hidden="true" className="relative flex-none -mr-1 whitespace-nowrap text-[13px] text-muted-foreground [font-variant-ligatures:no-contextual]" data-pane-tab-directory="">
      {shown}
      <span ref={probeRef} className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap" />
    </span>
  );
};

const TabIcon: React.FC<{ tab: PaneTab; onClick: () => void }> = ({ tab, onClick }) => {
  const kind = isReferencesTab(tab) ? 'references' : tabKind(tab);
  if (!kind) return null;
  const Icon = kind === 'references' ? Crosshair : kind === 'diff' ? Diff : FileText;
  return (
    <span aria-hidden="true" onClick={onClick} className="flex-none text-muted-foreground" data-tab-kind-icon={kind}>
      <Icon className="w-3.5 h-3.5" />
    </span>
  );
};

const TabTitle: React.FC<{ title: string }> = ({ title }) => <EllipsisName text={useSettledValue(title, TITLE_SETTLE_MS)} />;

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
}> = ({ pane, paneIndex, onActivate, onClose, onKeep }) => {
  const listRef = useRef<HTMLDivElement>(null);
  const compact = useReviewStateOptional()?.isCompactTouchLayout ?? false;
  const hidden = useHiddenTabs(listRef, pane.tabs.map((tab) => `${tab.id}\0${tab.title}`).join('\n'), pane.tabs.length < 2, pane.activeId);

  const focusTab = (id: string | null) => {
    if (!id) return;
    const focus = (tries: number) => {
      const tab = document.querySelector<HTMLButtonElement>(`[data-pane="${paneIndex}"] [data-pane-tab="${CSS.escape(id)}"]`);
      if (tab) tab.focus();
      else if (tries > 0) requestAnimationFrame(() => focus(tries - 1));
    };
    requestAnimationFrame(() => focus(3));
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
      onScroll={(event) => { event.currentTarget.scrollLeft = 0; }}
      data-pane-tabs-for={paneIndex}
      className="relative min-w-0 flex-1 h-full flex items-stretch gap-4 overflow-hidden"
    >
      {pane.tabs.map((tab) => {
        const active = tab.id === pane.activeId;
        const preview = isReviewFilePreviewParams(tab.params);
        const closable = isClosableTab(tab);
        const shrinks = pane.tabs.length === 1 || (active && closable);
        const directory = active && !compact ? tabDirectory(tab) : '';
        return (
          <div
            key={tab.id}
            data-pane-tab-item={tab.id}
            aria-hidden={hidden.ids.has(tab.id) || undefined}
            style={shrinks ? { minWidth: TAB_MIN_WIDTH } : undefined}
            className={`group flex items-center gap-1 ${shrinks ? 'min-w-0 shrink' : 'flex-none'} ${hidden.ids.has(tab.id) ? 'invisible absolute' : 'relative'}`}
          >
            <TabIcon tab={tab} onClick={() => onActivate(tab.id)} />
            {directory && <DirectoryPrefix directory={directory} room={hidden.directoryRoom} />}
            <button
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-pane-tab={tab.id}
              data-preview-tab={preview || undefined}
              title={preview ? `${tabTooltip(tab)} (preview: double-click to keep it open)` : tabTooltip(tab)}
              onClick={() => onActivate(tab.id)}
              onDoubleClick={preview && onKeep ? () => onKeep(tab.id) : undefined}
              onAuxClick={(event) => {
                if (event.button !== 1 || !closable) return;
                event.preventDefault();
                close(tab.id);
              }}
              className={`h-full min-w-0 ${hidden.ids.size === 0 ? '' : active ? 'max-w-[240px]' : 'max-w-[180px]'} flex items-center text-[13px] font-medium transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 rounded-sm ${
                active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              } ${preview ? 'italic' : ''}`}
            >
              <span className="min-w-0 flex"><TabTitle title={tabLabel(tab)} /></span>
            </button>
            {closable && <button
              type="button"
              aria-label={`Close ${tab.title}`}
              data-pane-tab-close={tab.id}
              tabIndex={-1}
              onClick={() => close(tab.id)}
              data-pn-touch-target=""
              data-pn-touch-target-icon=""
              className={`h-6 w-6 -mx-1 flex-none flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-opacity ${
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
      {hidden.ids.size > 0 && (
        <div className="flex-none flex items-center -ml-2">
          <PaneTabsMenu pane={pane} onActivate={onActivate} onClose={onClose} overflow={hidden.ids.size} />
        </div>
      )}
    </div>
  );
  return list;
};
