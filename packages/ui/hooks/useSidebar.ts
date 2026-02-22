/**
 * Sidebar Hook
 *
 * Manages the shared left sidebar state: open/close and active tab (TOC or Versions).
 * The sidebar is shared between the Table of Contents and Version Browser views.
 */

import { useState, useCallback } from "react";

export type SidebarTab = "toc" | "versions";

export interface UseSidebarReturn {
  isOpen: boolean;
  activeTab: SidebarTab;
  /** Open the sidebar, optionally switching to a specific tab */
  open: (tab?: SidebarTab) => void;
  /** Close the sidebar */
  close: () => void;
  /**
   * Toggle a tab:
   * - If sidebar is closed → open to that tab
   * - If sidebar is open and same tab → close
   * - If sidebar is open and different tab → switch to that tab
   */
  toggleTab: (tab: SidebarTab) => void;
}

export function useSidebar(initialOpen: boolean): UseSidebarReturn {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const [activeTab, setActiveTab] = useState<SidebarTab>("toc");

  const open = useCallback((tab?: SidebarTab) => {
    setIsOpen(true);
    if (tab) setActiveTab(tab);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const toggleTab = useCallback(
    (tab: SidebarTab) => {
      if (!isOpen) {
        setIsOpen(true);
        setActiveTab(tab);
      } else if (activeTab === tab) {
        setIsOpen(false);
      } else {
        setActiveTab(tab);
      }
    },
    [isOpen, activeTab]
  );

  return { isOpen, activeTab, open, close, toggleTab };
}
