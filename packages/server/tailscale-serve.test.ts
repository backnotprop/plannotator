/**
 * --tailscale serve orchestration tests.
 *
 * Run: bun test packages/server/tailscale-serve.test.ts
 *
 * Every test injects a fake runner — the real `tailscale` CLI is never
 * spawned and no tailnet state is touched. Each test that successfully
 * enables a mapping drains it with the same fake runner in `finally` so the
 * module's process-exit cleanup has nothing left to act on.
 */

import { describe, expect, test } from "bun:test";
import type { TailscaleRunResult } from "@plannotator/shared/tailscale";
import { disableTailscaleServe, enableTailscaleServe } from "./tailscale-serve";

const SERVE_OUTPUT = [
  "Available within your tailnet:",
  "",
  "https://vps-1.tail1234.ts.net:4321/",
  "|-- proxy http://127.0.0.1:4321",
  "",
  "Serve started and running in the background.",
].join("\n");

function makeRunner(responses: {
  status?: TailscaleRunResult;
  serve?: TailscaleRunResult;
  off?: TailscaleRunResult;
}) {
  const calls: string[][] = [];
  const runner = (args: string[]): TailscaleRunResult => {
    calls.push(args);
    if (args[1] === "status") return responses.status ?? { status: 0, stdout: "{}", stderr: "" };
    if (args.includes("off")) return responses.off ?? { status: 0, stdout: "", stderr: "" };
    return responses.serve ?? { status: 0, stdout: SERVE_OUTPUT, stderr: "" };
  };
  return { runner, calls };
}

describe("enableTailscaleServe", () => {
  test("publishes the port and returns the tailnet HTTPS URL", () => {
    const { runner, calls } = makeRunner({});
    try {
      const { url } = enableTailscaleServe(4321, runner);
      expect(url).toBe("https://vps-1.tail1234.ts.net:4321");
      expect(calls).toContainEqual(["serve", "--bg", "--https=4321", "http://127.0.0.1:4321"]);
    } finally {
      disableTailscaleServe(4321, runner);
    }
    // Teardown issued the matching off command for our port only.
    expect(calls.at(-1)).toEqual(["serve", "--https=4321", "off"]);
  });

  test("refuses to steal a pre-existing serve mapping on the chosen port", () => {
    const { runner, calls } = makeRunner({
      status: { status: 0, stdout: JSON.stringify({ TCP: { "4321": { HTTPS: true } } }), stderr: "" },
    });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(/already routes port 4321/);
    // The pre-existing mapping was neither replaced nor torn down.
    expect(calls.some((args) => args.includes("--bg"))).toBe(false);
    expect(calls.some((args) => args.includes("off"))).toBe(false);
  });

  test("a mapping on a different port does not block ours", () => {
    const { runner } = makeRunner({
      status: { status: 0, stdout: JSON.stringify({ TCP: { "8443": { HTTPS: true } } }), stderr: "" },
    });
    try {
      expect(enableTailscaleServe(4321, runner).url).toBe("https://vps-1.tail1234.ts.net:4321");
    } finally {
      disableTailscaleServe(4321, runner);
    }
  });

  test("surfaces a missing CLI as an install hint", () => {
    const enoent = Object.assign(new Error("spawnSync tailscale ENOENT"), { code: "ENOENT" });
    const runner = () => ({ error: enoent, status: null, stdout: "", stderr: "" });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(/not found on PATH/);
  });

  test("tears its own mapping down when serve output has no parsable URL", () => {
    const { runner, calls } = makeRunner({
      serve: { status: 0, stdout: "Serve started.", stderr: "" },
    });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(/https:\/\/ URL/);
    expect(calls.at(-1)).toEqual(["serve", "--https=4321", "off"]);
  });

  test("a failed serve command reports the daemon detail", () => {
    const { runner } = makeRunner({
      serve: { status: 1, stdout: "", stderr: "invalid port" },
    });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(/invalid port/);
  });
});

describe("disableTailscaleServe", () => {
  test("is a no-op for ports this process never published", () => {
    const { runner, calls } = makeRunner({});
    disableTailscaleServe(59999, runner);
    expect(calls).toEqual([]);
  });
});
