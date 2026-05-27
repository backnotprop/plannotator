import React from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { SessionProvider } from "@plannotator/ui/hooks/useSessionFetch";
import { ReviewAppEmbedded } from "@plannotator/code-review";
import { PlanAppEmbedded } from "@plannotator/plan-review";
import "@plannotator/code-review/styles";
import "@plannotator/plan-review/styles";
import type { SessionBootstrap } from "../../daemon/contracts";
import { appStore } from "../../stores/app-store";

const sidebarTrigger = (
  <SidebarTrigger className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted" />
);

const openSettings = () => appStore.getState().setSettingsOpen(true);

interface SessionSurfaceProps {
  bootstrap: SessionBootstrap;
}

export const SessionSurface = React.memo(function SessionSurface({
  bootstrap,
}: SessionSurfaceProps) {
  const { session } = bootstrap;

  if (session.mode === "review") {
    return (
      <SessionProvider sessionId={session.id}>
        <ReviewAppEmbedded headerLeft={sidebarTrigger} onOpenSettings={openSettings} />
      </SessionProvider>
    );
  }

  return (
    <SessionProvider sessionId={session.id}>
      <PlanAppEmbedded headerLeft={sidebarTrigger} onOpenSettings={openSettings} />
    </SessionProvider>
  );
});
