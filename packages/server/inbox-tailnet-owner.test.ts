/**
 * The owner's phone over the tailnet works like the computer for an approved
 * list (approval "inbox-tailnet-owner"): every rule asks "owner or local", not
 * "did this come over the tailnet?". The tables run each route as each caller
 * against a real Inbox with its real gate: the window's port, the tailnet
 * listener as the owner, and the tailnet listener as a login config.json
 * `inboxTailscaleAllow` added.
 *
 * What regresses: a guest reaching a route the owner opened (above all
 * Settings → Agents, which writes real agent files); anything of the agent
 * surface, the door or the exposure switches opening with them; the login
 * header counting anywhere but the tailnet listener; a linked machine or a
 * phone's door gaining a route; a failed update taking the Inbox with it.
 *
 * Scripted `tailscale`, `gh`, agents and installer; the real ones never run.
 * Temp PLANNOTATOR_DATA_DIR and a temp agent home only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { doorRouteNames } from "./inbox-devices";
import { doorWriteKind } from "./inbox-outbox";

type Json = Record<string, any>;

const MAGIC = "macbook-pro.tail0000.ts.net";
const OWNER = "ramos@example.com";
const GUEST = "guest@example.com";
const KEY = "sk-phone-0123456789abcd";

type Caller = "local" | "owner" | "guest";

const roots: string[] = [];
const fakes: FakeAgents[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const fake of fakes.splice(0)) fake.remove();
  for (const restore of restoreEnv.splice(0).reverse()) restore();
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

function fakeTailscale(options: { tagged?: boolean } = {}) {
  const serve = new Map<number, string>();
  const calls: string[][] = [];
  const run: TailscaleRunner = (args) => {
    calls.push(args);
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") {
      const tagged = options.tagged === true;
      return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42, ...(tagged ? { Tags: ["tag:server"] } : {}) }, User: { "42": { ID: 42, LoginName: tagged ? "tagged-devices" : OWNER } } }));
    }
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      return ok(
        JSON.stringify({
          TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
          Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
        }),
      );
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n`);
  };
  return { run, serve, calls };
}

interface WorldOptions {
  config?: Json;
  phones?: boolean;
  tagged?: boolean;
  launchInstaller?: () => void;
  board?: boolean;
}

/** A real Inbox with an update known, one agent on PATH, a card with a PR, and every outside process scripted. */
async function world(options: WorldOptions = {}) {
  const fake = createFakeAgents("plannotator-tailnet-owner-");
  fakes.push(fake);
  fake.install("codex");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-tailnet-owner-data-")));
  roots.push(root);
  const dataDir = root;
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  for (const name of ["PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_URL_HOST", "PLANNOTATOR_AUTO_UPDATE", "PLANNOTATOR_UPDATE_CHECK"]) setEnv(name, undefined);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: true, inboxTailscaleAllow: [GUEST], updateCheck: false, ...options.config }));
  writeFileSync(join(dataDir, "update-state.json"), JSON.stringify({ latestRelease: { tag: "0.28.12", fetchedAt: Date.now() } }));
  const ts = fakeTailscale({ tagged: options.tagged });
  const launches: unknown[] = [];
  const opened: unknown[] = [];
  const forgeCalls: string[][] = [];
  const inbox = await startInboxServer({
    dataDir,
    binaryPath: null,
    version: "0.28.10",
    phones: options.phones ?? true,
    tailscale: ts.run,
    ...(options.board === undefined ? {} : { board: options.board }),
    agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: fake.env }),
    updates: {
      fetchRelease: async () => ({ ok: true, release: { tag: "v0.28.12" } }),
      fetchReleasePage: async () => ({ ok: true, release: { tag: "v0.28.12" } }),
      isManaged: () => true,
      listSessions: () => [],
      launchInstaller: (launch) => {
        options.launchInstaller?.();
        launches.push(launch);
      },
    },
    refRunner: async (cli, args) => {
      forgeCalls.push(args);
      if (args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "me", active: true, state: "success" }] } }), stderr: "", exitCode: 0 };
      return { stdout: JSON.stringify({ data: { repository: { n12: { __typename: "PullRequest", state: "MERGED", isDraft: false, title: "vite 8" } } } }), stderr: "", exitCode: 0 };
    },
    openInLauncher: {
      platform: "mac",
      apps: () => [],
      reveal: async (path) => (opened.push(path), { ok: true }),
      openWithApp: async (_app, path) => (opened.push(path), { ok: true }),
      openWithSystemDefault: async (path) => (opened.push(path), { ok: true }),
    },
  });
  servers.push(inbox);
  const project = inbox.store.ensureProject({ name: "web", root: join(root, "web") });
  const card = inbox.store.createCard({ project_id: project.id, by: { kind: "agent", host: "codex", session: "s", name: "Codex" }, title: "vite 8", prs: ["acme/widgets#12"], refs: [] }).card;
  const config = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Json;
  return { inbox, dataDir, fake, ts, launches, opened, forgeCalls, card, config };
}
type World = Awaited<ReturnType<typeof world>>;

interface Call {
  method?: string;
  path: string;
  body?: Json;
  headers?: Record<string, string>;
}

/** What a browser on the owner's or a guest's phone sends through serve, or this computer's window sends its own port. */
function call(w: World, caller: Caller, request: Call, over: Record<string, string> = {}): Promise<Response> {
  const method = request.method ?? (request.body ? "POST" : "GET");
  const init = { method, redirect: "manual" as const, body: request.body ? JSON.stringify({ serverSession: w.inbox.serverSession, ...request.body }) : undefined };
  const json = request.body ? { "Content-Type": "application/json" } : {};
  if (caller === "local") {
    const origin = `http://127.0.0.1:${w.inbox.port}`;
    return fetch(`${origin}${request.path}`, { ...init, headers: { Origin: origin, ...json, ...request.headers, ...over } });
  }
  const listener = w.inbox.tailscale.listenerPort();
  if (listener === null) throw new Error("not published");
  return fetch(`http://127.0.0.1:${listener}${request.path}`, {
    ...init,
    headers: {
      Host: `${MAGIC}:${w.inbox.port}`,
      Origin: `https://${MAGIC}:${w.inbox.port}`,
      "Sec-Fetch-Site": "same-origin",
      "X-Forwarded-Proto": "https",
      "Tailscale-User-Login": caller === "owner" ? OWNER : GUEST,
      ...json,
      ...request.headers,
      ...over,
    },
  });
}

const answerOf = async (response: Response): Promise<[number, string | undefined]> => {
  const text = await response.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as Json).code;
  } catch {
    code = undefined;
  }
  return [response.status, code];
};

const CALLERS: readonly Caller[] = ["local", "owner", "guest"];
const REFUSED: [number, string] = [403, "local_only"];

/** Every route the approval opened: what it answers each caller, and whether it did its work. */
const OPENED: { name: string; call: (w: World) => Call; ok?: number; guest?: [number, string]; did?: (w: World) => boolean; world?: WorldOptions }[] = [
  { name: "GET update: the facts", call: () => ({ path: "/api/inbox/update" }) },
  { name: "POST update: Update now", call: () => ({ path: "/api/inbox/update", body: {} }), did: (w) => w.launches.length === 1 },
  { name: "POST update/snooze", call: () => ({ path: "/api/inbox/update/snooze", body: {} }), did: (w) => JSON.parse(readFileSync(join(w.dataDir, "update-state.json"), "utf8")).snooze !== undefined },
  { name: "POST update/check: Check now", call: () => ({ path: "/api/inbox/update/check", body: {} }) },
  { name: "settings update_check", call: () => ({ path: "/api/inbox/settings", body: { update_check: true } }), did: (w) => w.config().updateCheck === true },
  { name: "settings auto_update", call: () => ({ path: "/api/inbox/settings", body: { auto_update: true } }), did: (w) => w.config().autoUpdate === true },
  { name: "GET agents", call: () => ({ path: "/api/inbox/agents" }) },
  { name: "POST agents: reach", call: () => ({ path: "/api/inbox/agents", body: { agent: "codex", reach: true } }), did: (w) => w.fake.calls().some((c) => c.args.join(" ").startsWith("mcp add")) },
  { name: "POST agents/notes: the note in a real file", call: () => ({ path: "/api/inbox/agents/notes", body: { add: ["codex"] } }), did: (w) => existsSync(join(w.fake.env.CODEX_HOME ?? join(w.fake.home, ".codex"), "AGENTS.md")) },
  { name: "POST agents/seen", call: () => ({ path: "/api/inbox/agents/seen", body: {} }) },
  { name: "settings board", call: () => ({ path: "/api/inbox/settings", body: { board: { on: true } } }), did: (w) => w.config().inboxBoard === true },
  { name: "settings prompts: the reminder", call: () => ({ path: "/api/inbox/settings", body: { prompts: { inbox: { reminder: "Mine." } } } }), did: (w) => w.config().prompts?.inbox?.reminder === "Mine." },
  { name: "POST cards/marks", call: (w) => ({ path: "/api/inbox/cards/marks", body: { cards: [w.card.id] } }), did: (w) => w.forgeCalls.some((args) => args[0] === "api"), world: { board: true } },
  { name: "POST voice/key", call: () => ({ path: "/api/inbox/voice/key", body: { key: KEY } }), guest: [403, "owner_only"], did: (w) => existsSync(join(w.dataDir, "inbox", "voice-key")) },
  { name: "settings cookie_host", call: () => ({ path: "/api/inbox/settings", body: { cookie_host: true } }), did: (w) => w.config().urlHost === "plannotator.localhost" },
];

/** What the same three callers get on routes that stay closed over the tailnet. `local: null`: not asked (it would stop the Inbox, or open a listener). */
const BLOCKED: { name: string; call: (w: World) => Call; local: [number, string?] | null | "answers" }[] = [
  { name: "POST /mcp", call: () => ({ path: "/mcp", body: {} }), local: null },
  { name: "GET /mcp", call: () => ({ path: "/mcp" }), local: null },
  { name: "control/stop", call: (w) => ({ method: "POST", path: "/api/inbox/control/stop", headers: { Authorization: `Bearer ${w.inbox.token}` } }), local: null },
  { name: "control/tailscale", call: (w) => ({ method: "POST", path: "/api/inbox/control/tailscale", headers: { Authorization: `Bearer ${w.inbox.token}` } }), local: null },
  { name: "control/connect", call: (w) => ({ method: "POST", path: "/api/inbox/control/connect", headers: { Authorization: `Bearer ${w.inbox.token}` } }), local: null },
  { name: "control/machines", call: (w) => ({ path: "/api/inbox/control/machines", headers: { Authorization: `Bearer ${w.inbox.token}` } }), local: [403, "origin_not_allowed"] },
  { name: "bridge/poll", call: (w) => ({ method: "POST", path: "/api/inbox/bridge/poll", headers: { Authorization: `Bearer ${w.inbox.token}` } }), local: [403, "origin_not_allowed"] },
  { name: "bridge/event", call: (w) => ({ method: "POST", path: "/api/inbox/bridge/event", headers: { Authorization: `Bearer ${w.inbox.token}` } }), local: [403, "origin_not_allowed"] },
  { name: "the door: health", call: () => ({ path: "/api/inbox/device/health" }), local: [403, "origin_not_allowed"] },
  { name: "the door: pair", call: () => ({ path: "/api/inbox/device/pair", body: { code: "000000" } }), local: null },
  { name: "POST pairing", call: () => ({ path: "/api/inbox/pairing", body: {} }), local: "answers" },
  { name: "GET pairing", call: () => ({ path: "/api/inbox/pairing" }), local: "answers" },
  { name: "GET pairing/checks", call: () => ({ path: "/api/inbox/pairing/checks" }), local: null },
  { name: "POST tailnet: the door's switch", call: () => ({ path: "/api/inbox/tailnet", body: { on: true } }), local: null },
  { name: "POST lan: the Wi-Fi's switch", call: () => ({ path: "/api/inbox/lan", body: { on: true } }), local: null },
  { name: "settings tailscale on", call: () => ({ path: "/api/inbox/settings", body: { tailscale: { on: true } } }), local: null },
  { name: "POST open-in: launching an app", call: () => ({ path: "/api/inbox/open-in", body: { attachment_id: "att_x", app_id: "vscode" } }), local: null },
  { name: "GET open-in/apps", call: () => ({ path: "/api/inbox/open-in/apps" }), local: "answers" },
  { name: "POST machines/offer", call: () => ({ path: "/api/inbox/machines/offer", body: {} }), local: null },
  { name: "POST machines/link", call: () => ({ path: "/api/inbox/machines/link", body: { link: "plannotator://link" } }), local: null },
];

describe("what the approval opened, by caller", () => {
  for (const row of OPENED) {
    for (const caller of CALLERS) {
      test(`${row.name}: ${caller}`, async () => {
        const w = await world(row.world);
        const [status, code] = await answerOf(await call(w, caller, row.call(w)));
        if (caller === "guest") {
          expect([status, code]).toEqual(row.guest ?? REFUSED);
          expect(w.launches).toEqual([]);
          if (row.did) expect(row.did(w)).toBe(false);
        } else {
          expect([status, code]).toEqual([row.ok ?? 200, undefined]);
          if (row.did) expect(row.did(w)).toBe(true);
        }
      });
    }
  }

  test("the settings model tells the page who it is, and shows a guest nothing of what closed", async () => {
    const w = await world();
    const read = async (caller: Caller) => (await (await call(w, caller, { path: "/api/inbox/settings" })).json()) as Json;
    const local = await read("local");
    const owner = await read("owner");
    const guest = await read("guest");
    expect([local.via, local.guest]).toEqual(["local", false]);
    expect([owner.via, owner.guest]).toEqual(["tailnet", false]);
    expect([guest.via, guest.guest]).toEqual(["tailnet", true]);
    expect(owner.cookie_host).toEqual(local.cookie_host);
    expect(guest.cookie_host).toBeUndefined();
    expect(owner.prompts.reminder.editable).toBe(true);
    expect(guest.prompts.reminder.editable).toBe(false);
    expect(owner.updates).toEqual(local.updates);

    // Nor in the answer to a save a guest may make.
    const saves = async (caller: Caller) => (await (await call(w, caller, { path: "/api/inbox/settings", body: { text_size: 14 } })).json()) as Json;
    expect((await saves("owner")).cookie_host).toBeDefined();
    expect((await saves("owner")).prompts.reminder.editable).toBe(true);
    expect((await saves("guest")).cookie_host).toBeUndefined();
    expect((await saves("guest")).prompts.reminder.editable).toBe(false);
  });

  test("auto_update set from the phone is the setting the computer reads", async () => {
    const w = await world();
    expect((await call(w, "owner", { path: "/api/inbox/settings", body: { auto_update: true } })).status).toBe(200);
    const local = (await (await call(w, "local", { path: "/api/inbox/settings" })).json()) as Json;
    expect(local.updates.auto_update.on).toBe(true);
    expect(w.config().autoUpdate).toBe(true);
  });

  test("the rest of a guest's day is as it was: the routes it had still answer it", async () => {
    const w = await world();
    expect((await call(w, "guest", { path: "/api/inbox/threads" })).status).toBe(200);
    expect((await call(w, "guest", { path: "/api/inbox/settings", body: { text_size: 13 } })).status).toBe(200);
    expect(await answerOf(await call(w, "guest", { path: "/api/inbox/feedback", body: { message: "hi" } }))).toEqual([403, "owner_only"]);
  });

  test("a mixed save from a guest writes nothing: one closed part refuses all of it", async () => {
    const w = await world();
    const answer = await call(w, "guest", { path: "/api/inbox/settings", body: { text_size: 15, auto_update: true } });
    expect(await answerOf(answer)).toEqual(REFUSED);
    expect(w.config().inboxTextSize).toBeUndefined();
    expect(w.config().autoUpdate).toBeUndefined();
  });

  test("a machine Tailscale names no owner for (a tagged device) has no owner over the tailnet: an allowed login stays a guest", async () => {
    const w = await world({ tagged: true });
    expect(w.inbox.tailscale.state().owner).toBeNull();
    expect(await answerOf(await call(w, "guest", { path: "/api/inbox/agents" }))).toEqual(REFUSED);
    expect(((await (await call(w, "guest", { path: "/api/inbox/settings" })).json()) as Json).guest).toBe(true);
  });
});

describe("what stays refused for everyone over the tailnet", () => {
  for (const row of BLOCKED) {
    test(row.name, async () => {
      const w = await world();
      const mappings = [...w.ts.serve];
      for (const caller of ["owner", "guest"] as const) expect([caller, ...(await answerOf(await call(w, caller, row.call(w))))]).toEqual([caller, ...REFUSED]);
      expect(w.opened).toEqual([]);
      expect([...w.ts.serve]).toEqual(mappings);
      // The Inbox is still running: no stop, no restart.
      expect((await fetch(`http://127.0.0.1:${w.inbox.port}/api/inbox/health`)).status).toBe(200);
      if (row.local === "answers") expect((await call(w, "local", row.call(w))).status).toBeLessThan(300);
      else if (row.local) expect(await answerOf(await call(w, "local", row.call(w)))).toEqual(row.local as [number, string]);
    });
  }

  test("turning the tailnet switch off stays as it was; turning it on does not", async () => {
    const w = await world();
    expect(await answerOf(await call(w, "owner", { path: "/api/inbox/settings", body: { tailscale: { on: true } } }))).toEqual(REFUSED);
    expect(w.config().inboxTailscale).toBe(true);
  });
});

describe("another site never rides the owner's login", () => {
  const WRITES = OPENED.map((row) => row.call).filter((make) => make({ card: { id: "crd_x" } } as World).body !== undefined);
  const forged: [string, Record<string, string>, [number, string]][] = [
    ["another site's Origin", { Origin: "https://evil.example", "Sec-Fetch-Site": "" }, [403, "cross_origin"]],
    ["Origin: null (a sandboxed frame)", { Origin: "null", "Sec-Fetch-Site": "" }, [403, "cross_origin"]],
    ["Sec-Fetch-Site: cross-site, whatever Origin says", { "Sec-Fetch-Site": "cross-site" }, [403, "cross_site"]],
    ["Sec-Fetch-Site: same-site (another machine of the tailnet)", { "Sec-Fetch-Site": "same-site" }, [403, "cross_site"]],
  ];

  test("every opened POST, each forged four ways: refused, and nothing happened", async () => {
    const w = await world();
    const before = readFileSync(join(w.dataDir, "config.json"), "utf8");
    for (const make of WRITES) {
      const request = make(w);
      for (const [name, headers, refused] of forged) {
        expect([request.path, name, ...(await answerOf(await call(w, "owner", request, headers)))]).toEqual([request.path, name, ...refused]);
      }
    }
    expect(w.launches).toEqual([]);
    expect(readFileSync(join(w.dataDir, "config.json"), "utf8")).toBe(before);
    expect(existsSync(join(w.dataDir, "inbox", "voice-key"))).toBe(false);
    expect(w.forgeCalls).toEqual([]);
  });

  test("a read of the agents from another site is refused before the route", async () => {
    const w = await world();
    expect(await answerOf(await call(w, "owner", { path: "/api/inbox/agents" }, { "Sec-Fetch-Site": "cross-site" }))).toEqual([403, "cross_site"]);
    expect(await answerOf(await call(w, "owner", { path: "/api/inbox/update" }, { "Sec-Fetch-Site": "same-site" }))).toEqual([403, "cross_site"]);
  });

  test("a stale tab is 409 before anything happens, on every opened POST", async () => {
    const w = await world();
    for (const make of WRITES) {
      const request = make(w);
      const stale = { ...request, body: { ...request.body, serverSession: "0".repeat(32) } };
      const listener = w.inbox.tailscale.listenerPort()!;
      const response = await fetch(`http://127.0.0.1:${listener}${stale.path}`, {
        method: "POST",
        headers: { Host: `${MAGIC}:${w.inbox.port}`, Origin: `https://${MAGIC}:${w.inbox.port}`, "X-Forwarded-Proto": "https", "Tailscale-User-Login": OWNER, "Content-Type": "application/json" },
        body: JSON.stringify(stale.body),
      });
      expect([stale.path, response.status]).toEqual([stale.path, 409]);
    }
    expect(w.launches).toEqual([]);
  });

  test("no Origin and no Sec-Fetch-Site (a program, no browser): the login still decides, as the door the listener is", async () => {
    const w = await world();
    const listener = w.inbox.tailscale.listenerPort()!;
    const bare = (login: string | null, path = "/api/inbox/settings") =>
      fetch(`http://127.0.0.1:${listener}${path}`, {
        method: "POST",
        headers: { Host: `${MAGIC}:${w.inbox.port}`, "Content-Type": "application/json", ...(login ? { "Tailscale-User-Login": login } : {}) },
        body: JSON.stringify({ auto_update: true }),
      });
    // A tagged device (no login), then a login nobody allowed: the listener refuses both.
    expect(await answerOf(await bare(null))).toEqual([403, "tailnet_identity_required"]);
    expect(await answerOf(await bare("stranger@example.com"))).toEqual([403, "tailnet_identity_refused"]);
    expect(await answerOf(await bare(GUEST))).toEqual(REFUSED);
    expect(w.config().autoUpdate).toBeUndefined();
    // The owner's own program: no browser to protect, Tailscale says who it is.
    expect((await bare(OWNER)).status).toBe(200);
    expect(w.config().autoUpdate).toBe(true);
  });
});

describe("the login header counts only on the tailnet listener", () => {
  test("forged on the window's own port: refused on every opened route, and nothing happened", async () => {
    const w = await world();
    const before = readFileSync(join(w.dataDir, "config.json"), "utf8");
    for (const row of OPENED) {
      const answer = await call(w, "local", row.call(w), { "Tailscale-User-Login": OWNER });
      expect([row.name, ...(await answerOf(answer))]).toEqual([row.name, ...REFUSED]);
    }
    expect(w.launches).toEqual([]);
    expect(readFileSync(join(w.dataDir, "config.json"), "utf8")).toBe(before);
    expect(existsSync(join(w.dataDir, "inbox", "voice-key"))).toBe(false);
  });

  test("forged at a phone's door: nothing of the list is a door route, the door listener serves nothing else, and the header never reaches the window", async () => {
    const w = await world();
    const base = `http://127.0.0.1:${w.inbox.port}`;
    const post = (path: string, body: Json = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/api/inbox/tailnet", { on: true })).status).toBe(200);
    const offer = (await (await post("/api/inbox/pairing")).json()) as Json;
    const paired = await post("/api/inbox/device/pair", { code: offer.offer.code, name: "iPhone", platform: "ios" });
    expect(paired.status).toBe(201);
    const token = ((await paired.json()) as Json).token as string;
    const doorPort = (JSON.parse(readFileSync(join(w.dataDir, "inbox", "inbox.json"), "utf8")) as Json).tailnet.door_port as number;
    const door = (path: string, method = "GET", body?: Json) =>
      fetch(`http://127.0.0.1:${doorPort}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Tailscale-User-Login": OWNER, Host: `${MAGIC}:8443`, "X-Forwarded-Proto": "https", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    // A door route answers, so the header was not sent on: the window's port would have refused it.
    expect((await door("/api/inbox/device/threads")).status).toBe(200);
    for (const route of ["update", "update/check", "update/snooze", "agents", "agents/notes", "agents/seen", "settings", "cards/marks", "voice/key"]) {
      expect([route, ...(await answerOf(await door(`/api/inbox/device/${route}`)))]).toEqual([route, 404, "device_route_not_found"]);
      const posted = await door(`/api/inbox/device/${route}`, "POST", { idempotency_key: `k-${route}`, key: KEY, auto_update: true });
      expect([route, ...(await answerOf(posted))]).toEqual([route, 404, "device_route_not_found"]);
    }
    // The window's paths on the door's listener: not a door route, whoever it claims to be.
    for (const path of ["/api/inbox/update", "/api/inbox/agents", "/api/inbox/settings", "/api/inbox/voice/key"]) {
      expect([path, ...(await answerOf(await door(path)))]).toEqual([path, 404, "device_route_not_found"]);
      expect([path, ...(await answerOf(await door(path, "POST", {})))]).toEqual([path, 404, "device_route_not_found"]);
    }
    expect(w.launches).toEqual([]);
    expect(existsSync(join(w.dataDir, "inbox", "voice-key"))).toBe(false);
  });
});

describe("a linked machine gains none of it", () => {
  test("no opened route is a door route or a forwardable write", () => {
    const names = doorRouteNames().join("\n");
    for (const word of ["update", "agents", "settings", "cards", "voice"]) expect(names).not.toContain(` ${word}`);
    for (const route of ["update", "update/check", "update/snooze", "agents", "agents/notes", "agents/seen", "settings", "cards/marks", "voice/key"]) {
      expect([route, doorWriteKind(route)]).toEqual([route, null]);
    }
  });

  test("the owner over the tailnet, through the forward to a linked machine: refused there, nothing runs there", async () => {
    setEnv("PLANNOTATOR_TEST_SANDBOX", process.env.PLANNOTATOR_TEST_SANDBOX ?? "1");
    const peer = await world({ phones: false });
    const peerConfig = readFileSync(join(peer.dataDir, "config.json"), "utf8");
    const w = await world({ phones: false });
    const bearer = (inbox: InboxServer) => ({ Authorization: `Bearer ${inbox.token}`, "Content-Type": "application/json" });
    const offer = (await (
      await fetch(`http://127.0.0.1:${peer.inbox.port}/api/inbox/control/machines/offer`, { method: "POST", headers: bearer(peer.inbox), body: "{}" })
    ).json()) as Json;
    const linked = await fetch(`http://127.0.0.1:${w.inbox.port}/api/inbox/control/machines/link`, {
      method: "POST",
      headers: bearer(w.inbox),
      body: JSON.stringify({ link: offer.link, address: `http://127.0.0.1:${peer.inbox.port}`, one_way: true }),
    });
    expect(linked.status).toBe(201);
    const machine = ((await linked.json()) as Json).machine.id as string;
    await waitOnline(w, machine);

    for (const route of ["update", "update/check", "update/snooze", "agents", "agents/notes", "settings", "cards/marks", "voice/key"]) {
      const path = `/api/inbox/m/${machine}/${route}`;
      expect([route, ...(await answerOf(await call(w, "owner", { path })))]).toEqual([route, 404, "device_route_not_found"]);
      expect([route, ...(await answerOf(await call(w, "owner", { path, body: { key: KEY, auto_update: true, reach: true, agent: "codex" } })))]).toEqual([route, 404, "not_found"]);
    }
    expect(peer.launches).toEqual([]);
    expect(peer.fake.calls().filter((c) => c.args[0] === "mcp")).toEqual([]);
    expect(existsSync(join(peer.dataDir, "inbox", "voice-key"))).toBe(false);
    expect(readFileSync(join(peer.dataDir, "config.json"), "utf8")).toBe(peerConfig);
  });
});

async function waitOnline(w: World, machine: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const machines = ((await (await fetch(`http://127.0.0.1:${w.inbox.port}/api/inbox/machines`)).json()) as Json).machines as Json[];
    if (machines.find((m) => m.id === machine)?.state === "online") return;
    await Bun.sleep(25);
  }
  throw new Error("the linked machine did not come online");
}

describe("updating from the phone", () => {
  test("the install script fails: the old Inbox keeps running, the phone reads why and can try again", async () => {
    const w = await world();
    expect((await call(w, "owner", { path: "/api/inbox/update", body: {} })).status).toBe(200);
    expect(w.launches).toHaveLength(1);

    // The installer's wrapper exited non-zero: what it leaves on disk, and the lock gone.
    writeFileSync(join(w.dataDir, "update-result.json"), JSON.stringify({ version: "v0.28.12", exitCode: 1 }));
    rmSync(join(w.dataDir, "update.lock"), { force: true });

    const details = async () => (await (await call(w, "owner", { path: "/api/inbox/update/check", body: {} })).json()) as Json;
    let seen = await details();
    for (let i = 0; i < 100 && seen.update?.state !== "failed"; i++) {
      await Bun.sleep(25);
      seen = await details();
    }
    expect(seen.update).toMatchObject({ state: "failed", version: "0.28.12", current: "0.28.10" });
    expect(seen.failure).toMatchObject({ exit_code: 1 });
    expect(seen.log).toContain("update.log");
    expect(seen.command).toContain("install");

    // Still this Inbox, on the old version, over the tailnet, and it offers Try Again.
    const health = (await (await call(w, "owner", { path: "/api/inbox/health" })).json()) as Json;
    expect([health.version, health.serverSession]).toEqual(["0.28.10", w.inbox.serverSession]);
    expect((await call(w, "owner", { path: "/api/inbox/update", body: {} })).status).toBe(200);
    expect(w.launches).toHaveLength(2);
  });

  test("the install script cannot start: a plain refusal, and the Inbox runs on", async () => {
    const w = await world({
      launchInstaller: () => {
        throw new Error("spawn failed");
      },
    });
    const answer = await call(w, "owner", { path: "/api/inbox/update", body: {} });
    const body = (await answer.json()) as Json;
    expect([answer.status, body.code]).toEqual([409, "update_launch_failed"]);
    expect(body.error).toContain("could not be started");
    expect((await call(w, "owner", { path: "/api/inbox/health" })).status).toBe(200);
  });

  test("a second press while the first runs: refused, one install", async () => {
    const w = await world();
    expect((await call(w, "owner", { path: "/api/inbox/update", body: {} })).status).toBe(200);
    expect(await answerOf(await call(w, "local", { path: "/api/inbox/update", body: {} }))).toEqual([409, "update_locked"]);
    expect(w.launches).toHaveLength(1);
  });
});
