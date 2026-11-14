import React from 'react';
import { Menu } from '@base-ui/react/menu';
import { ChevronDown, X } from 'lucide-react';
import type { Pane } from './paneLayout';
import { isClosableTab, tabLabel } from './tabLabel';

export const PaneTabsMenu: React.FC<{
  pane: Pane;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  overflow: number;
}> = ({ pane, onActivate, onClose, overflow }) => {
  return (
    <Menu.Root>
      <Menu.Trigger
        data-pane-tabs-overflow=""
        aria-label={`${overflow} more open ${overflow === 1 ? 'file' : 'files'}`}
        className="flex-none self-center h-6 flex items-center gap-0.5 px-1.5 rounded-md text-[12px] tabular-nums text-muted-foreground hover:text-foreground hover:bg-muted"
      >
        {overflow}
        <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} className="z-[110] outline-none">
          <Menu.Popup className="w-[min(20rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
            {pane.tabs.map((tab) => (
              <div key={tab.id} className="flex items-center gap-1">
                <Menu.Item
                  onClick={() => onActivate(tab.id)}
                  data-pane-tabs-menu-item={tab.id}
                  className={`flex-1 min-w-0 h-8 [@media(pointer:coarse)]:h-11 flex items-center px-2 rounded-md text-[13px] outline-none data-[highlighted]:bg-muted ${tab.id === pane.activeId ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
                >
                  <span className="truncate">{tabLabel(tab)}</span>
                </Menu.Item>
                {pane.tabs.length > 1 && isClosableTab(tab) && (
                  <button
                    type="button"
                    data-pn-touch-target
                    aria-label={`Close ${tab.title}`}
                    onClick={() => onClose(tab.id)}
                    className="h-8 w-8 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 flex-none flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
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
