import { afterEach, describe, expect, test } from "bun:test";
import type { TailscaleRunResult } from "@plannotator/shared/tailscale";
import {
  announceTailscaleSession,
  disableTailscaleServe,
  enableServeSteps,
  enableTailscaleServe,
  resetTailscaleServeForTests,
  runTailscaleSteps,
  runTailscaleStepsAsync,
  takeDownOwnServeSteps,
} from "./tailscale-serve";
import { createRequestHostGuard } from "./request-host-guard";

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
    expect(calls.at(-1)).toEqual(["serve", "--https=4321", "off"]);
  });

  test("refuses to steal a pre-existing background mapping on the chosen port", () => {
    const { runner, calls } = makeRunner({
      status: { status: 0, stdout: JSON.stringify({ TCP: { "4321": { HTTPS: true } } }), stderr: "" },
    });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(/already routes port 4321/);
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
    expect(calls.at(-1)).toEqual(["serve", "--https=4321", "off"]);
  });

  const SERVE_OFF = "\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nABC\n\n";

  test("Serve off for the tailnet, CLI exits 0: says so with Tailscale's link and takes nothing down", () => {
    const { runner, calls } = makeRunner({ serve: { status: 0, stdout: SERVE_OFF, stderr: "" } });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(
      /Serve is off for your tailnet[\s\S]*not a Plannotator bug[\s\S]*https:\/\/login\.tailscale\.com\/f\/serve\?node=nABC/,
    );
    expect(calls.some((args) => args.includes("off"))).toBe(false);
  });

  test("Serve off for the tailnet, CLI waits until we time out: the link it printed still reaches the user", () => {
    const timedOut = Object.assign(new Error("spawnSync tailscale ETIMEDOUT"), { code: "ETIMEDOUT" });
    const { runner } = makeRunner({ serve: { error: timedOut, status: null, stdout: SERVE_OFF, stderr: "" } });
    expect(() => enableTailscaleServe(4321, runner)).toThrow(/Serve is off[\s\S]*f\/serve\?node=nABC/);
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
    expect(stderr.output()).toContain(`tailscale serve --https=4321 off`);
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
    disableTailscaleServe(4321, runner);
    expect(calls.filter((args) => args.includes("off"))).toHaveLength(2);
  });
});

describe("SIGHUP routing", () => {
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

describe("enableTailscaleServe for the Inbox (8443, persisted, re-pointed)", () => {
  const INBOX_OUTPUT = "Available within your tailnet:\n\nhttps://vps-1.tail1234.ts.net:8443/\n|-- proxy http://127.0.0.1:52900\n";
  const mapped = (proxy: string) =>
    JSON.stringify({ TCP: { "8443": { HTTPS: true } }, Web: { "vps-1.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: proxy } } } } });

  test("re-points its own mapping from the last run's port and keeps it past exit", () => {
    const { runner, calls } = makeRunner({ status: { status: 0, stdout: mapped("http://127.0.0.1:52817"), stderr: "" }, serve: { status: 0, stdout: INBOX_OUTPUT, stderr: "" } });
    const before = process.listenerCount("exit");
    const { url } = enableTailscaleServe(52900, runner, { httpsPort: 8443, ownTargets: ["http://127.0.0.1:52900", "http://127.0.0.1:52817"], persist: true });
    expect(url).toBe("https://vps-1.tail1234.ts.net:8443");
    expect(calls[1]).toEqual(["serve", "--bg", "--https=8443", "http://127.0.0.1:52900"]);
    expect(process.listenerCount("exit")).toBe(before);
    expect(createRequestHostGuard({ localOnly: true }).check(new Request("http://127.0.0.1/", { headers: { Host: "vps-1.tail1234.ts.net:8443" } }))?.status).toBe(403);
  });

  test("never overwrites a mapping on 8443 that points anywhere else", () => {
    const { runner, calls } = makeRunner({ status: { status: 0, stdout: mapped("http://127.0.0.1:3000"), stderr: "" } });
    expect(() => enableTailscaleServe(52900, runner, { httpsPort: 8443, ownTargets: ["http://127.0.0.1:52900"], persist: true })).toThrow(/already routes port 8443/);
    expect(calls).toHaveLength(1);
  });
});

describe("announceTailscaleSession", () => {
  const withoutReadyFile = async (fn: () => Promise<void>): Promise<void> => {
    const original = process.env.PLANNOTATOR_READY_FILE;
    delete process.env.PLANNOTATOR_READY_FILE;
    try {
      await fn();
    } finally {
      if (original === undefined) delete process.env.PLANNOTATOR_READY_FILE;
      else process.env.PLANNOTATOR_READY_FILE = original;
    }
  };

  test("prints the ready line once, above the tailnet line, and opens no browser", async () => {
    const url = "https://vps-1.tail1234.ts.net:4321";
    const capture = captureStderr();
    try {
      await withoutReadyFile(() => announceTailscaleSession(url, 4321));
    } finally {
      capture.restore();
    }
    const output = capture.output();
    expect(output.split("Plannotator session ready: ").length - 1).toBe(1);
    expect(output.split(url).length - 1).toBe(1);
    expect(output).toContain(`\n  Plannotator session ready: ${url}\n`);
    expect(output.indexOf("Plannotator session ready: ")).toBeLessThan(output.indexOf("Served over your tailnet"));
    expect(output).not.toContain("Could not open a browser");
  });
});

describe("the same calls, at once or without blocking", () => {
  const outcome = async <T>(run: () => T | Promise<T>) => {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  };

  test("every sequence makes the same calls and answers the same, a runner that throws included", async () => {
    const mapped = JSON.stringify({ TCP: { "8443": { HTTPS: true } }, Web: { "vps-1.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4321" } } } } });
    const worlds: { name: string; responses: Parameters<typeof makeRunner>[0]; throwOnOff?: number }[] = [
      { name: "free port", responses: {} },
      { name: "status fails", responses: { status: { status: 1, stdout: "", stderr: "Tailscale is stopped." } } },
      { name: "someone else's mapping", responses: { status: { status: 0, stdout: mapped, stderr: "" } } },
      { name: "serve answers no url, off fails once", responses: { serve: { status: 0, stdout: "ok", stderr: "" }, off: (i) => ({ status: i === 0 ? 1 : 0, stdout: "", stderr: "" }) } },
      { name: "own mapping taken down, the off throwing once", responses: { status: { status: 0, stdout: mapped, stderr: "" } }, throwOnOff: 0 },
    ];
    const sequences = [
      { name: "enable", steps: () => enableServeSteps(4321, { httpsPort: 8443, ownTargets: [], persist: true }) },
      { name: "take down own", steps: () => takeDownOwnServeSteps(8443, ["http://127.0.0.1:4321"]) },
    ];
    const stderr = captureStderr();
    try {
      for (const world of worlds) {
        for (const sequence of sequences) {
          const runner = () => {
            const made = makeRunner(world.responses);
            let offs = 0;
            const run = (args: string[]) => {
              if (args.includes("off") && world.throwOnOff === offs++) {
                made.calls.push(args);
                throw new Error("spawn failed");
              }
              return made.runner(args);
            };
            return { run, calls: made.calls };
          };
          const atOnce = runner();
          const later = runner();
          const syncAnswer = await outcome(() => runTailscaleSteps(sequence.steps(), atOnce.run));
          const asyncAnswer = await outcome(() =>
            runTailscaleStepsAsync(sequence.steps(), (args) => new Promise((resolve, reject) => setTimeout(() => {
              try {
                resolve(later.run(args));
              } catch (error) {
                reject(error);
              }
            }, 1))),
          );
          const label = `${world.name} / ${sequence.name}`;
          expect({ label, answer: asyncAnswer, calls: later.calls }).toEqual({ label, answer: syncAnswer, calls: atOnce.calls });
        }
      }
    } finally {
      stderr.restore();
    }
  });

  test("while a call waits, the event loop keeps turning", async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    try {
      const { runner } = makeRunner({});
      const answer = await runTailscaleStepsAsync(enableServeSteps(4321, { persist: true }), (args) => new Promise((resolve) => setTimeout(() => resolve(runner(args)), 60)));
      expect(answer.url).toBe("https://vps-1.tail1234.ts.net:4321");
      expect(ticks).toBeGreaterThan(5);
    } finally {
      clearInterval(timer);
    }
  });
});
