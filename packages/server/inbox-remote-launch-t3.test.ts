/**
 * Starting an agent in T3 Code on another linked machine (issue #3590), end to end on two real Inboxes linked both
 * ways: "MacBook" (A) and "Mini" (B), each `plannotator inbox --background` in its own scratch HOME and data dir, under
 * the test sandbox (as inbox-remote-launch.test.ts runs them), each with "Start new agents in" T3 Code. Each machine
 * has only its own T3 stand-in (tests/helpers/fake-t3.ts, its `t3` launcher in the sandbox's agent home) and its own
 * fake `claude` (tests/helpers/fake-claude); no real T3 or agent is ever run. Every proof runs both ways.
 *
 *  1. A's window starts Claude Code on B: B's `t3 thread start` runs in B's project on the model B's T3 last ran
 *     Claude Code on, A's T3 runs nothing, and B's thread names what T3 runs it on.
 *  2. T3 Code closed on B: B starts the agent in the background, and the line A's window reads says why.
 *  3. Stop pressed in A's window for B's T3 thread: refused in words the window shows; nothing says "stopped".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_RUN_IN_T3_STOP } from "@plannotator/core/inbox-run-line";
import { installFakeClaude, type FakeClaude } from "../../tests/helpers/fake-claude";
import { makeFakeT3Home, type FakeT3Home } from "../../tests/helpers/fake-t3";
import { createInboxWorld, destroyInboxWorld, registry, removeStubbedHtml, stubBuiltHtml, waitFor, worldEnv, type InboxWorld } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

interface Machine {
  w: InboxWorld;
  name: string;
  id: string;
  calls: string;
  t3: FakeT3Home;
  fake: FakeClaude;
  project: { id: string; root: string };
}

const agentsHome = (m: Pick<Machine, "w">) => join(m.w.dataDir, "agents-home");
const env = (m: Pick<Machine, "w" | "name">) => ({
  ...(process.env as Record<string, string>),
  ...worldEnv(m.w),
  PLANNOTATOR_TEST_SANDBOX: m.w.root,
  PLANNOTATOR_TEST_LAUNCH_PATH: `${join(m.w.root, "fakes")}:/usr/bin:/bin`,
  PLANNOTATOR_MACHINE_NAME: m.name,
  PLANNOTATOR_UPDATE_CHECK: "0",
  PLANNOTATOR_INBOX_NOTES: "0",
  NO_ANON_PING: "1",
  NO_BROWSER: "1",
});
const base = (m: Machine) => `http://127.0.0.1:${registry(m.w).port}`;

function cli(m: Pick<Machine, "w" | "name">, ...args: string[]): { code: number; out: string; err: string } {
  const run = Bun.spawnSync([join(m.w.bin, "plannotator"), "inbox", ...args], { env: env(m), cwd: m.w.root });
  return { code: run.exitCode ?? -1, out: run.stdout.toString(), err: run.stderr.toString() };
}

async function getJson(m: Machine, path: string): Promise<Json> {
  return (await (await fetch(`${base(m)}${path}`)).json()) as Json;
}

/** A write as the window sends it: this Inbox's own Origin and page session. */
async function windowPost(m: Machine, path: string, body: Json): Promise<Response> {
  const { serverSession } = await getJson(m, "/api/inbox/health");
  return fetch(`${base(m)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base(m) }, body: JSON.stringify({ serverSession, ...body }) });
}

const stateOf = async (m: Machine, other: Machine) => ((await getJson(m, "/api/inbox/machines")).machines as Json[]).find((x) => x.id === other.id)?.state ?? null;

function link(from: Machine, to: Machine): void {
  const offered = cli(to, "link", "--offer");
  expect(offered.code).toBe(0);
  const linked = cli(from, "link", offered.out.trim(), "--address", base(to), "--back", base(from));
  if (linked.code !== 0) throw new Error(`link failed: ${linked.err}`);
}

/** A git repository an agent wrote from, so it is one of this machine's projects. */
async function projectOn(m: Machine, root: string): Promise<{ id: string; root: string }> {
  const response = await fetch(`${base(m)}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { body: "Ready.", project_path: root, agent_session: `ses-${m.name}`, agent_host: "claude-code" } } }),
  });
  expect(response.status).toBe(200);
  await response.text();
  const project = ((await getJson(m, "/api/inbox/projects")).projects as Json[]).find((p) => p.root === root);
  expect(project).toBeDefined();
  return { id: project!.id as string, root };
}

/** `to.launch` for Claude Code in a project on `there`, as compose sends it. */
const launchBody = (key: string, project: string) => ({
  idempotency_key: key,
  body: "Make the refund webhook retry a 409 three times with the same key, then alert.",
  thread_name: `Refund retries ${key}`,
  to: { launch: { agent: "claude-code", project_id: project } },
});

describe("starting an agent in T3 Code on another linked machine, on two real Inboxes linked both ways", () => {
  let stubs: string[] = [];
  let A: Machine;
  let B: Machine;

  beforeAll(async () => {
    stubs = stubBuiltHtml();
    const made: Machine[] = [];
    for (const name of ["MacBook", "Mini"]) {
      const w = createInboxWorld(`plannotator-remote-t3-${name.toLowerCase()}-`, name, "remote-launch-t3");
      const calls = join(w.root, "tailscale-calls.txt");
      writeFileSync(join(w.bin, "tailscale"), `#!/bin/sh\necho "tailscale $*" >> '${calls}'\nexit 1\n`);
      chmodSync(join(w.bin, "tailscale"), 0o755);
      // The project: a git repository on `main`, made with no git config of the machine running the test.
      const folder = join(w.root, `${name.toLowerCase()}-billing-svc`);
      mkdirSync(folder, { recursive: true });
      Bun.spawnSync(["/usr/bin/git", "init", "-q", "-b", "main"], { cwd: folder, env: { PATH: "/usr/bin:/bin", HOME: w.home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      const root = realpathSync(folder);
      // Its own T3 Code: knows the project, and its threads there ran Claude Code on opus and Codex on gpt-5.5.
      mkdirSync(w.dataDir, { recursive: true });
      const t3 = makeFakeT3Home(join(w.dataDir, "agents-home"), {}, {
        projects: [root],
        used: {
          [root]: [
            { threadId: `thread:project:${name}:1`, title: "Totals", providerInstanceId: "claudeAgent", model: "opus" },
            { threadId: `thread:project:${name}:2`, title: "Copy", providerInstanceId: "codex", model: "gpt-5.5" },
          ],
        },
      });
      // Its own Claude Code, for a start in the background: Plannotator's plugin on, the project trusted.
      const fake = installFakeClaude({ bin: join(w.root, "fakes"), state: join(w.root, "fake-claude"), config: { workMs: 60_000, hold: true } });
      mkdirSync(join(agentsHome({ w }), ".claude"), { recursive: true });
      writeFileSync(join(agentsHome({ w }), ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "plannotator@plannotator": true } }));
      writeFileSync(join(agentsHome({ w }), ".claude.json"), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }));
      writeFileSync(join(w.dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, startIn: "t3" } }));
      const m: Machine = { w, name, id: "", calls, t3, fake, project: { id: "", root } };
      const started = cli(m, "--background");
      if (started.code !== 0) throw new Error(`inbox --background failed: ${started.err}`);
      m.id = (await getJson(m, "/api/inbox/health")).inbox_id as string;
      m.project = await projectOn(m, root);
      made.push(m);
    }
    [A, B] = made as [Machine, Machine];
    link(A, B);
    await waitFor("A sees B online", async () => (await stateOf(A, B)) === "online");
    await waitFor("B sees A online", async () => (await stateOf(B, A)) === "online");
  }, 120_000);

  afterAll(async () => {
    for (const m of [A, B]) {
      if (!m) continue;
      m.fake.stopAll();
      // Nothing here may change the system's Tailscale.
      expect(existsSync(m.calls)).toBe(false);
      await destroyInboxWorld(m.w);
    }
    removeStubbedHtml(stubs);
  });

  const both = () =>
    [
      [A, B],
      [B, A],
    ] as const;
  const startsOn = (m: Machine) => m.t3.starts().length;

  test("1. this window starts Claude Code on the other machine, and it starts there as a T3 thread on the model that machine's T3 last ran Claude Code on", async () => {
    for (const [here, there] of both()) {
      const mine = startsOn(here);
      const before = startsOn(there);
      const sent = await windowPost(here, `/api/inbox/m/${there.id}/messages`, launchBody(`k-t3-${here.name}`, there.project.id));
      expect(sent.status).toBe(200);
      const answer = (await sent.json()) as Json;
      await waitFor(`t3 thread start on ${there.name}`, async () => startsOn(there) === before + 1, 20_000);
      expect(startsOn(here)).toBe(mine);
      const start = there.t3.starts().at(-1)!;
      expect(start).toMatchObject({ cwd: there.project.root, base: null, provider: "claudeAgent", model: "opus" });
      // The thread is the other machine's, started from this one, and names what T3 runs it on.
      const root = await waitFor(`${there.name} names what T3 runs`, async () => {
        const own = await getJson(there, `/api/inbox/threads/${answer.thread_id}`);
        const first = (own.thread.messages as Json[])[0]!;
        return first.launch?.inner ? first : null;
      }, 20_000);
      expect(root.launch.from).toEqual({ machine: here.id, name: here.name });
      expect(root.launch.agent).toBe("claude-code");
      expect(root.launch.t3).toEqual({});
      expect(root.launch.inner).toEqual({ provider: "claudeAgent", model: "opus", agent: "Claude Code" });
      expect(root.to).toEqual({ host: "t3", session: start.id });
    }
  }, 90_000);

  test("2. T3 Code closed on the other machine: it starts the agent in the background there, and the line this window reads says why", async () => {
    for (const [here, there] of both()) {
      there.t3.setState("down");
      try {
        const before = startsOn(there);
        const sent = await windowPost(here, `/api/inbox/m/${there.id}/messages`, launchBody(`k-t3-down-${here.name}`, there.project.id));
        expect(sent.status).toBe(200);
        const { thread_id } = (await sent.json()) as Json;
        const run = await waitFor(`${here.name} reads the line`, async () => {
          const read = await getJson(here, `/api/inbox/m/${there.id}/threads/${thread_id}`);
          return read.run?.t3?.unavailable ? read.run : null;
        }, 20_000);
        expect(run.t3).toEqual({ unavailable: true });
        expect(startsOn(there)).toBe(before);
      } finally {
        there.t3.setState("up");
      }
    }
  }, 60_000);

  test("3. Stop pressed in this window for a T3 thread on the other machine is refused in words; nothing says stopped", async () => {
    for (const [here, there] of both()) {
      const sent = (await (await windowPost(here, `/api/inbox/m/${there.id}/messages`, launchBody(`k-t3-stop-${here.name}`, there.project.id))).json()) as Json;
      await waitFor(`${there.name} started it`, async () => {
        const own = await getJson(there, `/api/inbox/threads/${sent.thread_id}`);
        return (own.thread.messages as Json[])[0]!.launch?.session_ref;
      }, 20_000);
      const stop = await windowPost(here, `/api/inbox/m/${there.id}/launch/${sent.launch.id}/stop`, { idempotency_key: `k-t3-stop-press-${here.name}` });
      expect(stop.status).not.toBe(200);
      expect(((await stop.json()) as Json).error).toContain(INBOX_RUN_IN_T3_STOP);
      const read = await getJson(here, `/api/inbox/m/${there.id}/threads/${sent.thread_id}`);
      expect(read.run?.state ?? null).not.toBe("stopped");
    }
  }, 60_000);
});
