import { afterEach, describe, expect, test } from "vitest";
import { cleanupBrowser, renderBrowser } from "../testing/browser/render";
import { sessionBootstraps } from "../testing/fixtures/daemon";
import { SessionRouteView } from "./SessionRouteView";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("SessionRouteView browser rendering", () => {
  test.each([
    ["plan", "Plan review"],
    ["review", "Code review"],
    ["annotate", "Annotate"],
    ["archive", "Archive"],
    ["setup-goal", "Setup goal"],
  ] as const)("renders %s session shell", async (mode, heading) => {
    const rendered = await renderBrowser(
      <SessionRouteView result={{ ok: true, data: sessionBootstraps[mode] }} />,
    );
    cleanup = () => cleanupBrowser(rendered.root, rendered.container);

    expect(rendered.container.textContent).toContain(heading);
    expect(rendered.container.textContent).toContain(sessionBootstraps[mode].apiBase);
  });

  test("renders unsupported sessions deliberately", async () => {
    const rendered = await renderBrowser(
      <SessionRouteView result={{ ok: true, data: sessionBootstraps.unsupported }} />,
    );
    cleanup = () => cleanupBrowser(rendered.root, rendered.container);

    expect(rendered.container.textContent).toContain("Unsupported session");
    expect(rendered.container.textContent).toContain("unknown-mode");
  });

  test("renders bootstrap failure", async () => {
    const rendered = await renderBrowser(
      <SessionRouteView
        result={{
          ok: false,
          error: {
            kind: "daemon-error",
            status: 404,
            code: "session-not-found",
            message: "Session not found.",
          },
        }}
      />,
    );
    cleanup = () => cleanupBrowser(rendered.root, rendered.container);

    expect(rendered.container.textContent).toContain("Session could not be loaded");
    expect(rendered.container.textContent).toContain("Session not found.");
  });
});
