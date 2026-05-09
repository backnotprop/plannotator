/**
 * Sidebar Hook
 *
 * Manages sidebar state: open/close and active tab.
 * Generic over tab type — used by both the plan editor (left sidebar)
 * and the review editor (right sidebar).
 */

import { useState, useCallback } from "react";

export type SidebarTab = "toc" | "versions" | "files" | "archive";

export interface UseSidebarReturn<T extends string = SidebarTab> {
  isOpen: boolean;
  activeTab: T;
  open: (tab?: T) => void;
  close: () => void;
  /**
   * Toggle a tab:
   * - If sidebar is closed → open to that tab
   * - If sidebar is open and same tab → close
   * - If sidebar is open and different tab → switch to that tab
   */
  toggleTab: (tab: T) => void;
}

export function useSidebar<T extends string = SidebarTab>(initialOpen: boolean, defaultTab?: T): UseSidebarReturn<T> {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const [activeTab, setActiveTab] = useState<T>((defaultTab ?? "toc") as T);

  const open = useCallback((tab?: T) => {
    setIsOpen(true);
    if (tab) setActiveTab(tab);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const toggleTab = useCallback(
    (tab: T) => {
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
