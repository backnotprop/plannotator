import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  invokePresenterCommand,
  presentUrl,
  resolvePresenterCommand,
  type PresenterRequest,
} from "./presenter";

const fixture = fileURLToPath(
  new URL("./test-fixtures/presenter-fixture.mjs", import.meta.url),
);
if (process.platform !== "win32") chmodSync(fixture, 0o755);

const originalMode = process.env.PLANNOTATOR_TEST_PRESENTER_MODE;

afterEach(() => {
  if (originalMode === undefined) {
    delete process.env.PLANNOTATOR_TEST_PRESENTER_MODE;
  } else {
    process.env.PLANNOTATOR_TEST_PRESENTER_MODE = originalMode;
  }
});

describe("resolvePresenterCommand", () => {
  test("config presenters default to Herdr-only", () => {
    const config = { presenter: { command: "/presenter" } };
    expect(resolvePresenterCommand(config, {})).toBeUndefined();
    expect(resolvePresenterCommand(config, { HERDR_ENV: "1" })).toBe(
      "/presenter",
    );
  });

  test("config may opt into all environments", () => {
    expect(
      resolvePresenterCommand(
        { presenter: { command: "/presenter", when: "always" } },
        {},
      ),
    ).toBe("/presenter");
  });

  test("the env override runs anywhere and an empty override disables config", () => {
    const config = {
      presenter: { command: "/configured", when: "always" as const },
    };
    expect(
      resolvePresenterCommand(config, {
        PLANNOTATOR_PRESENTER: "/explicit",
      }),
    ).toBe("/explicit");
    expect(
      resolvePresenterCommand(config, { PLANNOTATOR_PRESENTER: "" }),
    ).toBeUndefined();
  });
});

describe("presentUrl", () => {
  test("sends the exact protocol and dismisses the returned handle once", async () => {
    const requests: PresenterRequest[] = [];
    const timeouts: Array<number | undefined> = [];
    const result = await presentUrl("http://localhost:3210", "review", {
      config: {},
      env: { PLANNOTATOR_PRESENTER: "/presenter" },
      invoke: async (_command, request, options) => {
        requests.push(request);
        timeouts.push(options.timeoutMs);
        return request.action === "present"
          ? {
              ok: true,
              response: {
                protocol: 1,
                ok: true,
                handle: { paneId: "pane-1" },
              },
            }
          : { ok: true, response: { protocol: 1, ok: true } };
      },
    });

    expect(result.opened).toBe(true);
    if (!result.opened) throw new Error("expected presentation");
    expect(await result.presentation.dismiss()).toEqual({ ok: true });
    expect(await result.presentation.dismiss()).toEqual({ ok: true });
    expect(requests).toEqual([
      {
        protocol: 1,
        action: "present",
        url: "http://localhost:3210",
        kind: "review",
      },
      {
        protocol: 1,
        action: "dismiss",
        handle: { paneId: "pane-1" },
      },
    ]);
    expect(timeouts).toEqual([15_000, 5_000]);
  });

  test("returns presenter failures as fallback-friendly values", async () => {
    const result = await presentUrl("http://localhost:3210", "plan", {
      config: {},
      env: { PLANNOTATOR_PRESENTER: "/presenter" },
      invoke: async () => ({ ok: false, error: "not available" }),
    });
    expect(result).toEqual({
      attempted: true,
      opened: false,
      error: "not available",
    });
  });

  test("reports a failed dismissal once even when cleanup is requested again", async () => {
    const errors: string[] = [];
    let dismissCalls = 0;
    const result = await presentUrl("http://localhost:3210", "plan", {
      config: {},
      env: { PLANNOTATOR_PRESENTER: "/presenter" },
      onDismissError: (error) => errors.push(error),
      invoke: async (_command, request) => {
        if (request.action === "present") {
          return {
            ok: true,
            response: {
              protocol: 1,
              ok: true,
              handle: { paneId: "pane-1" },
            },
          };
        }
        dismissCalls += 1;
        return { ok: false, error: "view close failed" };
      },
    });

    expect(result.opened).toBe(true);
    if (!result.opened) throw new Error("expected presentation");
    expect(await result.presentation.dismiss()).toEqual({
      ok: false,
      error: "view close failed",
    });
    expect(await result.presentation.dismiss()).toEqual({
      ok: false,
      error: "view close failed",
    });
    expect(dismissCalls).toBe(1);
    expect(errors).toEqual(["view close failed"]);
  });

  test("dismiss reuses the environment snapshot that created the handle", async () => {
    const env = {
      PLANNOTATOR_PRESENTER: "/presenter",
      HERDR_SOCKET_PATH: "/tmp/original.sock",
    };
    const socketPaths: Array<string | undefined> = [];
    const result = await presentUrl("http://localhost:3210", "plan", {
      config: {},
      env,
      invoke: async (_command, request, commandOptions) => {
        socketPaths.push(commandOptions.env?.HERDR_SOCKET_PATH);
        return request.action === "present"
          ? {
              ok: true,
              response: {
                protocol: 1,
                ok: true,
                handle: { paneId: "pane-1" },
              },
            }
          : { ok: true, response: { protocol: 1, ok: true } };
      },
    });

    env.HERDR_SOCKET_PATH = "/tmp/replaced.sock";
    expect(result.opened).toBe(true);
    if (!result.opened) throw new Error("expected presentation");
    await result.presentation.dismiss();
    expect(socketPaths).toEqual([
      "/tmp/original.sock",
      "/tmp/original.sock",
    ]);
  });

  test("rejects a success response without a lifecycle handle", async () => {
    const result = await presentUrl("http://localhost:3210", "plan", {
      config: {},
      env: { PLANNOTATOR_PRESENTER: "/presenter" },
      invoke: async () => ({
        ok: true,
        response: { protocol: 1, ok: true },
      }),
    });
    expect(result).toEqual({
      attempted: true,
      opened: false,
      error: "presenter success response is missing handle",
    });
  });
});

describe.skipIf(process.platform === "win32")(
  "presenter subprocess boundaries",
  () => {
    test("round-trips one JSON record without a shell", async () => {
      const result = await invokePresenterCommand(fixture, {
        protocol: 1,
        action: "present",
        url: "http://localhost:4321",
        kind: "annotate",
      });
      expect(result).toEqual({
        ok: true,
        response: {
          protocol: 1,
          ok: true,
          handle: {
            fixture: "http://localhost:4321",
            kind: "annotate",
          },
        },
      });
    });

    test("bounds execution time", async () => {
      process.env.PLANNOTATOR_TEST_PRESENTER_MODE = "hang";
      const result = await invokePresenterCommand(
        fixture,
        {
          protocol: 1,
          action: "present",
          url: "http://localhost:4321",
          kind: "plan",
        },
        { timeoutMs: 25 },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected timeout");
      expect(result.error).toContain("timed out");
    });

    test("cancels a pending presenter process", async () => {
      process.env.PLANNOTATOR_TEST_PRESENTER_MODE = "hang";
      const cancellation = new AbortController();
      const pending = invokePresenterCommand(
        fixture,
        {
          protocol: 1,
          action: "present",
          url: "http://localhost:4321",
          kind: "plan",
        },
        { signal: cancellation.signal },
      );
      cancellation.abort();

      const result = await pending;
      expect(result).toEqual({
        ok: false,
        error: "presenter cancelled",
      });
    });

    test("caps combined stdout and stderr", async () => {
      process.env.PLANNOTATOR_TEST_PRESENTER_MODE = "flood";
      const result = await invokePresenterCommand(
        fixture,
        {
          protocol: 1,
          action: "present",
          url: "http://localhost:4321",
          kind: "plan",
        },
        { maxOutputBytes: 1024 },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected output cap");
      expect(result.error).toContain("exceeded 1024 bytes");
    });

    test("surfaces structured presenter errors", async () => {
      process.env.PLANNOTATOR_TEST_PRESENTER_MODE = "failure";
      const result = await invokePresenterCommand(fixture, {
        protocol: 1,
        action: "present",
        url: "http://localhost:4321",
        kind: "plan",
      });
      expect(result).toEqual({
        ok: false,
        error: "fixture_failed: fixture refused",
      });
    });
  },
);
