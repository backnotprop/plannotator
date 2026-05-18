import { useEffect } from "react";
import { daemonApiClient, type DaemonApiClient } from "../api/client";
import { connectDaemonEvents } from "./event-stream";
import { useDaemonDebugStore } from "./event-store";

export function useDaemonEvents(client: DaemonApiClient = daemonApiClient, enabled = true): void {
  const applyEvent = useDaemonDebugStore((state) => state.applyEvent);
  const setConnectionState = useDaemonDebugStore((state) => state.setConnectionState);
  const setError = useDaemonDebugStore((state) => state.setError);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = connectDaemonEvents({
      client,
      onEvent: applyEvent,
      onState: setConnectionState,
      onError: setError,
    });

    return () => controller.stop();
  }, [applyEvent, client, enabled, setConnectionState, setError]);
}
