import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { SessionBootstrap } from "../daemon/contracts";
import type { DaemonApiResult } from "../daemon/api/errors";
import { appStore } from "../stores/app-store";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

export const Route = createFileRoute("/s/$sessionId")({
  params: {
    parse: ({ sessionId }) => {
      if (!SESSION_ID_PATTERN.test(sessionId)) return false;
      return { sessionId };
    },
    stringify: ({ sessionId }) => ({ sessionId }),
  },
  loader: ({ context, params }) => context.daemonClient.getSessionBootstrap(params.sessionId),
  component: SessionRoute,
});

function SessionRoute() {
  const result: DaemonApiResult<SessionBootstrap> = Route.useLoaderData();
  const { sessionId } = Route.useParams();

  useEffect(() => {
    if (result.ok) {
      appStore.getState().activateSession(sessionId, result.data);
    } else {
      appStore.getState().deactivateSession();
    }
  }, [sessionId, result]);

  if (!result.ok) {
    return (
      <div className="isolate flex h-full flex-col bg-muted">
        <nav className="flex h-10 shrink-0 items-center gap-2 px-3">
          <SidebarTrigger className="-ml-1" />
        </nav>
        <div className="flex-1 overflow-hidden p-2 pt-0">
          <div className="flex h-full items-center justify-center rounded-xl bg-card shadow-[var(--card-shadow)]">
            <p className="text-sm text-muted-foreground">Session could not be loaded.</p>
          </div>
        </div>
      </div>
    );
  }

  // The actual surface is rendered by Layout via Activity — this route just registers the session
  return null;
}
