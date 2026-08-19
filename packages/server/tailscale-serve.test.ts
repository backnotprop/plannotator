/**
 * --tailscale serve orchestration tests.
 *
 * Run: bun test packages/server/tailscale-serve.test.ts
 *
 * Every test injects a fake runner — the real `tailscale` CLI is never
 * spawned and no tailnet state is touched. Bun runs every test file in one
 * process, so afterEach resets the module's port registry, cleanup runner,
 * and process exit listener via resetTailscaleServeForTests().
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { TailscaleRunResult } from "@plannotator/shared/tailscale";
import {
  disableTailscaleServe,
  enableTailscaleServe,
  resetTailscaleServeForTests,
} from "./tailscale-serve";

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
  off?: TailscaleRunResult | ((offCallIndex: number) => TailscaleRunResult);
}) {
  const calls: string[][] = [];
  let offCalls = 0;
  const runner = (args: string[]): TailscaleRunResult => {
    calls.push(args);
    if (args[1] === "status") return responses.status ?? { status: 0, stdout: "{}", stderr: "" };
    if (args.includes("off")) {
      const off = responses.off;
      if (typeof off === "function") return off(offCalls++);
      return off ?? { status: 0, stdout: "", stderr: "" };
    }
    return responses.serve ?? { status: 0, stdout: SERVE_OUTPUT, stderr: "" };
  };
  return { runner, calls };
}

function captureStderr(): { output: () => string; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    output: () => captured,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

afterEach(() => {
  resetTailscaleServeForTests();
});

describe("enableTailscaleServe", () => {
  test("publishes the port and returns the tailnet HTTPS URL", () => {
    const { runner, calls } = makeRunner({});
    const { url } = enableTailscaleServe(4321, runner);
    expect(url).toBe("https://vps-1.tail1234.ts.net:4321");
    expect(calls).toContainEqual(["serve", "--bg", "--https=4321", "http://127.0.0.1:4321"]);
    disableTailscaleServe(4321, runner);
    // Teardown issued the matching off command for our port only.
    expect(calls.at(-1)).toEqual(["serve", "--https=4321", "off"]);
  });

  test("refuses to steal a pre-existing background mapping on the chosen port", () => {
    const { runner, calls } = makeRunner({
      status: { status: 0, stdout: JSON.stringify({ TCP: { "4321": { HTTPS: true } } }), stderr: "" },
    });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(/already routes port 4321/);
    // The pre-existing mapping was neither replaced nor torn down.
    expect(calls.some((args) => args.includes("--bg"))).toBe(false);
    expect(calls.some((args) => args.includes("off"))).toBe(false);
  });

  test("refuses a foreground session mapping too (Tailscale prefers foreground handlers)", () => {
    const { runner, calls } = makeRunner({
      status: {
        status: 0,
        stdout: JSON.stringify({ Foreground: { "987": { TCP: { "4321": { HTTPS: true } } } } }),
        stderr: "",
      },
    });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(/already routes port 4321/);
    expect(calls.some((args) => args.includes("--bg"))).toBe(false);
  });

  test("fails closed on unrecognizable serve status output", () => {
    const { runner, calls } = makeRunner({
      status: { status: 0, stdout: "something unexpected", stderr: "" },
    });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(/could not parse/);
    expect(calls.some((args) => args.includes("--bg"))).toBe(false);
  });

  test("a mapping on a different port does not block ours", () => {
    const { runner } = makeRunner({
      status: { status: 0, stdout: JSON.stringify({ TCP: { "8443": { HTTPS: true } } }), stderr: "" },
    });
    expect(enableTailscaleServe(4321, runner).url).toBe("https://vps-1.tail1234.ts.net:4321");
    disableTailscaleServe(4321, runner);
  });

  test("surfaces a missing CLI as an install hint", () => {
    const enoent = Object.assign(new Error("spawnSync tailscale ENOENT"), { code: "ENOENT" });
    const runner = () => ({ error: enoent, status: null, stdout: "", stderr: "" });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(/not found on PATH/);
  });

  test("rejects serve output whose only https URL is for a different port", () => {
    const { runner, calls } = makeRunner({
      serve: { status: 0, stdout: "https://vps-1.tail1234.ts.net:8443/\n", stderr: "" },
    });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(/https:\/\/ URL for port 4321/);
    // Our own just-created mapping was taken back down.
    expect(calls.at(-1)).toEqual(["serve", "--https=4321", "off"]);
  });

  test("a failed serve command reports the daemon detail", () => {
    const { runner } = makeRunner({
      serve: { status: 1, stdout: "", stderr: "invalid port" },
    });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(/invalid port/);
  });
});

describe("teardown hardening", () => {
  test("a failed off retries once, warns with the manual command, and keeps the port for exit retry", () => {
    const { runner, calls } = makeRunner({ off: { status: 1, stdout: "", stderr: "backend stopped" } });
    enableTailscaleServe(4321, runner);
    const stderr = captureStderr();
    try {
      disableTailscaleServe(4321, runner);
    } finally {
      stderr.restore();
    }
    const offCalls = calls.filter((args) => args.includes("off"));
    expect(offCalls).toHaveLength(2);
    // The warning names the exact manual cleanup command.
    expect(stderr.output()).toContain(`tailscale serve --https=4321 off`);
    // The port was NOT forgotten: a later disable retries the off again.
    const stderr2 = captureStderr();
    try {
      disableTailscaleServe(4321, runner);
    } finally {
      stderr2.restore();
    }
    expect(calls.filter((args) => args.includes("off"))).toHaveLength(4);
  });

  test("an off that succeeds on the retry forgets the port silently", () => {
    const { runner, calls } = makeRunner({
      off: (index) => (index === 0 ? { status: 1, stdout: "", stderr: "flake" } : { status: 0, stdout: "", stderr: "" }),
    });
    enableTailscaleServe(4321, runner);
    const stderr = captureStderr();
    try {
      disableTailscaleServe(4321, runner);
    } finally {
      stderr.restore();
    }
    expect(stderr.output()).toBe("");
    // Port forgotten: another disable is a no-op.
    disableTailscaleServe(4321, runner);
    expect(calls.filter((args) => args.includes("off"))).toHaveLength(2);
  });
});

describe("SIGHUP routing", () => {
  // Guards the nohup contract: any SIGHUP listener overrides the ignored
  // disposition `nohup` depends on, so a listener may exist ONLY while a
  // serve mapping does. An unconditional listener regressed
  // `nohup plannotator review &` into dying on terminal close.
  test("installs the SIGHUP→exit route only once a mapping exists, and reset removes it", () => {
    const before = process.listenerCount("SIGHUP");
    const { runner } = makeRunner({});
    enableTailscaleServe(4321, runner);
    expect(process.listenerCount("SIGHUP")).toBe(before + 1);
    resetTailscaleServeForTests();
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });

  test("a failed publish leaves no SIGHUP listener behind", () => {
    const before = process.listenerCount("SIGHUP");
    const { runner } = makeRunner({
      status: { status: 1, stdout: "", stderr: "backend stopped" },
    });
    expect(() => enableTailscaleServe(4321, runner)).toThrow();
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });
});

describe("disableTailscaleServe", () => {
  test("is a no-op for ports this process never published", () => {
    const { runner, calls } = makeRunner({});
    disableTailscaleServe(59999, runner);
    expect(calls).toEqual([]);
  });
});
