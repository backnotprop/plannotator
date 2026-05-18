import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { afterEach, describe, expect, test } from "vitest";
import type { DaemonApiClient } from "../daemon/api/client";
import { cleanupBrowser, renderBrowser } from "../testing/browser/render";
import { sessionBootstraps } from "../testing/fixtures/daemon";
import { SessionDebugPanel } from "./SessionDebugPanel";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

function wrapWithRouter(ui: React.ReactNode) {
  const rootRoute = createRootRoute({ component: () => ui });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/s/test-session"] }),
  });
  return <RouterProvider router={router} />;
}

describe("SessionDebugPanel browser rendering", () => {
  test("runs API probes and mode-specific action buttons", async () => {
    const calls: string[] = [];
    const client: DaemonApiClient = {
      getStatus: async () => {
        throw new Error("not used");
      },
      listSessions: async () => {
        throw new Error("not used");
      },
      getSession: async () => {
        throw new Error("not used");
      },
      getSessionBootstrap: async () => {
        throw new Error("not used");
      },
      cancelSession: async () => {
        throw new Error("not used");
      },
      deleteSession: async () => {
        throw new Error("not used");
      },
      getEventsUrl: () => "/daemon/events",
      getSessionApiUrl: (sessionId, path) => `/s/${sessionId}${path}`,
      probeSessionApi: async (_sessionId, path) => {
        calls.push(`probe:${path}`);
        return { ok: true, data: { ok: true, path } };
      },
      runSessionAction: async (_session, action) => {
        calls.push(`action:${action}`);
        return { ok: true, data: { ok: true, action } };
      },
    };

    const rendered = await renderBrowser(
      wrapWithRouter(<SessionDebugPanel bootstrap={sessionBootstraps.review} client={client} />),
    );
    cleanup = () => cleanupBrowser(rendered.root, rendered.container);

    const buttons = Array.from(rendered.container.querySelectorAll("button"));
    await act(async () => {
      buttons.find((button) => button.textContent?.includes("/api/diff"))?.click();
    });
    await act(async () => {
      buttons.find((button) => button.textContent === "LGTM")?.click();
    });

    expect(calls).toEqual(["probe:/api/diff", "action:review-approve"]);
  });
});
