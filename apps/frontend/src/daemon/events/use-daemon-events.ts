import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useRouter } from "@tanstack/react-router";
import { daemonApiClient, type DaemonApiClient } from "../api/client";
import { connectDaemonEvents, type DaemonEventStreamController } from "./event-stream";
import { useDaemonEventStore } from "./event-store";
import { getSessionModeMeta, formatSessionLabel } from "../../shared/session-meta";

export function useDaemonEvents(client: DaemonApiClient = daemonApiClient, enabled = true) {
  const applyEvent = useDaemonEventStore((state) => state.applyEvent);
  const setConnectionState = useDaemonEventStore((state) => state.setConnectionState);
  const setError = useDaemonEventStore((state) => state.setError);
  const controllerRef = useRef<DaemonEventStreamController | null>(null);
  const router = useRouter();

  const handleSessionNotify = useCallback(
    (session: { id: string; mode: string; project: string; label: string }) => {
      const meta = getSessionModeMeta(session.mode);
      const displayLabel = formatSessionLabel(session.label, session.mode);
      toast(`${meta.label} — ${session.project}`, {
        description: displayLabel !== session.project ? displayLabel : undefined,
        duration: 8000,
        action: {
          label: "Open",
          onClick: () =>
            router.navigate({ to: "/s/$sessionId", params: { sessionId: session.id } }),
        },
      });
    },
    [router],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = connectDaemonEvents({
      client,
      onEvent: applyEvent,
      onState: setConnectionState,
      onError: setError,
      onSessionNotify: handleSessionNotify,
    });
    controllerRef.current = controller;

    return () => {
      controller.stop();
      controllerRef.current = null;
    };
  }, [applyEvent, client, enabled, handleSessionNotify, setConnectionState, setError]);

  const reportActiveSession = useCallback((sessionId: string | null) => {
    controllerRef.current?.reportActiveSession(sessionId);
  }, []);

  return { reportActiveSession };
}
