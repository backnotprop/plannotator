import { useCallback, useEffect, useRef, useState } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { AppSidebarContent } from "./AppSidebar";

export function SidebarPeek() {
  const { open } = useSidebar();
  const [visible, setVisible] = useState(false);
  const [backdropMounted, setBackdropMounted] = useState(false);
  const [backdropVisible, setBackdropVisible] = useState(false);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    if (hideTimeout.current) {
      clearTimeout(hideTimeout.current);
      hideTimeout.current = null;
    }
    setVisible(true);
  }, []);

  const hide = useCallback(() => {
    if (hideTimeout.current) {
      clearTimeout(hideTimeout.current);
    }
    hideTimeout.current = setTimeout(() => setVisible(false), 150);
  }, []);

  useEffect(() => {
    if (visible) {
      setBackdropMounted(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setBackdropVisible(true));
      });
    } else {
      setBackdropVisible(false);
      const timer = setTimeout(() => setBackdropMounted(false), 200);
      return () => clearTimeout(timer);
    }
  }, [visible]);

  if (open) return null;

  return (
    <>
      {/* Hover strip — invisible hit area on left edge */}
      <div className="fixed left-0 top-0 z-40 h-full w-2" onMouseEnter={show} />
      {/* Backdrop overlay */}
      {backdropMounted && (
        <div
          className="fixed inset-0 z-40 bg-black/30"
          style={{
            opacity: backdropVisible ? 1 : 0,
            transition: "opacity 200ms ease",
          }}
          onMouseEnter={hide}
        />
      )}
      {/* Floating sidebar panel */}
      <div
        className="fixed left-0 top-1/2 z-50 h-[80vh] w-[16rem] rounded-lg border border-border bg-sidebar text-sidebar-foreground shadow-[0_8px_40px_-12px_rgba(0,0,0,0.3)]"
        style={{
          transform: visible ? "translate(0px, -50%)" : "translate(-100%, -50%)",
          transition: "transform 150ms cubic-bezier(0.4, 0, 0.2, 1)",
          willChange: "transform",
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        <div className="flex h-full flex-col overflow-hidden rounded-lg">
          <AppSidebarContent />
        </div>
      </div>
    </>
  );
}
