import { createFileRoute } from "@tanstack/react-router";
import { SessionDashboard } from "../sessions/SessionDashboard";

export const Route = createFileRoute("/")({
  loader: ({ context }) => context.daemonClient.listSessions({ clean: true }),
  component: DashboardRoute,
});

function DashboardRoute() {
  const result = Route.useLoaderData();
  return <SessionDashboard result={result} />;
}
