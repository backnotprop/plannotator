import { afterEach, describe, expect, test } from "vitest";
import "../styles.css";
import { useDaemonDebugStore } from "../daemon/events/event-store";
import { cleanupBrowser, renderBrowser } from "../testing/browser/render";
import { emptySessionListFixture, sessionListFixture } from "../testing/fixtures/daemon";
import { SessionDashboard } from "./SessionDashboard";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  useDaemonDebugStore.getState().reset();
});

describe("SessionDashboard browser rendering", () => {
  test("renders the empty state", async () => {
    const rendered = await renderBrowser(
      <SessionDashboard result={{ ok: true, data: emptySessionListFixture }} debugStream={false} />,
    );
    cleanup = () => cleanupBrowser(rendered.root, rendered.container);

    expect(rendered.container.textContent).toContain("No active sessions");
  });

  test("renders session cards", async () => {
    const rendered = await renderBrowser(
      <SessionDashboard result={{ ok: true, data: sessionListFixture }} debugStream={false} />,
    );
    cleanup = () => cleanupBrowser(rendered.root, rendered.container);

    expect(rendered.container.textContent).toContain("Runtime frontend shell plan");
    expect(rendered.container.textContent).toContain("PR #734 daemon runtime review");
    expect(rendered.container.querySelectorAll(".session-card")).toHaveLength(5);
  });

  test("session IDs are selectable text", async () => {
    const rendered = await renderBrowser(
      <SessionDashboard result={{ ok: true, data: sessionListFixture }} debugStream={false} />,
    );
    cleanup = () => cleanupBrowser(rendered.root, rendered.container);

    const sessionId = rendered.container.querySelector(".session-card-id");
    expect(sessionId).toBeTruthy();
    expect(getComputedStyle(sessionId as Element).userSelect).not.toBe("none");
  });

  test("renders backend errors", async () => {
    const rendered = await renderBrowser(
      <SessionDashboard
        debugStream={false}
        result={{
          ok: false,
          error: {
            kind: "network-error",
            message: "daemon offline",
          },
        }}
      />,
    );
    cleanup = () => cleanupBrowser(rendered.root, rendered.container);

    expect(rendered.container.textContent).toContain("Daemon unavailable");
    expect(rendered.container.textContent).toContain("daemon offline");
  });
});
