/**
 * Swarm's Add an agent and Remove across linked computers, on two real Inboxes linked both ways in this process (the
 * owner, 2026-11-24: "Whatever I can do on one computer, I should be able to do across computers"). The swarm's thread
 * is Studio's (A); the agents added live on Laptop (B), each a connection that polls B's own bridge. Starts two
 * Inboxes: CI runs it.
 *
 * What this catches: Add an agent of a linked computer never woken there, woken more than once, or woken without the
 * join line; the added agent shown with no computer or with A's, or as joined before it joined; its far join (sent from
 * B, as `plannotator inbox swarm join` there sends it) not making it a member on A; Remove leaving it in the members,
 * the status or the ghost thread's "to everyone"; Undo not putting it back; B asleep: the add dropped instead of held,
 * or handed twice once B is back; anything draft-like (a reply draft, a compose draft) sent to B through A's outbox.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { composeInboxSkillsBlock, inboxBuiltinSkillContent } from "@plannotator/core/inbox-skills-compose";
import { INBOX_MESSAGE_SKILL_AUDIENCE } from "@plannotator/core/skill-reference-block";
import type { SkillCatalogEntry } from "@plannotator/core/skill-references-render";
import { SWARM_SKILL, swarmJoinLine } from "@plannotator/core/swarm-skill";
import { INBOX_BRIDGE_POLL_PATH, INBOX_TAGS_POLL_FIELD, type InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { waitFor } from "../../tests/helpers/inbox-world";
import { startInboxServer, type InboxServer } from "./inbox";

type Json = Record<string, any>;

const SWARM_REF = { name: SWARM_SKILL.name, root: INBOX_BUILTIN_SKILL_ROOT, humanOnly: true } as SkillCatalogEntry;
const SWARM_BLOCK = composeInboxSkillsBlock([SWARM_REF], new Map([[SWARM_SKILL.name, inboxBuiltinSkillContent(SWARM_REF, false)!]]), INBOX_MESSAGE_SKILL_AUDIENCE);
/** Studio's agent (the thread is to it), and Laptop's two. */
const CLAUDE = { host: "claude-code", session: "ses-studio-claude" };
const FAR_PI = { host: "pi", session: "ses-laptop-pi" };
const FAR_CODEX = { host: "codex", session: "ses-laptop-codex" };

/** A `tailscale` stand-in (as inbox-scheduled-linked.test.ts): nothing here runs the real one. */
function scriptedTailscale(): TailscaleRunner {
  return (args) => (args[1] === "status" ? { status: 0, stdout: "{}", stderr: "" } : { status: 1, stdout: "", stderr: "not here" });
}

/**
 * One live agent on `server()`: it polls that Inbox's bridge with tags on, as the mod does, counts every command it is
 * handed (a repeat of one it took is a second wake), and says each was delivered.
 */
class Poller {
  readonly handed = new Map<string, number>();
  readonly commands: InboxReplyCommand[] = [];
  /** Polls answered: once one is, the session is live there. */
  polls = 0;
  private stopped = true;
  private loop: Promise<void> = Promise.resolve();
  constructor(
    private readonly server: () => InboxServer,
    readonly agent: { host: string; session: string },
    private readonly project: string,
  ) {}
  private bridge(path: string, body: Json): Promise<Response> {
    const server = this.server();
    return fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) });
  }
  start(): void {
    this.stopped = false;
    this.loop = (async () => {
      while (!this.stopped) {
        try {
          const answer = await this.bridge(INBOX_BRIDGE_POLL_PATH, { ...this.agent, waitMs: 500, [INBOX_TAGS_POLL_FIELD]: true, project_path: this.project });
          const { commands = [] } = answer.ok ? ((await answer.json()) as { commands?: InboxReplyCommand[] }) : {};
          if (answer.ok) this.polls += 1;
          for (const command of commands) {
            this.handed.set(command.id, (this.handed.get(command.id) ?? 0) + 1);
            if (!this.commands.some((c) => c.id === command.id)) this.commands.push(command);
            await this.bridge("/api/inbox/bridge/event", { ...this.agent, type: "delivered", id: command.id });
          }
          if (!answer.ok) await Bun.sleep(200);
        } catch {
          await Bun.sleep(200);
        }
      }
    })();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
  /** The command it was handed for the person's message `id`, once it is. */
  async wake(id: string): Promise<InboxReplyCommand> {
    await waitFor(`${this.agent.session} handed ${id}`, () => this.commands.some((c) => c.id === id), 45_000);
    return this.commands.find((c) => c.id === id)!;
  }
}

describe("Swarm's Add an agent and Remove for an agent on a linked computer, two real Inboxes linked both ways", () => {
  const dirs: string[] = [];
  const envWas = { sandbox: process.env.PLANNOTATOR_TEST_SANDBOX, home: process.env.HOME, experimental: process.env.PLANNOTATOR_EXPERIMENTAL, browser: process.env.PLANNOTATOR_BROWSER };
  let root = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-swarm-add-linked-")));
    dirs.push(root);
    process.env.PLANNOTATOR_TEST_SANDBOX = root;
    process.env.HOME = join(root, "home");
    mkdirSync(process.env.HOME, { recursive: true });
    // Swarm on for both Inboxes (one process: one environment).
    process.env.PLANNOTATOR_EXPERIMENTAL = "swarm";
    process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  });
  afterAll(() => {
    for (const [name, was] of [
      ["PLANNOTATOR_TEST_SANDBOX", envWas.sandbox],
      ["HOME", envWas.home],
      ["PLANNOTATOR_EXPERIMENTAL", envWas.experimental],
      ["PLANNOTATOR_BROWSER", envWas.browser],
    ] as const) {
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const dataDir = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}");
    return dir;
  };
  const project = (name: string) => {
    const dir = join(root, "work", name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const start = (dir: string) => startInboxServer({ dataDir: dir, binaryPath: null, phones: false, tailscale: scriptedTailscale() });
  const at = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
  const get = async (server: InboxServer, path: string) => (await (await fetch(`${at(server)}${path}`)).json()) as Json;
  /** A press in the window: its Origin and this run's page session. */
  const press = async (server: InboxServer, path: string, body: Json) => {
    const response = await fetch(`${at(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: at(server), "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
    return { status: response.status, json: (await response.json()) as Json };
  };
  /** What `plannotator inbox swarm` sends on `server`, as `by`. */
  const swarmAsk = async (server: InboxServer, by: { host: string; session: string }, ask: Json) => {
    const response = await fetch(`${at(server)}/api/inbox/swarm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...ask, by }) });
    return { status: response.status, json: (await response.json()) as Json };
  };
  const members = async (server: InboxServer, thread: string) => ((await get(server, `/api/inbox/threads/${thread}/swarm`)).swarm.members as Json[]).map((m) => ({ session: m.session, joined: m.joined, machine_name: m.machine_name }));
  /** Every entry A's outbox ever held for `machine`, its latest line each (the file is append-only). */
  const outbox = (dir: string, machine: string): Json[] => {
    const file = join(dir, "inbox", "outbox", `${machine}.jsonl`);
    if (!existsSync(file)) return [];
    const byKey = new Map<string, Json>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as Json;
      if (typeof entry.key === "string") byKey.set(entry.key, entry);
    }
    return [...byKey.values()];
  };
  const wakesOf = (dir: string, machine: string, reply: string, session: string) => outbox(dir, machine).filter((e) => e.route === "far-wake" && e.body?.reply_id === reply && e.body?.session === session && !e.body?.replaces && !e.body?.withdrawn);

  test("an agent on Laptop is added, woken there once with the join line, joins, is removed and put back; Laptop asleep, the add waits and goes once", async () => {
    const dataA = dataDir("studio");
    const dataB = dataDir("laptop");
    const a = await start(dataA);
    let b = await start(dataB);
    const pollers: Poller[] = [];
    try {
      const offered = (await (await fetch(`${at(b)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(a)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(b), back: at(a) }) });
      expect(linked.status).toBe(201);
      const bId = (JSON.parse(readFileSync(join(dataA, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      await waitFor("Laptop takes tags across on Studio", async () => ((await get(a, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)?.marks?.includes("tag-across") === true, 30_000);
      const bName = ((await get(a, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)!.name as string;

      // Studio's agent, and the swarm thread the person started to it.
      const harbor = project("harbor");
      const claude = new Poller(() => a, CLAUDE, harbor);
      pollers.push(claude);
      claude.start();
      await waitFor("Studio's agent polled", () => claude.polls > 0, 15_000);
      const projectId = a.store.ensureProject({ name: "harbor", root: harbor }).id;
      const thread = a.store.startPersonThread({ project_id: projectId, body: `Add per-berth pricing for Charlie Dunn's marina. /swarm\n\n${SWARM_BLOCK}`, idempotency_key: "start-harbor", to: CLAUDE }).message.id;
      await waitFor("the swarm of the thread", () => a.store.swarmOf(thread)?.on === true);
      expect((await swarmAsk(a, CLAUDE, { action: "join", thread })).status).toBe(200);

      // Laptop's two agents, in its own project: Studio's `@` list offers them, with Laptop as their computer.
      const ledger = project("ledger");
      const pi = new Poller(() => b, FAR_PI, ledger);
      const codex = new Poller(() => b, FAR_CODEX, ledger);
      pollers.push(pi, codex);
      pi.start();
      codex.start();
      await waitFor(
        "Laptop's agents on Studio's @ list",
        async () => {
          const rows = ((await get(a, `/api/inbox/threads/${thread}/taggable`)).sessions ?? []) as Json[];
          return [FAR_PI, FAR_CODEX].every((agent) => rows.some((r) => r.session === agent.session && r.machine === bId && r.taggable === true));
        },
        30_000,
      );

      // 1. Add Laptop's Pi: not joined yet, on Laptop; woken there once, with the join line for this thread.
      const added = await press(a, `/api/inbox/threads/${thread}/swarm/add`, { ...FAR_PI, machine: bId, label: `Pi (${bName})`, idempotency_key: "add-pi" });
      expect(added.status).toBe(200);
      expect((added.json.swarm.members as Json[]).find((m) => m.session === FAR_PI.session)).toMatchObject({ joined: false, machine_name: bName });
      const addPi = a.store.threadMessageIds(thread).at(-1)!;
      const wake = await pi.wake(addPi);
      expect(wake.thread_id).toBe(thread);
      expect(wake.body).toContain(swarmJoinLine(thread));
      // Studio's agent is not handed it.
      expect(claude.handed.has(addPi)).toBe(false);
      // Delivered there, and recorded here; never handed again.
      await waitFor("Laptop's delivery recorded on Studio", () => !!a.store.message(addPi)?.tags?.find((t) => t.session === FAR_PI.session)?.delivery, 30_000);
      await Bun.sleep(2_000);
      expect(pi.handed.get(addPi)).toBe(1);
      expect(wakesOf(dataA, bId, addPi, FAR_PI.session)).toHaveLength(1);

      // 2. It joins from Laptop, as `plannotator inbox swarm join` there sends it: a member on Studio.
      const joined = await swarmAsk(b, FAR_PI, { action: "join", thread });
      expect(joined.status, JSON.stringify(joined.json)).toBe(200);
      await waitFor("Pi joined on Studio", async () => (await members(a, thread)).find((m) => m.session === FAR_PI.session)?.joined === true);
      expect((await members(a, thread)).find((m) => m.session === FAR_PI.session)).toMatchObject({ joined: true, machine_name: bName });

      // 3. Remove: out of the members, the status, and the person's ghost "to everyone".
      expect((await press(a, `/api/inbox/threads/${thread}/remove-agent`, { session: FAR_PI.session })).status).toBe(200);
      expect((await members(a, thread)).map((m) => m.session)).not.toContain(FAR_PI.session);
      const status = await swarmAsk(a, CLAUDE, { action: "status", thread });
      expect(status.status).toBe(200);
      expect(String(status.json.text)).not.toMatch(/\bPi\b/);
      const everyone = await press(a, `/api/inbox/threads/${thread}/swarm`, { say: { text: "Keep every price in cents." } });
      expect(everyone.status).toBe(200);
      expect(((everyone.json.ghost as Json[]).at(-1)!.tags as Json[]).map((t) => t.session)).toEqual([CLAUDE.session]);
      // Its computer cannot speak for it there.
      expect((await swarmAsk(b, FAR_PI, { action: "say", thread, text: "Still here?" })).json.code).toBe("removed_from_swarm");

      // Undo: back, joined, and in "to everyone" again.
      expect((await press(a, `/api/inbox/threads/${thread}/remove-agent/undo`, { session: FAR_PI.session })).status).toBe(200);
      expect((await members(a, thread)).find((m) => m.session === FAR_PI.session)).toMatchObject({ joined: true });
      const again = await press(a, `/api/inbox/threads/${thread}/swarm`, { say: { text: "Bob Tully signs off on Friday." } });
      expect(((again.json.ghost as Json[]).at(-1)!.tags as Json[]).map((t) => t.session).sort()).toEqual([CLAUDE.session, FAR_PI.session].sort());

      // 4. Laptop asleep: adding its Codex is held in Studio's outbox, nothing delivered; Laptop back, it goes once.
      await pi.stop();
      await codex.stop();
      b.stop();
      await waitFor("Laptop offline on Studio", async () => ((await get(a, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)?.state === "offline", 30_000);
      const held = await press(a, `/api/inbox/threads/${thread}/swarm/add`, { ...FAR_CODEX, machine: bId, label: `Codex (${bName})`, idempotency_key: "add-codex" });
      expect(held.status, JSON.stringify(held.json)).toBe(200);
      expect((held.json.swarm.members as Json[]).find((m) => m.session === FAR_CODEX.session)).toMatchObject({ joined: false, machine_name: bName });
      const addCodex = a.store.threadMessageIds(thread).at(-1)!;
      await waitFor("the add held for Laptop", () => wakesOf(dataA, bId, addCodex, FAR_CODEX.session).length === 1, 15_000);
      expect(wakesOf(dataA, bId, addCodex, FAR_CODEX.session)[0]!.state).not.toBe("delivered");
      expect(a.store.message(addCodex)!.tags?.find((t) => t.session === FAR_CODEX.session)?.delivery ?? null).toBeNull();

      b = await start(dataB);
      await waitFor("Laptop back on Studio", async () => ((await get(a, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)?.state === "online", 45_000);
      codex.start();
      const late = await codex.wake(addCodex);
      expect(late.body).toContain(swarmJoinLine(thread));
      await waitFor("the held add delivered", () => wakesOf(dataA, bId, addCodex, FAR_CODEX.session)[0]?.state === "delivered", 45_000);
      await Bun.sleep(2_000);
      expect(codex.handed.get(addCodex)).toBe(1);
      expect(wakesOf(dataA, bId, addCodex, FAR_CODEX.session)).toHaveLength(1);

      // Nothing draft-like ever went to Laptop: only the swarm's wakes and their deliveries.
      const routes = outbox(dataA, bId).map((e) => String(e.route));
      expect(routes.filter((route) => /draft/i.test(route))).toEqual([]);
      expect(outbox(dataA, bId).filter((e) => JSON.stringify(e.body ?? {}).includes('"draft'))).toEqual([]);
    } finally {
      for (const poller of pollers) await poller.stop().catch(() => {});
      a.stop();
      b.stop();
    }
  }, 240_000);
});
