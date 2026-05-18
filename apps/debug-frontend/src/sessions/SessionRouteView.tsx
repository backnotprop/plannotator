import type { DaemonApiResult } from "../daemon/api/errors";
import { SessionDebugPanel } from "../debug/SessionDebugPanel";
import { ResultNotice } from "../shared/ui/ResultNotice";
import type { ShellSessionBootstrap } from "./types";
import { getSessionViewDefinition } from "./session-view-registry";
import { UnsupportedSessionView } from "./UnsupportedSessionView";

interface SessionRouteViewProps {
  result: DaemonApiResult<ShellSessionBootstrap>;
}

export function SessionRouteView({ result }: SessionRouteViewProps) {
  if (!result.ok) {
    return <ResultNotice tone="error" title="Session could not be loaded" error={result.error} />;
  }

  const definition = getSessionViewDefinition(result.data.session.mode);
  if (!definition) {
    return (
      <>
        <SessionDebugPanel bootstrap={result.data} />
        <UnsupportedSessionView bootstrap={result.data} />
      </>
    );
  }

  const Component = definition.component;
  return (
    <>
      <SessionDebugPanel bootstrap={result.data} />
      <Component bootstrap={result.data} />
    </>
  );
}
