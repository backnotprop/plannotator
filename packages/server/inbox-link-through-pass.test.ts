/**
 * Link two computers through a third, on the code's maker (Mini): the real door (inbox-devices.ts) and the real
 * coordinator (inbox-machines.ts) together, with loopback stand-ins for Studio (the broker, linked here) and Laptop
 * (the computer an introduction is for). PLANNOTATOR_TEST_SANDBOX lets the transport take loopback; nothing else runs.
 * What regresses: an introduction's code taking six digits; its device reaching more than the link it was made for
 * before that link is saved; its binding lost to a link-back that failed or to newer offers, so another computer
 * completes it; an unused one outliving its time or a restart; one left behind when the broker is unlinked; and, on the
 * computer that asked, a refused ask that leaves its row as if nothing happened.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxDevices, INTRODUCED_DEVICE_MS } from "./inbox-devices";
import { buildLinkOffer, InboxLinks, parseLinkOffer } from "./inbox-links";
import { createInboxMachines, type InboxMachines, type MachineFrame } from "./inbox-machines";

const STUDIO = "ibx_01K0000000000000000000000S";
const LAPTOP = "ibx_01K0000000000000000000000A";
const OTHER = "ibx_01K0000000000000000000000X";
const SESSION = "srv_session";
type Json = Record<string, any>;

let root: string;
let savedSandbox: string | undefined;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-link-through-pass-"));
  savedSandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (savedSandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
  else process.env.PLANNOTATOR_TEST_SANDBOX = savedSandbox;
});

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 150 && !ok(); i++) await Bun.sleep(20);
  expect(ok()).toBe(true);
};

/** A stand-in computer's door: `health` answers `id`; `answers` overrides a route. */
function standIn(id: string, answers: Record<string, (body: Json) => Response> = {}) {
  const seen: { route: string; body: Json }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const route = new URL(req.url).pathname.replace("/api/inbox/device/", "");
      const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Json) : {};
      seen.push({ route, body });
      if (answers[route]) return answers[route]!(body);
      if (route === "pair") return Response.json({ device: { id: "dev_far" }, token: `tok_${id}`, computer: { name: "Far" } }, { status: 201 });
      if (route === "health") return Response.json({ ok: true, inbox_id: id, machine_links: 1, version: "0.28.70" });
      if (route === "threads") return Response.json({ cursor: 0, sections: [], projects: [] });
      if (route === "unlink") return Response.json({ unlinked: true });
      if (route === "events") {
        const stream = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":0}\n\n`)) });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

/** Studio's list: it takes the mark and names Laptop as one of its links. */
const studioList = () =>
  Response.json({
    cursor: 1,
    sections: [],
    projects: [],
    marks: ["link-through"],
    link_through: { links: [{ id: LAPTOP, name: "Laptop", through: true, away: false }], pending: [] },
  });

/** Mini: its door and its coordinator, linked to Studio (a stand-in), on a clock the test moves. */
async function mini(studioAnswers: Record<string, (body: Json) => Response> = {}) {
  const dataDir = join(root, "mini");
  let clock = Date.now();
  const handed: string[] = [];
  let machines: InboxMachines | null = null;
  const makeDoor = () =>
    createInboxDevices({
      dataDir,
      serverSession: SESSION,
      port: () => 1,
      registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: SESSION, startedAt: "" }),
      readBody: async (req) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>,
      dispatch: async (req) => {
        handed.push(new URL(req.url).pathname);
        return Response.json({ ok: true });
      },
      now: () => new Date(clock),
      phones: false,
      tailscale: () => ({ status: 1, stdout: "", stderr: "not in this test" }),
      machines: () => machines,
    });
  const devices = makeDoor();
  const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
  const pair = async (body: Json): Promise<{ status: number; body: Json }> => {
    const answer = await devices.door(new Request(pairUrl, { method: "POST", body: JSON.stringify(body) }), pairUrl);
    return answer ? { status: answer.status, body: (await answer.json()) as Json } : { status: 404, body: {} };
  };
  const call = async (token: string, route: string, init: { body?: Json; window?: boolean; door?: ReturnType<typeof createInboxDevices> } = {}) => {
    const url = new URL(`http://127.0.0.1/api/inbox/device/${route}`);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.window ? { "X-Plannotator-Window": "1" } : {}) };
    const answer = await (init.door ?? devices).door(new Request(url, { method: init.body ? "POST" : "GET", headers, ...(init.body ? { body: JSON.stringify(init.body) } : {}) }), url);
    return answer ? { status: answer.status, body: (await answer.json().catch(() => ({}))) as Json } : { status: 404, body: {} };
  };

  // Studio's device on Mini's door, and Mini's link to Studio's (stand-in) door.
  const studioDoor = standIn(STUDIO, { threads: studioList, ...studioAnswers });
  const studio = await pair({ name: "Studio", platform: "machine", secret: devices.machineDoor.openMachineOffer().secret });
  InboxLinks.open(dataDir).put({ id: STUDIO, name: "Studio", token: `tok_${STUDIO}`, transport: { kind: "tailnet", url: studioDoor.url }, device_id: studio.body.device.id, linked_at: "2026-11-01T00:00:00Z" });
  machines = createInboxMachines({
    dataDir,
    serverSession: SESSION,
    computerName: () => "Mini",
    door: devices.machineDoor,
    readBody: async (req) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    holds: () => false,
    ownVersions: () => ({ current: "0.28.70", latest: null }),
    timings: { silenceMs: 60_000, backoffMinMs: 50, backoffMaxMs: 200, requestMs: 2000, sendMs: 2000 },
  });
  const m = machines;
  cleanups.push(() => m.stop());
  m.start();
  await until(() => m.machinesView().find((v) => v.id === STUDIO)?.marks.includes("link-through") === true);

  /** Studio asks Mini for a link code for `forId`, as its broker does. */
  let n = 0;
  const offerFor = async (forId: string) => call(studio.body.token, "link-through-offer", { window: true, body: { intro: `lt_${String(++n).padStart(32, "0")}`, for: { id: forId, name: "Laptop" } } });

  return {
    dataDir,
    devices,
    machines: m,
    studioToken: studio.body.token as string,
    studioDoor,
    handed,
    pair,
    call,
    offerFor,
    makeDoor,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

/** A link-back's code: the computer `id` at `url`. */
const backCode = (id: string, url: string) => ({ link: buildLinkOffer({ id, name: "Laptop", tailnet: url, secret: "back-secret", code: null }) });

describe("an introduction's pass on the code's maker", () => {
  test("its code is a secret only, and its device reaches only what completes the link until that link is saved", async () => {
    const m = await mini();
    const offered = await m.offerFor(LAPTOP);
    expect(offered.status).toBe(200);
    const code = parseLinkOffer(offered.body.link)!;
    expect(code.code).toBeNull();
    // Six digits never open it.
    expect((await m.pair({ name: "Laptop", platform: "machine", code: "000000" })).status).toBe(410);
    const paired = await m.pair({ name: "Laptop", platform: "machine", secret: code.secret });
    expect(paired.status).toBe(201);
    const token = paired.body.token as string;
    // Provisional: nothing of this Inbox's but the ordinary link's health read.
    expect((await m.call(token, "threads")).body.code).toBe("introduction_pending");
    expect((await m.call(token, "far-wake", { body: { idempotency_key: "k" } })).body.code).toBe("introduction_pending");
    expect((await m.call(token, "link-through-offer", { window: true, body: { intro: `lt_${"e".repeat(32)}`, for: { id: OTHER } } })).body.code).toBe("introduction_pending");
    expect(m.handed).toEqual([]);
    expect((await m.call(token, "health")).status).toBe(200);
    // The link-back from Laptop saves the link: an ordinary device from then on.
    const laptop = standIn(LAPTOP);
    expect((await m.call(token, "link-back", { body: backCode(LAPTOP, laptop.url) })).status).toBe(201);
    expect(m.devices.machineDoor.introduction(paired.body.device.id)).toBeNull();
    expect((await m.call(token, "threads")).status).toBe(200);
    expect(m.handed).toContain("/api/inbox/threads");
  });

  test("only the computer it was made for completes it: after a link-back that failed, and after newer offers", async () => {
    const m = await mini();
    const code = parseLinkOffer((await m.offerFor(LAPTOP)).body.link)!;
    const paired = await m.pair({ name: "Laptop", platform: "machine", secret: code.secret });
    const token = paired.body.token as string;
    // A link-back naming Laptop at an address where nothing answers fails, and the binding stays.
    const nothing = standIn(LAPTOP, { pair: () => Response.json({ code: "offer_expired" }, { status: 410 }) });
    expect((await m.call(token, "link-back", { body: backCode(LAPTOP, nothing.url) })).status).toBe(409);
    expect(m.devices.machineDoor.introduction(paired.body.device.id)).toEqual({ for: LAPTOP, by: STUDIO });
    // Newer offers push the introduction's out of the door's slots: the binding is on the device, so it holds.
    for (let i = 0; i < 9; i++) m.devices.machineDoor.openMachineOffer();
    const impostor = standIn(OTHER);
    const refused = await m.call(token, "link-back", { body: backCode(OTHER, impostor.url) });
    expect(refused).toMatchObject({ status: 403, body: { code: "introduction_mismatch" } });
    expect(impostor.seen).toEqual([]);
    expect(m.machines.machinesView().some((v) => v.id === OTHER)).toBe(false);
    // And its token is gone.
    expect((await m.call(token, "health")).body.code).toBe("device_revoked");
  });

  test("unused, it is revoked when its time is up, and by a restart", async () => {
    const m = await mini();
    const first = await m.pair({ name: "Laptop", platform: "machine", secret: parseLinkOffer((await m.offerFor(LAPTOP)).body.link)!.secret });
    expect((await m.call(first.body.token, "health")).status).toBe(200);
    m.tick(INTRODUCED_DEVICE_MS + 1);
    expect((await m.call(first.body.token, "health")).body.code).toBe("device_revoked");
    expect((await m.call(first.body.token, "link-back", { body: backCode(LAPTOP, standIn(LAPTOP).url) })).body.code).toBe("device_revoked");

    const second = await m.pair({ name: "Laptop", platform: "machine", secret: parseLinkOffer((await m.offerFor(LAPTOP)).body.link)!.secret });
    expect((await m.call(second.body.token, "health")).status).toBe(200);
    const restarted = m.makeDoor();
    expect((await m.call(second.body.token, "health", { door: restarted })).body.code).toBe("device_revoked");
  });

  test("when the computer that introduced it is unlinked, its open code and the devices still provisional from it go", async () => {
    const m = await mini();
    const open = parseLinkOffer((await m.offerFor(LAPTOP)).body.link)!;
    const used = await m.pair({ name: "Laptop", platform: "machine", secret: parseLinkOffer((await m.offerFor(LAPTOP)).body.link)!.secret });
    expect((await m.call(used.body.token, "health")).status).toBe(200);
    // Studio unlinks Mini.
    expect((await m.call(m.studioToken, "unlink", { body: {} })).status).toBe(200);
    expect((await m.call(used.body.token, "health")).body.code).toBe("device_revoked");
    expect([404, 410]).toContain((await m.pair({ name: "Laptop", platform: "machine", secret: open.secret })).status);
  });
});

describe("the computer that asked", () => {
  test("a refused ask says so on its row, in the refusal's words, with Link again", async () => {
    const m = await mini({ "link-through-ask": () => Response.json({ error: "That computer is not linked here.", code: "machine_not_linked" }, { status: 404 }) });
    const url = new URL("http://127.0.0.1/api/inbox/machines/link-through");
    const req = new Request(url, {
      method: "POST",
      headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1", "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: SESSION, via: STUDIO, with: LAPTOP }),
    });
    // What the window hears: the `machines` frame.
    const frames: MachineFrame[] = [];
    cleanups.push(m.machines.subscribe((frame) => frames.push(frame)));
    const asked = await m.machines.route(req, url, "local");
    expect(asked!.status).toBe(200);
    await until(() => m.studioDoor.seen.some((r) => r.route === "link-through-ask"));
    const row = () => {
      const last = frames.filter((frame) => frame.event === "machines").at(-1);
      const machines = last?.event === "machines" ? last.data.machines : [];
      return machines.find((v) => v.self)?.link_through?.through.find((r) => r.id === LAPTOP);
    };
    await until(() => row()?.status === "failed");
    expect(row()).toMatchObject({ status: "failed", why: "That computer is not linked here." });
  });
});
