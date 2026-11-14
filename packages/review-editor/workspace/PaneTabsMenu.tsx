import React from 'react';
import { Menu } from '@base-ui/react/menu';
import { ChevronDown, X } from 'lucide-react';
import type { Pane } from './paneLayout';
import { useSettledValue } from './useSettledValue';
import { TITLE_SETTLE_MS } from './PaneTabs';

export const PaneTabsMenu: React.FC<{
  pane: Pane;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}> = ({ pane, onActivate, onClose }) => {
  const active = pane.tabs.find((tab) => tab.id === pane.activeId) ?? pane.tabs[0];
  const title = useSettledValue(active?.title ?? '', TITLE_SETTLE_MS);
  return (
    <Menu.Root>
      <Menu.Trigger
        data-pn-touch-target
        data-pane-tabs-menu=""
        aria-label={`Open files: ${title}`}
        className="min-w-0 max-w-full h-11 flex items-center justify-center gap-1 px-2 rounded-md text-[13px] font-medium text-foreground"
      >
        <span className="truncate">{title}</span>
        <span className="flex-none text-[12px] tabular-nums text-muted-foreground">{pane.tabs.length}</span>
        <ChevronDown className="w-3.5 h-3.5 flex-none text-muted-foreground" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} className="z-[110] outline-none">
          <Menu.Popup className="w-[min(20rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
            {pane.tabs.map((tab) => (
              <div key={tab.id} className="flex items-center gap-1">
                <Menu.Item
                  onClick={() => onActivate(tab.id)}
                  data-pane-tabs-menu-item={tab.id}
                  className={`flex-1 min-w-0 h-11 flex items-center px-2 rounded-md text-[13px] outline-none data-[highlighted]:bg-muted ${tab.id === pane.activeId ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
                >
                  <span className="truncate">{tab.title}</span>
                </Menu.Item>
                {pane.tabs.length > 1 && (
                  <button
                    type="button"
                    data-pn-touch-target
                    aria-label={`Close ${tab.title}`}
                    onClick={() => onClose(tab.id)}
                    className="h-11 w-11 flex-none flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
};
