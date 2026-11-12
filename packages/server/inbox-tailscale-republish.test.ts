/**
 * "Over your tailnet" publishes again by itself once Tailscale is back
 * (`INBOX_TAILSCALE_REPUBLISH`, packages/server/inbox-tailscale.ts): the
 * module alone, with a scripted `tailscale` and a hand-driven clock. No Inbox
 * server starts; the only listener is the module's own tailnet-only one on
 * loopback. Temp PLANNOTATOR_DATA_DIR only; the real `tailscale` never runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { createInboxTailscale, INBOX_TAILSCALE_REPUBLISH, type InboxTailscale, type InboxTailscaleTimers } from "./inbox-tailscale";

const MAGIC = "laptop.example.ts.net";
const OWNER = "owner@example.com";
const PORT = 47123;

const roots: string[] = [];
const modules: InboxTailscale[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const module of modules.splice(0)) module.stop();
  for (const restore of restoreEnv.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** A temp data dir that loadConfig() reads, with the switch on. */
function world(config: Record<string, unknown> = { inboxTailscale: true }): string {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-ts-republish-")));
  roots.push(dataDir);
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  return dataDir;
}

/** A clock the test drives: what is waiting, for how long, and firing it. */
function fakeClock() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timers: InboxTailscaleTimers = {
    set: (fn, ms) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clear: (handle) => void pending.delete(handle as number),
  };
  return {
    timers,
    waits: () => [...pending.values()].map((t) => t.ms),
    /** Fire every waiting timer, then let the retry's promise chain settle. */
    fire: async () => {
      const due = [...pending.entries()];
      for (const [id] of due) pending.delete(id);
      for (const [, t] of due) t.fn();
      await Bun.sleep(1);
    },
  };
}

type Backend = "Running" | "Stopped" | "NeedsLogin" | "Starting";

/** Tailscale as a scripted CLI: its backend state, its serve config, and every call made. */
function fakeTailscale() {
  const serve = new Map<number, string>();
  const tailscale = { backend: "Stopped" as Backend, missing: false, daemonDown: false };
  const calls: string[][] = [];
  const run: TailscaleRunner = (args) => {
    calls.push(args);
    if (tailscale.missing) return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" }) };
    if (tailscale.daemonDown) return { status: 1, stdout: "", stderr: "failed to connect to local tailscaled; it doesn't appear to be running" };
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    const running = tailscale.backend === "Running";
    if (args[0] === "status") {
      return ok(
        JSON.stringify({
          BackendState: tailscale.backend,
          Self: { DNSName: `${MAGIC}.`, UserID: 7 },
          User: running ? { "7": { ID: 7, LoginName: OWNER } } : {},
        }),
      );
    }
    if (args[1] === "status") {
      // Not running: serve has nothing to say.
      if (!running || serve.size === 0) return ok("{}");
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) {
      serve.delete(httpsPort);
      return ok();
    }
    if (!running) return { status: 1, stdout: "", stderr: "Tailscale is stopped." };
    serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
  };
  const serveCalls = () => calls.filter((args) => args[0] === "serve" && args[1] !== "status");
  return { serve, tailscale, calls, serveCalls, run };
}

function create(dataDir: string, run: TailscaleRunner, clock: ReturnType<typeof fakeClock>, kept?: InboxRegistryEntry["tailscale"]) {
  const registry: InboxRegistryEntry = {
    v: 1,
    pid: process.pid,
    port: PORT,
    url: `http://127.0.0.1:${PORT}`,
    version: "test",
    token: "t",
    serverSession: "s",
    startedAt: new Date().toISOString(),
    ...(kept ? { tailscale: kept } : {}),
  };
  const republished: number[] = [];
  const module = createInboxTailscale({
    dataDir,
    port: () => PORT,
    registry: () => registry,
    dispatch: async () => new Response("ok"),
    tailscale: run,
    timers: clock.timers,
    onRepublished: () => void republished.push(Date.now()),
  });
  modules.push(module);
  return { module, republished };
}

const WAIT = INBOX_TAILSCALE_REPUBLISH.waitMs;

describe("Over your tailnet publishes by itself once Tailscale is back", () => {
  test("stopped at start: only status is read, backing off; running again: published, the windows told once, and no timer left", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const clock = fakeClock();
    const { module, republished } = create(dataDir, ts.run, clock);
    module.start();
    const failed = module.state();
    expect(failed.url).toBeNull();
    expect(failed.error).not.toBeNull();
    expect(clock.waits()).toEqual([WAIT[0]!]);

    // Still stopped: each look reads `status --json` and nothing else, and waits longer, up to the last wait.
    const before = ts.calls.length;
    for (let i = 1; i < WAIT.length + 2; i++) {
      await clock.fire();
      expect(clock.waits()).toEqual([WAIT[Math.min(i, WAIT.length - 1)]!]);
    }
    expect(ts.calls.slice(before).every((args) => args.join(" ") === "status --json")).toBe(true);
    // Quiet: the reason the window shows is the start's, word for word.
    expect(module.state().error).toBe(failed.error);
    expect(republished).toHaveLength(0);

    ts.tailscale.backend = "Running";
    await clock.fire();
    expect(module.state()).toMatchObject({ on: true, url: `https://${MAGIC}:${PORT}/`, error: null, owner: OWNER });
    expect(ts.serve.get(PORT)).toBe(`http://127.0.0.1:${module.listenerPort()}`);
    expect(republished).toHaveLength(1);
    expect(clock.waits()).toEqual([]);
    expect(module.retrying()).toBe(false);
  });

  test("Tailscale's daemon not running at all (the app quit) is waited for the same way", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    ts.tailscale.daemonDown = true;
    const clock = fakeClock();
    const { module, republished } = create(dataDir, ts.run, clock);
    module.start();
    expect(clock.waits()).toEqual([WAIT[0]!]);
    await clock.fire();
    expect(clock.waits()).toEqual([WAIT[1]!]);
    ts.tailscale.daemonDown = false;
    ts.tailscale.backend = "Running";
    await clock.fire();
    expect(module.state().url).toBe(`https://${MAGIC}:${PORT}/`);
    expect(republished).toHaveLength(1);
    expect(clock.waits()).toEqual([]);
  });

  test("turned off while waiting: no further look, ever", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const clock = fakeClock();
    const { module } = create(dataDir, ts.run, clock);
    module.start();
    expect(module.retrying()).toBe(true);
    await module.set(false);
    expect(clock.waits()).toEqual([]);
    const calls = ts.calls.length;
    ts.tailscale.backend = "Running";
    await clock.fire();
    expect(ts.calls.length).toBe(calls);
    expect(module.state()).toMatchObject({ on: false, url: null });
  });

  test("turned on in Settings while Tailscale is stopped: the same wait, and the publish once it runs", async () => {
    const dataDir = world({});
    const ts = fakeTailscale();
    const clock = fakeClock();
    const { module, republished } = create(dataDir, ts.run, clock);
    module.start();
    expect(clock.waits()).toEqual([]);
    await module.set(true);
    expect(module.state().url).toBeNull();
    expect(clock.waits()).toEqual([WAIT[0]!]);
    ts.tailscale.backend = "Running";
    await clock.fire();
    expect(module.state().url).toBe(`https://${MAGIC}:${PORT}/`);
    expect(republished).toHaveLength(1);
  });

  test("a mapping already on the port (Tailscale running): no fast loop, no `tailscale serve` run, the words unchanged", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    ts.tailscale.backend = "Running";
    // Someone else's mapping (or one an earlier run left and forgot) on the Inbox's port.
    ts.serve.set(PORT, "http://127.0.0.1:40001");
    const clock = fakeClock();
    const { module, republished } = create(dataDir, ts.run, clock);
    module.start();
    const words = `Another tailscale serve mapping already uses port ${PORT}, the Inbox's port. The Inbox never replaces it: remove it with "tailscale serve --https=${PORT} off" if nothing needs it.`;
    expect(module.state().error).toBe(words);
    expect(clock.waits()).toEqual([INBOX_TAILSCALE_REPUBLISH.stuckMs]);

    await clock.fire();
    await clock.fire();
    // Two more tries, half an hour apart: reads only, the mapping never touched, the same words.
    expect(ts.serveCalls()).toEqual([]);
    expect(ts.serve.get(PORT)).toBe("http://127.0.0.1:40001");
    expect(module.state().error).toBe(words);
    expect(clock.waits()).toEqual([INBOX_TAILSCALE_REPUBLISH.stuckMs]);
    expect(republished).toHaveLength(0);

    // The person removes it: the next try publishes.
    ts.serve.delete(PORT);
    await clock.fire();
    expect(module.state().url).toBe(`https://${MAGIC}:${PORT}/`);
    expect(republished).toHaveLength(1);
    expect(clock.waits()).toEqual([]);
  });

  test("restarted while Tailscale's daemon was down: the last run's mapping is taken down once it is back, then published", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    // The last run's clean stop could not reach Tailscale: its record and its mapping are both still there.
    ts.serve.set(PORT, "http://127.0.0.1:40001");
    ts.tailscale.daemonDown = true;
    const clock = fakeClock();
    const { module, republished } = create(dataDir, ts.run, clock, { url: null, error: null, https_port: PORT, proxy_port: 40001 });
    module.start();
    expect(module.state().error).toContain("Could not remove the tailnet address an earlier run left");
    expect(clock.waits()).toEqual([WAIT[0]!]);
    ts.tailscale.daemonDown = false;
    ts.tailscale.backend = "Running";
    await clock.fire();
    expect(module.state()).toMatchObject({ url: `https://${MAGIC}:${PORT}/`, error: null });
    expect(ts.serve.get(PORT)).toBe(`http://127.0.0.1:${module.listenerPort()}`);
    expect(republished).toHaveLength(1);
  });

  test("restarted while Tailscale was stopped (daemon up): serve said nothing, the record went, so the mapping it left blocks the publish; the slow retry waits for the person", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    // Stopped: `serve status` answers empty, so the take-down finds nothing and forgets the record.
    ts.serve.set(PORT, "http://127.0.0.1:40001");
    const clock = fakeClock();
    const { module, republished } = create(dataDir, ts.run, clock, { url: null, error: null, https_port: PORT, proxy_port: 40001 });
    module.start();
    expect(clock.waits()).toEqual([WAIT[0]!]);
    ts.tailscale.backend = "Running";
    await clock.fire();
    expect(module.state().error).toStartWith(`Another tailscale serve mapping already uses port ${PORT}`);
    expect(clock.waits()).toEqual([INBOX_TAILSCALE_REPUBLISH.stuckMs]);
    expect(republished).toHaveLength(0);
  });

  test("published at start: no timer; off: no timer; no `tailscale` CLI at all: no timer, as before", async () => {
    {
      const dataDir = world();
      const ts = fakeTailscale();
      ts.tailscale.backend = "Running";
      const clock = fakeClock();
      const { module } = create(dataDir, ts.run, clock);
      module.start();
      expect(module.state().url).toBe(`https://${MAGIC}:${PORT}/`);
      expect(clock.waits()).toEqual([]);
    }
    {
      const dataDir = world({});
      const ts = fakeTailscale();
      const clock = fakeClock();
      const { module } = create(dataDir, ts.run, clock);
      module.start();
      expect(ts.calls).toEqual([]);
      expect(clock.waits()).toEqual([]);
    }
    {
      const dataDir = world();
      const ts = fakeTailscale();
      ts.tailscale.missing = true;
      const clock = fakeClock();
      const { module } = create(dataDir, ts.run, clock);
      module.start();
      expect(module.state().error).toContain("not found on PATH");
      expect(clock.waits()).toEqual([]);
    }
  });

  test("the stop clears a waiting look", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const clock = fakeClock();
    const { module } = create(dataDir, ts.run, clock);
    module.start();
    expect(clock.waits()).toEqual([WAIT[0]!]);
    module.stop();
    expect(clock.waits()).toEqual([]);
    expect(module.retrying()).toBe(false);
  });
});
