import { createFileRoute } from "@tanstack/react-router";
import { parseSessionId } from "../sessions/session-id";
import { SessionRouteView } from "../sessions/SessionRouteView";

export const Route = createFileRoute("/s/$sessionId")({
  params: {
    parse: ({ sessionId }) => {
      const parsed = parseSessionId(sessionId);
      return parsed === false ? false : { sessionId: parsed };
    },
    stringify: ({ sessionId }) => ({ sessionId }),
  },
  loader: ({ context, params }) => context.daemonClient.getSessionBootstrap(params.sessionId),
  component: SessionRoute,
});

function SessionRoute() {
  const result = Route.useLoaderData();
  return <SessionRouteView result={result} />;
}
