import { useCallback, useEffect } from "react";
import { Outlet, useMatchRoute } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "../components/sidebar/AppSidebar";
import { SidebarPeek } from "../components/sidebar/SidebarPeek";
import { AddProjectDialog } from "../components/landing/AddProjectDialog";
import { AppSettingsDialog } from "../components/settings/AppSettingsDialog";
import { SessionSurface } from "../components/sessions/SessionSurface";
import { appStore } from "../stores/app-store";
import { setGlobalFetchBase } from "@plannotator/ui/utils/api";
import { useDaemonEvents } from "../daemon/events/use-daemon-events";

setGlobalFetchBase("/daemon");
import { projectStore } from "../stores/project-store";
import { useAppStore } from "../stores/app-store";

function LayoutContent() {
  const addProjectOpen = useAppStore((s) => s.addProjectOpen);
  const setAddProjectOpen = useAppStore((s) => s.setAddProjectOpen);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const visitedSessions = useAppStore((s) => s.visitedSessions);
  const matchRoute = useMatchRoute();
  const { open: sidebarOpen } = useSidebar();

  const { reportActiveSession } = useDaemonEvents();

  useEffect(() => {
    void projectStore.getState().fetchProjects();
  }, []);

  const isOnSession = !!matchRoute({ to: "/s/$sessionId", fuzzy: true });

  useEffect(() => {
    reportActiveSession(isOnSession ? activeSessionId : null);
  }, [reportActiveSession, isOnSession, activeSessionId]);
  const showLanding = !isOnSession;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        const current = appStore.getState().settingsOpen;
        appStore.getState().setSettingsOpen(!current);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <AppSidebar />
      <SidebarPeek />
      <main className="relative flex-1 overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            visibility: showLanding ? "visible" : "hidden",
            zIndex: showLanding ? 1 : 0,
          }}
        >
          <Outlet />
        </div>

        {Object.values(visitedSessions).map(({ sessionId, bootstrap }) => {
          const isActive = sessionId === activeSessionId && isOnSession;
          return (
            <div
              key={sessionId}
              className={`absolute inset-0 overflow-hidden ${sidebarOpen ? "rounded-tl-xl border-l border-border/50" : ""}`}
              style={{
                visibility: isActive ? "visible" : "hidden",
                contentVisibility: isActive ? "visible" : "hidden",
                containIntrinsicSize: isActive ? undefined : "auto 100vh",
                zIndex: isActive ? 1 : 0,
              }}
            >
              <SessionSurface bootstrap={bootstrap} />
            </div>
          );
        })}
      </main>
      <AddProjectDialog open={addProjectOpen} onOpenChange={setAddProjectOpen} />
      <AppSettingsDialog />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            "--normal-bg": "var(--card)",
            "--normal-border": "var(--border)",
            "--normal-text": "var(--foreground)",
            "--normal-action-bg": "var(--primary)",
            "--normal-action-text": "var(--primary-foreground)",
          } as React.CSSProperties,
        }}
      />
    </>
  );
}

export function Layout() {
  const matchRoute = useMatchRoute();
  const initiallyOnSession = !!matchRoute({ to: "/s/$sessionId", fuzzy: true });

  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={100}>
      <SidebarProvider
        defaultOpen={!initiallyOnSession}
        style={{ "--sidebar-width": "16rem" } as React.CSSProperties}
      >
        <LayoutContent />
      </SidebarProvider>
    </TooltipProvider>
  );
}
