/**
 * Starting an agent on another linked machine (remote launch), end to end on two real Inboxes linked both ways:
 * "MacBook" (A) and "Mini" (B), each `plannotator inbox --background` (the compiled binary when
 * PLANNOTATOR_INBOX_TEST_BINARY names one, else the CLI from source) in its own scratch HOME and data dir, under the
 * test sandbox, with Phones, Connect, notes and the update check off and no browser. Launch is on in both, and each
 * finds only its own fake `claude` (tests/helpers/fake-claude, through PLANNOTATOR_TEST_LAUNCH_PATH). The machines
 * link through the real CLI pairing over loopback; a `tailscale` stand-in records any call, and none may happen.
 *
 * Every proof runs both ways (A starts on B, and B on A): no machine is special.
 *
 *  1. Each machine's health says it takes launches from its linked machines.
 *  2. A press in A's window starts Claude Code on B through the forward: B's fake runs `--bg` in B's folder, A's
 *     runs nothing, and B's launch records that A started it. The thread lives on B; A reads its run line.
 *  3. An agent's bare call through the forward is refused (`window_only`), nothing is held, nothing starts; so is
 *     a machine's own call at the door without the window's mark. A Stop pressed in A's window stops B's session;
 *     a bare Stop is refused.
 *  4. Trust and start across the link: B's untrusted folder is offered to A's window with B's own facts; one press
 *     trusts it on B (B's Claude config) and starts there.
 *  5. B asleep: a launch from A waits (202 queued). Cancel takes one back before it ever left; the other starts on
 *     B exactly once when B is back, and the cancelled one never does.
 *  6. Readiness: A's machine list says B takes launches; B's Claude Code signed out shows in B's launch block, read
 *     through the forward, with the SSH cause when B's Inbox was started over SSH; a launch is refused in words that
 *     name B, nothing starts, and once signed in it starts at once. Launch off on B: its health says 0.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installFakeClaude, type FakeClaude } from "../../tests/helpers/fake-claude";
import { createInboxWorld, destroyInboxWorld, registry, removeStubbedHtml, stopInbox, stubBuiltHtml, waitFor, worldEnv, type InboxWorld } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

interface Machine {
  w: InboxWorld;
  name: string;
  id: string;
  calls: string;
  fake: FakeClaude;
  /** A project of this machine's own (a git folder an agent wrote from). */
  project: { id: string; root: string };
  /** A second project its Claude Code does not trust yet. */
  untrusted: { id: string; root: string };
}

const agentsHome = (m: Machine) => join(m.w.dataDir, "agents-home");
const env = (m: Machine) => ({
  ...(process.env as Record<string, string>),
  ...worldEnv(m.w),
  PLANNOTATOR_TEST_SANDBOX: m.w.root,
  PLANNOTATOR_TEST_LAUNCH_PATH: `${join(m.w.root, "fakes")}:/usr/bin:/bin`,
  PLANNOTATOR_MACHINE_NAME: m.name,
  // Mini's Inbox was started over SSH (macOS then keeps Claude Code's login locked); the MacBook's was not.
  SSH_CONNECTION: m.name === "Mini" ? "10.0.0.2 50022 10.0.0.3 22" : "",
  PLANNOTATOR_UPDATE_CHECK: "0",
  PLANNOTATOR_INBOX_NOTES: "0",
  NO_ANON_PING: "1",
  NO_BROWSER: "1",
});
const base = (m: Machine) => `http://127.0.0.1:${registry(m.w).port}`;

function cli(m: Machine, ...args: string[]): { code: number; out: string; err: string } {
  const run = Bun.spawnSync([join(m.w.bin, "plannotator"), "inbox", ...args], { env: env(m), cwd: m.w.root });
  return { code: run.exitCode ?? -1, out: run.stdout.toString(), err: run.stderr.toString() };
}

function start(m: Machine): void {
  const run = cli(m, "--background");
  if (run.code !== 0) throw new Error(`inbox --background failed: ${run.err}`);
}

async function getJson(m: Machine, path: string): Promise<Json> {
  return (await (await fetch(`${base(m)}${path}`)).json()) as Json;
}

/** A write as the window sends it: this Inbox's own Origin and page session. */
async function windowPost(m: Machine, path: string, body: Json): Promise<Response> {
  const { serverSession } = await getJson(m, "/api/inbox/health");
  return fetch(`${base(m)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base(m) }, body: JSON.stringify({ serverSession, ...body }) });
}

/** The same write as an agent's or a script's bare call makes it: no Origin, no page session. */
const barePost = (m: Machine, path: string, body: Json) => fetch(`${base(m)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const stateOf = async (m: Machine, other: Machine) => ((await getJson(m, "/api/inbox/machines")).machines as Json[]).find((x) => x.id === other.id)?.state ?? null;

function link(from: Machine, to: Machine): void {
  const offered = cli(to, "link", "--offer");
  expect(offered.code).toBe(0);
  const linked = cli(from, "link", offered.out.trim(), "--address", base(to), "--back", base(from));
  if (linked.code !== 0) throw new Error(`link failed: ${linked.err}`);
  expect(linked.out).toContain("both ways");
}

/** An agent writes from `folder`, so the folder is one of this machine's projects. */
async function projectOn(m: Machine, folder: string): Promise<{ id: string; root: string }> {
  mkdirSync(folder, { recursive: true });
  Bun.spawnSync(["/usr/bin/git", "init", "-q"], { cwd: folder, env: { PATH: "/usr/bin:/bin", HOME: m.w.home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const root = realpathSync(folder);
  const response = await fetch(`${base(m)}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { body: "Ready.", project_path: root, agent_session: `ses-${m.name}-${folder.length}`, agent_host: "claude-code" } } }),
  });
  expect(response.status).toBe(200);
  await response.text();
  const project = ((await getJson(m, "/api/inbox/projects")).projects as Json[]).find((p) => p.root === root);
  expect(project).toBeDefined();
  return { id: project!.id as string, root };
}

/** `to.launch` for a project on `there`, as compose sends it. */
const launchBody = (key: string, project: string, extra: Json = {}) => ({
  idempotency_key: key,
  body: "Make the refund webhook retry a 409 three times with the same key, then alert.",
  thread_name: `Refund retries ${key}`,
  to: { launch: { agent: "claude-code", project_id: project, ...extra } },
});

const startsIn = (m: Machine, folder: string) => m.fake.starts().filter((s) => s.cwd === folder);
const outboxWaiting = async (m: Machine) => ((await getJson(m, "/api/inbox/outbox")).waiting as Json[]).length;
/** The token `from` holds for `to`'s door (its machines.json, 0600): what its Inbox sends to that door. */
const tokenFor = (from: Machine, to: Machine) =>
  (JSON.parse(readFileSync(join(from.w.dataDir, "inbox", "machines.json"), "utf8")).links as Json[]).find((l) => l.id === to.id)!.token as string;

describe("remote launch, on two real Inboxes linked both ways", () => {
  let stubs: string[] = [];
  let A: Machine;
  let B: Machine;

  beforeAll(async () => {
    stubs = stubBuiltHtml();
    const made: Machine[] = [];
    for (const name of ["MacBook", "Mini"]) {
      const w = createInboxWorld(`plannotator-remote-launch-${name.toLowerCase()}-`, name, "remote-launch");
      const calls = join(w.root, "tailscale-calls.txt");
      writeFileSync(join(w.bin, "tailscale"), `#!/bin/sh\necho "tailscale $*" >> '${calls}'\nexit 1\n`);
      chmodSync(join(w.bin, "tailscale"), 0o755);
      const fake = installFakeClaude({ bin: join(w.root, "fakes"), state: join(w.root, "fake-claude"), config: { trustCheck: true, workMs: 60_000, hold: true } });
      const m: Machine = { w, name, id: "", calls, fake, project: { id: "", root: "" }, untrusted: { id: "", root: "" } };
      // Launch on, and Plannotator's Claude Code plugin on in the sandbox's own agent home (launch needs its mod).
      mkdirSync(w.dataDir, { recursive: true });
      writeFileSync(join(w.dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
      mkdirSync(join(agentsHome(m), ".claude"), { recursive: true });
      writeFileSync(join(agentsHome(m), ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "plannotator@plannotator": true } }));
      start(m);
      m.id = (await getJson(m, "/api/inbox/health")).inbox_id as string;
      made.push(m);
    }
    [A, B] = made as [Machine, Machine];
    for (const m of made) {
      m.project = await projectOn(m, join(m.w.root, `${m.name.toLowerCase()}-billing-svc`));
      m.untrusted = await projectOn(m, join(m.w.root, `${m.name.toLowerCase()}-new-folder`));
      // The project folder is trusted on its own machine; the new folder is not.
      writeFileSync(join(agentsHome(m), ".claude.json"), JSON.stringify({ projects: { [m.project.root]: { hasTrustDialogAccepted: true } } }));
    }
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

  test("1. each machine says it takes launches from its linked machines", async () => {
    for (const m of [A, B]) expect((await getJson(m, "/api/inbox/health")).launch_from_machines).toBe(1);
  });

  const both = () =>
    [
      [A, B],
      [B, A],
    ] as const;

  test("2. a press in one machine's window starts Claude Code on the other, in that machine's folder; the thread lives there", async () => {
    for (const [here, there] of both()) {
      const before = here.fake.starts().length;
      const sent = await windowPost(here, `/api/inbox/m/${there.id}/messages`, launchBody(`k-start-${here.name}`, there.project.id));
      expect(sent.status).toBe(200);
      const answer = (await sent.json()) as Json;
      expect(answer.launch.state).toBe("starting");
      await waitFor(`--bg on ${there.name}`, async () => startsIn(there, there.project.root).length === 1);
      expect(here.fake.starts().length).toBe(before);
      // The thread is the other machine's: its own read names the launch and who started it, never a credential.
      const own = await getJson(there, `/api/inbox/threads/${answer.thread_id}`);
      const root = (own.thread.messages as Json[])[0]!;
      expect(root.launch.from).toEqual({ machine: here.id, name: here.name });
      expect(root.launch.folder).toBe(there.project.root);
      // And this machine reads its run line through the forward.
      await waitFor(`${here.name} reads the run line`, async () => ["starting", "working"].includes((await getJson(here, `/api/inbox/m/${there.id}/threads/${answer.thread_id}`)).run?.state));
    }
  }, 60_000);

  test("3. only a press in a window starts or stops an agent on another machine: never an agent's bare call", async () => {
    for (const [here, there] of both()) {
      const starts = there.fake.starts().length;
      const bare = await barePost(here, `/api/inbox/m/${there.id}/messages`, launchBody(`k-bare-${here.name}`, there.project.id));
      expect(bare.status).toBe(403);
      expect(((await bare.json()) as Json).code).toBe("window_only");
      expect(await outboxWaiting(here)).toBe(0);
      expect(((await getJson(here, "/api/inbox/outbox")).notices as Json[]).length).toBe(0);
      // At the other machine's door with this machine's own token, but without the window's mark: refused there too.
      const door = await fetch(`${base(there)}/api/inbox/device/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(here, there)}` },
        body: JSON.stringify(launchBody(`k-door-${here.name}`, there.project.id)),
      });
      expect(door.status).toBe(403);
      expect(((await door.json()) as Json).code).toBe("window_only");
      await Bun.sleep(500);
      expect(there.fake.starts().length).toBe(starts);

      // Stop: refused bare, done from the window.
      const thread = (await windowPost(here, `/api/inbox/m/${there.id}/messages`, launchBody(`k-stop-${here.name}`, there.project.id)).then((r) => r.json())) as Json;
      const own = await getJson(there, `/api/inbox/threads/${thread.thread_id}`);
      const launchId = (own.thread.messages as Json[])[0]!.launch.id as string;
      await waitFor("it started", async () => (await getJson(there, `/api/inbox/threads/${thread.thread_id}`)).thread.messages[0].launch.session_ref !== null);
      const stopsBefore = there.fake.calls().filter((c) => c.argv[0] === "stop").length;
      const bareStop = await barePost(here, `/api/inbox/m/${there.id}/launch/${launchId}/stop`, { idempotency_key: `k-bare-stop-${here.name}` });
      expect(bareStop.status).toBe(403);
      // At the door with this machine's token but no window mark: the other machine refuses the Stop itself.
      const doorStop = await fetch(`${base(there)}/api/inbox/device/launch/${launchId}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(here, there)}` },
        body: JSON.stringify({ idempotency_key: `k-door-stop-${here.name}` }),
      });
      expect(doorStop.status).toBe(403);
      expect(((await doorStop.json()) as Json).code).toBe("window_only");
      expect(there.fake.calls().filter((c) => c.argv[0] === "stop").length).toBe(stopsBefore);
      const stop = await windowPost(here, `/api/inbox/m/${there.id}/launch/${launchId}/stop`, { idempotency_key: `k-stop-press-${here.name}` });
      expect(stop.status).toBe(200);
      expect(((await stop.json()) as Json).run.state).toBe("stopped");
      expect(there.fake.calls().filter((c) => c.argv[0] === "stop").length).toBe(stopsBefore + 1);
      // Open in Terminal is this computer's: never a route through the forward.
      expect((await windowPost(here, `/api/inbox/m/${there.id}/launch/${launchId}/open`, { idempotency_key: `k-open-${here.name}` })).status).toBe(404);
    }
  }, 90_000);

  test("4. Trust and start across the link: the other machine's facts, one press trusts the folder there and starts", async () => {
    for (const [here, there] of both()) {
      const read = await getJson(here, `/api/inbox/m/${there.id}/sessions?trust_agent=claude-code&trust_project=${there.untrusted.id}`);
      const offer = (read.launch.agents as Json[])[0]!.untrusted?.[there.untrusted.id];
      expect(offer?.folder).toBe(there.untrusted.root);
      expect(Array.isArray(offer.facts)).toBe(true);
      const hereConfig = readFileSync(join(agentsHome(here), ".claude.json"), "utf8");
      const sent = await windowPost(here, `/api/inbox/m/${there.id}/messages`, launchBody(`k-trust-${here.name}`, there.untrusted.id, { trust: { folder: offer.folder, facts: offer.facts } }));
      expect(sent.status).toBe(200);
      const config = JSON.parse(readFileSync(join(agentsHome(there), ".claude.json"), "utf8")) as Json;
      expect(config.projects[there.untrusted.root].hasTrustDialogAccepted).toBe(true);
      // Only the other machine's Claude config: this one's is as it was.
      expect(readFileSync(join(agentsHome(here), ".claude.json"), "utf8")).toBe(hereConfig);
      await waitFor(`--bg in the new folder on ${there.name}`, async () => startsIn(there, there.untrusted.root).length === 1);
    }
  }, 60_000);

  test("5. a machine asleep: the launch waits, Cancel takes one back, the other starts once when it is back", async () => {
    for (const [here, there] of both()) {
      await stopInbox(there.w);
      await waitFor(`${here.name} sees ${there.name} asleep`, async () => (await stateOf(here, there)) === "offline", 30_000);
      const kept = await windowPost(here, `/api/inbox/m/${there.id}/messages`, launchBody(`k-held-${here.name}`, there.project.id));
      expect(kept.status).toBe(202);
      expect(((await kept.json()) as Json).outbox.state).toBe("queued");
      const dropped = await windowPost(here, `/api/inbox/m/${there.id}/messages`, launchBody(`k-cancel-${here.name}`, there.project.id));
      expect(dropped.status).toBe(202);
      const cancelled = await windowPost(here, `/api/inbox/outbox/k-cancel-${here.name}/cancel`, {});
      expect(cancelled.status).toBe(200);
      expect(((await cancelled.json()) as Json).entry.state).toBe("cancelled");
      expect(await outboxWaiting(here)).toBe(1);
      const before = startsIn(there, there.project.root).length;
      start(there);
      await waitFor(`${here.name} sees ${there.name} back`, async () => (await stateOf(here, there)) === "online", 30_000);
      await waitFor("the held launch started", async () => startsIn(there, there.project.root).length === before + 1, 30_000);
      await waitFor("nothing waits", async () => (await outboxWaiting(here)) === 0);
      await Bun.sleep(1_500);
      expect(startsIn(there, there.project.root).length).toBe(before + 1);
      const names = ((await getJson(there, "/api/inbox/threads")).sections as Json[]).flatMap((s) => s.threads as Json[]).map((t) => t.thread_name ?? t.subject);
      expect(names).toContain(`Refund retries k-held-${here.name}`);
      expect(names).not.toContain(`Refund retries k-cancel-${here.name}`);
      // Cancel is only for what never left.
      expect((await windowPost(here, `/api/inbox/outbox/k-held-${here.name}/cancel`, {})).status).toBe(409);
    }
  }, 180_000);

  test("6. readiness: signed out, with the SSH cause, and launch off, said with the other machine's name", async () => {
    for (const [here, there] of both()) {
      await waitFor(`${here.name} sees ${there.name} online`, async () => (await stateOf(here, there)) === "online", 30_000);
      const view = ((await getJson(here, "/api/inbox/machines")).machines as Json[]).find((x) => x.id === there.id)!;
      expect(view.launch).toBe(true);

      // Its Inbox started again (over SSH, for Mini) with Claude Code signed out: a fresh start has nothing kept.
      await stopInbox(there.w);
      there.fake.configure({ signedOut: true });
      start(there);
      await waitFor(`${here.name} sees ${there.name} back`, async () => (await stateOf(here, there)) === "online", 30_000);
      try {
        const block = (await getJson(here, `/api/inbox/m/${there.id}/sessions`)).launch as Json;
        expect(block.agents).toEqual([]);
        const notReady = (block.not_ready as Json[]).find((n) => n.agent === "claude-code")!;
        expect(notReady.code).toBe("signed_out");
        expect(notReady.over_ssh ?? false).toBe(there.name === "Mini");

        const starts = there.fake.starts().length;
        const refused = await windowPost(here, `/api/inbox/m/${there.id}/messages`, launchBody(`k-signed-out-${here.name}`, there.project.id));
        expect(refused.status).toBe(409);
        const answer = (await refused.json()) as Json;
        expect(answer.code).toBe("agent_unavailable");
        expect(answer.not_ready).toBe("signed_out");
        expect(answer.error).toContain(`isn't signed in on ${there.name}`);
        expect(answer.error).toContain(there.name === "Mini" ? "SSH" : "`claude`");
        expect(there.fake.starts().length).toBe(starts);
      } finally {
        there.fake.configure({ signedOut: false });
      }
      // Signed in now: the very next Send starts (a signed-out answer is never kept).
      const sent = await windowPost(here, `/api/inbox/m/${there.id}/messages`, launchBody(`k-signed-in-${here.name}`, there.project.id));
      expect(sent.status).toBe(200);

      // Launch off there: its health says so, which an older Inbox can't (no field).
      const config = join(there.w.dataDir, "config.json");
      const on = readFileSync(config, "utf8");
      writeFileSync(config, JSON.stringify({ inboxLaunch: { enabled: false } }));
      try {
        await waitFor(`${there.name} says launch is off`, async () => (await getJson(there, "/api/inbox/health")).launch_from_machines === 0);
      } finally {
        writeFileSync(config, on);
      }
      expect((await getJson(there, "/api/inbox/health")).launch_from_machines).toBe(1);
    }
  }, 90_000);
});
