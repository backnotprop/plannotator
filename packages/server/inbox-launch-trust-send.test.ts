/**
 * Trust and start through a real server: `POST /api/inbox/messages` with `to.launch.trust` saves the folder's trust and
 * starts the agent, so it belongs to the owner's window alone, and nothing is written unless all of it can go through.
 * The launch runs on the fake host (no `claude` is on the sandbox PATH). `offer.accepted` is the trust saved.
 */
import "../../tests/setup/sandbox-data-dir";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { INBOX_SCRATCH_PICK } from "@plannotator/core/inbox-scratch";
import type { InboxComposeLaunch } from "@plannotator/core/inbox-types";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { scriptedTailscale, TAILNET_MAGIC, TAILNET_OWNER } from "../../tests/helpers/scripted-tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_ASKER_RESTART_GRACE_MS } from "./inbox-sessions";
import type { LaunchTrustReading } from "./inbox-launch-host";

const GUEST = "guest@example.com";
const CLEAN: LaunchTrustReading = { warning: null, facts: [], warns: false };
const HOOKS: LaunchTrustReading = { warning: "This folder has 2 hooks that will run once you trust it.", facts: ["Runs 2 hooks"], warns: true };

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function setEnv(name: string, value: string | undefined) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

async function setup(config: Record<string, unknown> = { inboxLaunch: { enabled: true } }, sessionsNow?: () => number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-trust-send-")));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const folder = join(root, "billing");
  mkdirSync(dataDir);
  mkdirSync(folder);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscaleAllow: [GUEST], ...config }));
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", dataDir);
  setEnv("HOME", join(root, "home"));
  setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  // Pairing never reaches the real relay: a port nothing listens on.
  setEnv("PLANNOTATOR_RELAY_URL", "http://127.0.0.1:9");

  const fake = fakeLaunchHost();
  fake.faults.trusted = () => false;
  /** What the folder holds now, and the steps in order: each says how many threads there were when it ran. */
  const offer = { reading: HOOKS, reads: 0, accepted: 0, acceptFails: null as string | null, steps: [] as string[], duringLockWait: null as null | (() => Promise<unknown>) };
  const server: InboxServer = await startInboxServer({
    dataDir,
    binaryPath: null,
    version: "0.28.33",
    tailscale: scriptedTailscale(),
    publishTailnet: true,
    phones: true,
    launchHosts: () => [fake.host],
    ...(sessionsNow ? { sessionsNow } : {}),
  });
  restore.push(() => server.stop());
  const store = server.store;
  const project = store.ensureProject({ name: "billing", root: folder });
  const threads = () => store.listRows().length;
  fake.faults.offer = {
    folder,
    read() {
      offer.reads++;
      return offer.reading;
    },
    async accept(allowed) {
      offer.steps.push(`trust ${threads()}`);
      if (offer.acceptFails) throw new Error(offer.acceptFails);
      await offer.duringLockWait?.();
      if (allowed && !allowed()) return;
      offer.accepted++;
      fake.faults.trusted = () => true;
    },
  };
  const start = fake.host.start.bind(fake.host);
  fake.host.start = async (launch, input) => {
    offer.steps.push(`start ${threads()}`);
    return start(launch, input);
  };

  const base = `http://127.0.0.1:${server.port}`;
  const window = { Origin: base, "Content-Type": "application/json" };
  const key = (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })();
  const trust = (facts = HOOKS.facts) => ({ folder, facts });
  /** A Send as the window makes it. `extra` is laid over the body. */
  const sendBody = (launch: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    to: { launch: { agent: FAKE, ...launch } },
    body: "Tidy the readme.",
    idempotency_key: key(),
    serverSession: server.serverSession,
    ...extra,
  });
  const press = (extra: Record<string, unknown> = {}, headers: Record<string, string> = window, url = `${base}/api/inbox/messages`) =>
    fetch(url, { method: "POST", headers, body: JSON.stringify(sendBody({ project_id: project.id, trust: trust() }, extra)) });
  /** Nothing moved: nothing trusted, no thread, nothing started. */
  const nothingHappened = () => {
    expect(offer.accepted).toBe(0);
    expect(threads()).toBe(0);
    expect(fake.calls).toEqual([]);
  };
  /** Sends with the listener `tailscale serve` points at, as `login`. */
  const tailnet = (login: string) => ({
    url: `http://127.0.0.1:${server.tailscale.listenerPort()!}/api/inbox/messages`,
    headers: { Host: `${TAILNET_MAGIC}:${server.port}`, "Tailscale-User-Login": login, Origin: `https://${TAILNET_MAGIC}:${server.port}`, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
  });
  const sessions = async (query = "", headers: Record<string, string> = {}, path = `${base}/api/inbox/sessions`) =>
    ((await (await fetch(`${path}${query}`, { headers })).json()) as { launch?: InboxComposeLaunch }).launch;
  return { root, dataDir, folder, server, store, project, fake, offer, base, window, trust, sendBody, press, nothingHappened, tailnet, sessions, threads };
}

const codeOf = async (response: Response) => [response.status, ((await response.json()) as { code?: string }).code];

/** A paired phone's token, through the real pairing routes. */
async function pairPhone(world: Awaited<ReturnType<typeof setup>>) {
  const post = (path: string, body: unknown) => fetch(`${world.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const made = (await (await post("/api/inbox/pairing", {})).json()) as { offer: { code: string } };
  return ((await (await post("/api/inbox/device/pair", { code: made.offer.code, name: "iPhone", platform: "ios" })).json()) as { token: string }).token;
}

describe("who can press Trust and start", () => {
  test("the owner's window: the folder is trusted, then the thread is written, then the agent starts", async () => {
    const world = await setup();
    const sent = await world.press();
    expect(sent.status).toBe(200);
    expect(world.offer.steps).toEqual(["trust 0", "start 1"]);
    expect(world.threads()).toBe(1);
  });

  test("the owner's own login over the tailnet is the owner's window", async () => {
    const world = await setup();
    const { url, headers } = world.tailnet(TAILNET_OWNER);
    expect((await world.press({}, headers, url)).status).toBe(200);
    expect(world.offer.accepted).toBe(1);
  });

  test("an agent's bare local call, with this run's serverSession, is refused: it is no window", async () => {
    const world = await setup();
    expect(await codeOf(await world.press({}, { "Content-Type": "application/json" }))).toEqual([403, "window_only"]);
    world.nothingHappened();
  });

  test("a caller holding a bearer token gets no further", async () => {
    const world = await setup();
    const token = await pairPhone(world);
    expect(await codeOf(await world.press({}, { "Content-Type": "application/json", Authorization: `Bearer ${token}` }))).toEqual([403, "window_only"]);
    world.nothingHappened();
  });

  test("a window with no serverSession is refused, and a tab from another run is told it is stale", async () => {
    const world = await setup();
    expect(await codeOf(await world.press({ serverSession: undefined }))).toEqual([403, "window_only"]);
    const stale = await world.press({ serverSession: "older-run" });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).not.toBe("trust_warning_changed");
    world.nothingHappened();
  });

  test("an MCP caller has no way to name a launch: send_message refuses the field, and writes nothing", async () => {
    const world = await setup();
    const response = await fetch(`${world.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "send_message",
          arguments: { body: "Hi", project_path: world.folder, agent_session: "ses_a", agent_host: "claude-code", agent_name: "Claude Code", to: { launch: { agent: FAKE, project_id: world.project.id, trust: world.trust() } } },
        },
      }),
    });
    const text = await response.text();
    expect(text).toContain("isError");
    world.nothingHappened();
  });

  test("a guest on the allow list is refused, with the window's own headers", async () => {
    const world = await setup();
    const { url, headers } = world.tailnet(GUEST);
    expect(await codeOf(await world.press({}, headers, url))).toEqual([403, "owner_only"]);
    world.nothingHappened();
  });

  test("another site's page is refused, however it dresses", async () => {
    const world = await setup();
    for (const headers of [
      { "Content-Type": "application/json", Origin: "https://evil.example" },
      { "Content-Type": "application/json", Origin: world.base, "Sec-Fetch-Site": "cross-site" },
      { "Content-Type": "application/json", Origin: world.base, "Sec-Fetch-Site": "same-site" },
      { "Content-Type": "application/json", Origin: "http://127.0.0.1:9" },
      { "Content-Type": "application/json", Origin: "not a url" },
    ]) {
      expect(await codeOf(await world.press({}, headers))).toEqual([403, "cross_origin"]);
    }
    world.nothingHappened();
  });

  test("the device door: a paired phone is no window, with or without the window's Origin", async () => {
    const world = await setup();
    const token = await pairPhone(world);
    const door = `${world.base}/api/inbox/device/messages`;
    const bearer = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    expect((await codeOf(await world.press({ serverSession: undefined }, bearer, door)))[0]).toBe(403);
    expect((await codeOf(await world.press({}, { ...bearer, Origin: world.base }, door)))[0]).toBe(403);
    world.nothingHappened();
  });

  test("a `trust` that holds nothing is still a press: `null` from an agent never slips past the gate as a plain launch", async () => {
    const world = await setup();
    const body = world.sendBody({ project_id: world.project.id, trust: null });
    const response = await fetch(`${world.base}/api/inbox/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(await codeOf(response)).toEqual([403, "window_only"]);
    world.nothingHappened();
  });

  test("the window sending junk for `trust` is told so", async () => {
    const world = await setup();
    for (const trust of [null, "yes", { folder: "/x" }, { folder: 1, facts: [] }, { folder: "/x", facts: [1] }]) {
      expect(await codeOf(await world.press({ to: { launch: { agent: FAKE, project_id: world.project.id, trust } } }))).toEqual([422, "validation_error"]);
    }
    world.nothingHappened();
  });

  test("launch off: the same press is the route's plain refusal", async () => {
    const world = await setup({ inboxLaunch: { enabled: false } });
    expect(await codeOf(await world.press())).toEqual([404, "launch_off"]);
    world.nothingHappened();
  });
});

describe("the order, and what stops it", () => {
  test("the folder changed since the reading: 409 `trust_warning_changed`, nothing trusted, nothing sent", async () => {
    const world = await setup();
    world.offer.reading = { warning: "w", facts: ["Runs 3 hooks"], warns: true };
    expect(await codeOf(await world.press())).toEqual([409, "trust_warning_changed"]);
    world.nothingHappened();
    // The window read it again; the press on the new reading goes through.
    expect((await world.press({ to: { launch: { agent: FAKE, project_id: world.project.id, trust: world.trust(["Runs 3 hooks"]) } } })).status).toBe(200);
    expect(world.offer.accepted).toBe(1);
  });

  test("a press made before any reading arrived, on a folder with facts, is a changed folder", async () => {
    const world = await setup();
    expect(await codeOf(await world.press({ to: { launch: { agent: FAKE, project_id: world.project.id, trust: world.trust([]) } } }))).toEqual([409, "trust_warning_changed"]);
    world.nothingHappened();
  });

  test("the reading was of another folder: the facts alone do not carry it", async () => {
    const world = await setup();
    expect(await codeOf(await world.press({ to: { launch: { agent: FAKE, project_id: world.project.id, trust: { folder: "/somewhere/else", facts: HOOKS.facts } } } }))).toEqual([409, "trust_warning_changed"]);
    world.nothingHappened();
  });

  test("`trust_failed`: no thread, no start, and the same words can be sent again", async () => {
    const world = await setup();
    world.offer.acceptFails = "Claude Code's config is locked.";
    expect((await codeOf(await world.press()))[1]).toBe("trust_failed");
    world.nothingHappened();
    world.offer.acceptFails = null;
    expect((await world.press()).status).toBe(200);
    expect(world.offer.steps.at(-1)).toBe("start 1");
  });

  test("a thread name that is taken refuses before the folder is trusted", async () => {
    const world = await setup();
    world.fake.faults.trusted = () => true;
    expect((await world.press({ thread_name: "Readme" })).status).toBe(200);
    world.fake.faults.trusted = () => false;
    world.offer.accepted = 0;
    const before = world.fake.calls.length;
    expect(await codeOf(await world.press({ thread_name: "Readme" }))).toEqual([409, "thread_name_taken"]);
    expect(world.offer.accepted).toBe(0);
    expect(world.fake.calls.length).toBe(before);
  });

  test("a thread name taken during the lock wait saves nothing: the folder is not trusted for a thread that was refused", async () => {
    const world = await setup();
    world.offer.duringLockWait = async () => {
      world.offer.duringLockWait = null;
      world.fake.faults.trusted = () => true;
      expect((await world.press({ thread_name: "Readme" })).status).toBe(200);
      world.fake.faults.trusted = () => false;
    };
    expect(await codeOf(await world.press({ thread_name: "Readme" }))).toEqual([409, "thread_name_taken"]);
    expect(world.offer.accepted).toBe(0);
    expect(world.threads()).toBe(1);
  });

  test("the trust saved is the offer the press was compared with: one made after it is never used", async () => {
    const world = await setup();
    const compared = world.fake.faults.offer!;
    let offers = 0;
    let later = 0;
    world.fake.host.trustOffer = () => (offers++ === 0 ? compared : { ...compared, accept: async () => void later++ });
    expect((await world.press()).status).toBe(200);
    expect(world.offer.accepted).toBe(1);
    expect(later).toBe(0);
  });

  test("an upload that isn't there refuses before the folder is trusted", async () => {
    const world = await setup();
    const refused = await world.press({ uploads: ["upl_missing"] });
    expect(refused.ok).toBe(false);
    world.nothingHappened();
  });

  test("a folder trusted since (another window, or the agent's own prompt): it just starts, and the reading no longer matters", async () => {
    const world = await setup();
    world.fake.faults.trusted = () => true;
    world.offer.reading = { warning: "w", facts: ["Different now"], warns: true };
    expect((await world.press()).status).toBe(200);
    expect(world.offer.steps).toEqual(["start 1"]);
  });

  test("a folder that lost its offer saves nothing and sends nothing", async () => {
    const world = await setup();
    world.fake.faults.offer = null;
    expect((await codeOf(await world.press()))[1]).toBe("trust_failed");
    world.nothingHappened();
  });

  test("the same press replayed (a retry over a dropped answer) trusts and starts once", async () => {
    const world = await setup();
    const idempotency_key = "00000000-0000-4000-8000-00000000abcd";
    expect((await world.press({ idempotency_key })).status).toBe(200);
    expect((await world.press({ idempotency_key })).status).toBe(200);
    expect(world.offer.accepted).toBe(1);
    expect(world.threads()).toBe(1);
    expect(world.offer.steps.filter((step) => step.startsWith("start"))).toHaveLength(1);
  });

  test("a press on a plain launch with no reading is no press: it starts and meets the refusal, the thread's Trust folder is the fallback", async () => {
    const world = await setup();
    world.fake.faults.untrusted = true;
    const body = world.sendBody({ project_id: world.project.id });
    const sent = (await (await fetch(`${world.base}/api/inbox/messages`, { method: "POST", headers: world.window, body: JSON.stringify(body) })).json()) as { message: { thread_id: string } };
    expect(world.offer.accepted).toBe(0);
    expect(world.threads()).toBe(1);
    const run = async () => ((await (await fetch(`${world.base}/api/inbox/threads/${sent.message.thread_id}`)).json()) as { run: { untrusted?: boolean; trust?: unknown } }).run;
    for (let i = 0; i < 50 && !(await run()).untrusted; i++) await Bun.sleep(10);
    expect(await run()).toMatchObject({ untrusted: true, trust: { warning: HOOKS.warning } });
  });
});

describe("a scratch folder", () => {
  const scratchDirs = (world: Awaited<ReturnType<typeof setup>>) => {
    const dir = join(world.dataDir, "scratch");
    return existsSync(dir) ? readdirSync(dir) : [];
  };
  const pressScratch = (world: Awaited<ReturnType<typeof setup>>, facts = HOOKS.facts) =>
    fetch(`${world.base}/api/inbox/messages`, { method: "POST", headers: world.window, body: JSON.stringify(world.sendBody({ scratch: true, trust: { folder: world.folder, facts } })) });

  test("the press trusts, writes and starts in a new folder", async () => {
    const world = await setup();
    expect((await pressScratch(world)).status).toBe(200);
    expect(world.offer.steps).toEqual(["trust 0", "start 1"]);
    expect(scratchDirs(world)).toHaveLength(1);
  });

  test("a changed reading leaves no folder behind", async () => {
    const world = await setup();
    expect(await codeOf(await pressScratch(world, ["Something else"]))).toEqual([409, "trust_warning_changed"]);
    expect(scratchDirs(world)).toEqual([]);
    world.nothingHappened();
  });

  test("a Send refused for its files removes the folder it made and its project: two presses with one upload, and one with an upload that isn't there", async () => {
    const world = await setup();
    const uploaded = (await (await fetch(`${world.base}/api/inbox/uploads?name=notes.md&serverSession=${world.server.serverSession}`, { method: "POST", headers: { Origin: world.base }, body: "# Notes\n" })).json()) as { upload: { upload_id: string } };
    const projects = world.store.listProjects().length;
    const scratchPress = (uploads: string[]) =>
      fetch(`${world.base}/api/inbox/messages`, { method: "POST", headers: world.window, body: JSON.stringify(world.sendBody({ scratch: true, trust: { folder: world.folder, facts: HOOKS.facts } }, { uploads })) });

    const refusedAlone = await codeOf(await scratchPress(["upl_missing"]));
    expect(refusedAlone[0]).toBe(404);
    expect(scratchDirs(world)).toEqual([]);
    world.nothingHappened();
    expect(world.store.listProjects().length).toBe(projects);

    const answers = await Promise.all([scratchPress([uploaded.upload.upload_id]), scratchPress([uploaded.upload.upload_id])]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 404]);
    const refused = answers.find((answer) => answer.status === 404)!;
    expect(((await refused.json()) as { code?: string }).code).toBe("upload_not_found");
    // One thread, one folder, one project: the refused press left neither of its own behind.
    expect(world.threads()).toBe(1);
    expect(scratchDirs(world)).toHaveLength(1);
    expect(world.store.listProjects().length).toBe(projects + 1);
    expect(world.offer.steps.filter((step) => step.startsWith("start"))).toHaveLength(1);
  });

  test("`trust_failed` removes the folder it made, and its project", async () => {
    const world = await setup();
    world.offer.acceptFails = "locked";
    const projects = world.store.listProjects().length;
    expect((await codeOf(await pressScratch(world)))[1]).toBe("trust_failed");
    expect(scratchDirs(world)).toEqual([]);
    expect(world.store.listProjects().length).toBe(projects);
    world.nothingHappened();
  });

  test("the guard does not depend on the form: a scratch press from a bare call is refused", async () => {
    const world = await setup();
    const response = await fetch(`${world.base}/api/inbox/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(world.sendBody({ scratch: true, trust: { folder: world.folder, facts: [] } })) });
    expect(await codeOf(response)).toEqual([403, "window_only"]);
    expect(scratchDirs(world)).toEqual([]);
    world.nothingHappened();
  });
});

describe("what `GET /api/inbox/sessions` offers", () => {
  const untrustedOf = (block: InboxComposeLaunch | undefined) => block?.agents.find((a) => a.agent === FAKE)?.untrusted;

  test("the 5 s refresh reads no folder's files; the picked folder alone is read", async () => {
    const world = await setup();
    const other = join(world.root, "other");
    mkdirSync(other);
    const second = world.store.ensureProject({ name: "other", root: other });

    const plain = untrustedOf(await world.sessions());
    expect(world.offer.reads).toBe(0);
    expect(plain?.[world.project.id]).toEqual({ folder: world.folder });
    expect(plain?.[second.id]).toBeDefined();

    const picked = untrustedOf(await world.sessions(`?trust_agent=${FAKE}&trust_project=${world.project.id}`));
    expect(world.offer.reads).toBe(1);
    expect(picked?.[world.project.id]).toEqual({ folder: world.folder, facts: HOOKS.facts, warns: true });
    expect(picked?.[second.id]).toEqual({ folder: world.folder });
  });

  test("a clean folder is offered with no facts, a trusted one not at all", async () => {
    const world = await setup();
    world.offer.reading = CLEAN;
    const pick = `?trust_agent=${FAKE}&trust_project=${world.project.id}`;
    expect(untrustedOf(await world.sessions(pick))?.[world.project.id]).toEqual({ folder: world.folder, facts: [], warns: false });
    world.fake.faults.trusted = () => true;
    expect(untrustedOf(await world.sessions(pick))).toEqual({});
  });

  test("the scratch root has its own key, and its pick reads it", async () => {
    const world = await setup();
    const scratch = untrustedOf(await world.sessions(`?trust_agent=${FAKE}&trust_project=${INBOX_SCRATCH_PICK}`));
    expect(scratch?.[INBOX_SCRATCH_PICK]).toEqual({ folder: world.folder, facts: HOOKS.facts, warns: true });
  });

  test("a folder with no offer (home, `/`, above home) is not listed: compose keeps plain Send", async () => {
    const world = await setup();
    world.fake.faults.offer = null;
    expect(untrustedOf(await world.sessions(`?trust_agent=${FAKE}&trust_project=${world.project.id}`))).toEqual({});
  });

  test("nobody but the owner's window sees an offer, and asking for a pick reads nothing", async () => {
    const world = await setup();
    const pick = `?trust_agent=${FAKE}&trust_project=${world.project.id}`;
    const { headers } = world.tailnet(GUEST);
    const listener = `http://127.0.0.1:${world.server.tailscale.listenerPort()!}/api/inbox/sessions`;
    expect(untrustedOf(await world.sessions(pick, headers, listener))).toBeUndefined();

    const token = await pairPhone(world);
    expect(untrustedOf(await world.sessions(pick, { Authorization: `Bearer ${token}` }, `${world.base}/api/inbox/device/sessions`))).toBeUndefined();

    expect(untrustedOf(await world.sessions(pick, { Origin: "https://evil.example" }))).toBeUndefined();
    expect(world.offer.reads).toBe(0);

    const owner = world.tailnet(TAILNET_OWNER).headers;
    expect(untrustedOf(await world.sessions(pick, owner, listener))?.[world.project.id]?.facts).toEqual(HOOKS.facts);
  });

  test("launch off: the block is not there at all", async () => {
    const world = await setup({ inboxLaunch: { enabled: false } });
    expect(await world.sessions(`?trust_agent=${FAKE}&trust_project=${world.project.id}`)).toBeUndefined();
    expect(world.offer.reads).toBe(0);
  });
});

describe("a launched session and a reply going elsewhere", () => {
  /** A launch through the server, the sessions' clock in hand; `C` polls. */
  async function launched(start?: { ok: false; code: string; text: string }) {
    const clock = { now: Date.now() };
    const world = await setup({ inboxLaunch: { enabled: true } }, () => clock.now);
    world.fake.faults.trusted = () => true;
    if (start) world.fake.host.start = (async () => start) as typeof world.fake.host.start;
    expect((await world.press({ to: { launch: { agent: FAKE, project_id: world.project.id } } })).status).toBe(200);
    const rootId = world.store.listRows()[0]!.thread_id;
    const until = async (check: () => boolean) => {
      for (let tries = 0; tries < 200 && !check(); tries++) await Bun.sleep(10);
      expect(check()).toBe(true);
    };
    await until(() => (start ? !!world.store.message(rootId)!.launch!.error : !!world.store.message(rootId)!.launch!.session_ref));
    const base = world.base;
    const poll = (session: string) =>
      fetch(`${base}${INBOX_BRIDGE_POLL_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${world.server.token}` },
        body: JSON.stringify({ session, host: "claude-code", waitMs: 0, project_path: world.folder, started_at: clock.now }),
      });
    const post = (path: string, body: Record<string, unknown>) =>
      fetch(`${base}${path}`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: world.server.serverSession, ...body }) });
    const to = (session: string) => ({ to: { host: "claude-code", session } });
    const reply = async (id: string, key: string, extra: Record<string, unknown> = {}) => {
      const response = await post(`/api/inbox/messages/${id}/reply`, { idempotency_key: key, words: "Words.", ...extra });
      expect(response.status).toBe(200);
      return ((await response.json()) as { reply: { id: string; took_over?: boolean } }).reply;
    };
    const move = async (id: string, session: string) => {
      const response = await post(`/api/inbox/messages/${id}/to`, to(session));
      const body = (await response.json()) as { message?: { took_over?: boolean }; code?: string };
      return { status: response.status, tookOver: body.message?.took_over, code: body.code };
    };
    const L = world.store.message(rootId)!.to!.session;
    const says = (body: string, session: string, replyTo: string, key: string) =>
      world.store.sendMessage({ project_id: world.project.id, author: { kind: "agent", host: session === L ? FAKE : "claude-code", session, name: "Agent" }, body, reply_to: replyTo, wakes: true, idempotency_key: key }).message;
    const pastGrace = () => (clock.now += INBOX_ASKER_RESTART_GRACE_MS + 1);
    const gone = () => world.store.settleLaunch(rootId, { error: { code: "missing", text: "Not installed.", at: new Date(clock.now).toISOString() } });
    return { ...world, rootId, L, poll, to, reply, move, says, pastGrace, gone, owner: () => world.store.threadOwner(rootId)?.session };
  }

  test("stopped: a reply aimed elsewhere leaves it the thread, a reply waiting on it stays; once its launch is deleted, the reply takes the thread", async () => {
    const w = await launched();
    const asked = w.says("Done.", w.L, w.rootId, "a1");
    // Addressed to it while it still polled; it stops after.
    await w.poll(w.L);
    const addressed = await w.reply(asked.id, "k0", w.to(w.L));
    await w.fake.host.stop("f1");
    w.pastGrace();
    await w.poll("ses_c");
    expect((await w.reply(asked.id, "k1", w.to("ses_c"))).took_over).toBeUndefined();
    expect(w.owner()).toBe(w.L);
    // The stopped launched session is there: a reply addressed to it is not moved off it.
    expect(await w.move(addressed.id, "ses_c")).toMatchObject({ status: 422, code: "session_still_live" });

    const saved = await w.reply(asked.id, "k3");
    expect(await w.move(saved.id, "ses_c")).toMatchObject({ status: 422, code: "session_still_live" });

    const launchId = w.store.message(w.rootId)!.launch!.id;
    await fetch(`${w.base}/api/inbox/launch/${launchId}/delete`, { method: "POST", headers: { Origin: w.base, "Content-Type": "application/json" }, body: "{}" });
    for (let tries = 0; tries < 200 && !w.store.message(w.rootId)!.launch!.deleted_at; tries++) await Bun.sleep(10);
    expect((await w.reply(asked.id, "k4", w.to("ses_c"))).took_over).toBe(true);
    expect(w.owner()).toBe("ses_c");
  });

  test("gone: a plain reply moves at once, before the 60 s, and the thread goes with it", async () => {
    const w = await launched();
    const asked = w.says("Done.", w.L, w.rootId, "a1");
    await w.poll("ses_c");
    const saved = await w.reply(asked.id, "k1");
    w.gone();
    expect(await w.move(saved.id, "ses_c")).toMatchObject({ status: 200, tookOver: true });
    expect(w.owner()).toBe("ses_c");
  });

  test("gone: a reply addressed to it moves at once too", async () => {
    const w = await launched();
    const asked = w.says("Done.", w.L, w.rootId, "a1");
    await w.poll(w.L);
    await w.poll("ses_c");
    const addressed = await w.reply(asked.id, "k1", w.to(w.L));
    w.gone();
    expect(await w.move(addressed.id, "ses_c")).toMatchObject({ status: 200, tookOver: true });
    expect(w.owner()).toBe("ses_c");
  });

  test("the row on a real server: a stopped launched session has not ended, until its launch is deleted", async () => {
    const w = await launched();
    w.says("Done.", w.L, w.rootId, "a1");
    await w.fake.host.stop("f1");
    w.pastGrace();
    const mark = async () => {
      const list = (await (await fetch(`${w.base}/api/inbox/threads`)).json()) as { sections: { threads: { thread_id: string; session_ended?: boolean }[] }[] };
      return list.sections.flatMap((section) => section.threads).find((row) => row.thread_id === w.rootId)!.session_ended;
    };
    expect(await mark()).toBeUndefined();
    await fetch(`${w.base}/api/inbox/launch/${w.store.message(w.rootId)!.launch!.id}/delete`, { method: "POST", headers: { Origin: w.base, "Content-Type": "application/json" }, body: "{}" });
    for (let tries = 0; tries < 200 && !w.store.message(w.rootId)!.launch!.deleted_at; tries++) await Bun.sleep(10);
    expect(await mark()).toBe(true);
  });

  test("a start that failed, the root moved to a live session: that session keeps the thread, and a reply to it stays on it", async () => {
    const w = await launched({ ok: false, code: "missing", text: "Not installed." });
    await w.poll("ses_c");
    await w.poll("ses_d");
    expect(await w.move(w.rootId, "ses_c")).toMatchObject({ status: 200 });
    const answer = w.says("On it.", "ses_c", w.rootId, "a1");
    await w.poll("ses_c");
    await w.poll("ses_d");
    expect((await w.reply(answer.id, "k1", w.to("ses_d"))).took_over).toBeUndefined();
    expect(w.owner()).toBe("ses_c");
    const stamped = await w.reply(answer.id, "k2", w.to("ses_c"));
    expect(await w.move(stamped.id, "ses_d")).toMatchObject({ status: 422, code: "session_still_live" });
  });

  test("a root moved to a session that then ended: that session reads as ended, whatever the launch's line says", async () => {
    const w = await launched();
    w.store.settleLaunch(w.rootId, { error: { code: "failed", text: "It failed.", at: new Date().toISOString() } });
    w.pastGrace();
    await w.poll("ses_c");
    expect(await w.move(w.rootId, "ses_c")).toMatchObject({ status: 200 });
    w.store.settleLaunch(w.rootId, { error: null });
    const answer = w.says("On it.", "ses_c", w.rootId, "a1");
    w.pastGrace();
    await w.poll("ses_d");
    expect((await w.reply(answer.id, "k1", w.to("ses_d"))).took_over).toBe(true);
    expect(w.owner()).toBe("ses_d");
  });
});
