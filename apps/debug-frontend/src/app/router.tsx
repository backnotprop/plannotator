import { createRouter } from "@tanstack/react-router";
import { createDaemonApiClient, type DaemonApiClient } from "../daemon/api/client";
import { routeTree } from "../routeTree.gen";

export interface AppRouterContext {
  daemonClient: DaemonApiClient;
}

export function createAppRouter(
  context: AppRouterContext = { daemonClient: createDaemonApiClient() },
) {
  return createRouter({
    routeTree,
    context,
    defaultPreload: "intent",
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
