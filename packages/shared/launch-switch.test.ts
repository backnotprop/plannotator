/**
 * The launch switch (packages/shared/launch-switch.ts), with a fake fetch and a temp data folder: never the network.
 * What regresses: a document the strict parser should refuse turning the dialog on (another host, http, a port, user
 * info, a hash, another query key, a lookalike host, bad dates, a long span, an oversized file); any request going out
 * while an opt-out is set or in a dev build; the reader asking more than every 15 minutes, following a redirect, or
 * dropping the last good copy on a failure; a kept "on" copy outliving its endsAt; a claim waiting on the site; the
 * dialog showing twice on one computer.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCH_SWITCH_AHEAD_REFRESH_MS,
  LAUNCH_SWITCH_FILE,
  LAUNCH_SWITCH_MAX_BYTES,
  LAUNCH_SWITCH_OFF_REFRESH_MS,
  LAUNCH_SWITCH_REFRESH_MS,
  configLaunchShownStore,
  LAUNCH_SWITCH_URL,
  createLaunchSwitch,
  fetchLaunchDoc,
  launchActive,
  launchSwitchEndpoint,
  launchSwitchRoute,
  parseLaunchDoc,
  readLaunchKept,
  type LaunchShownRecord,
  type LaunchShownStore,
} from "./launch-switch";

const GOOD_URL = "https://www.producthunt.com/posts/plannotator";
const START = "2026-12-02T08:00:00Z";
const END = "2026-12-03T08:00:00Z";
const T_START = Date.parse(START);
const T_END = Date.parse(END);
const on = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, campaign: "product-hunt-2026", on: true, url: GOOD_URL, startsAt: START, endsAt: END, ...over });

/** A temp data folder (under the OS temp dir). */
const dataDir = () => mkdtempSync(join(tmpdir(), "launch-switch-"));

function memoryShown(): LaunchShownStore & { all: Record<string, LaunchShownRecord> } {
  const all: Record<string, LaunchShownRecord> = {};
  return {
    all,
    read: (campaign) => all[campaign],
    write: (campaign, record) => ((all[campaign] = { ...record }), true),
    stamp: (campaign, record) => (all[campaign]?.shownAt || all[campaign]?.answer ? "taken" : ((all[campaign] = { ...record }), "stamped")),
  };
}

/** A fetch that counts its calls and answers `body` (or never, or fails). */
function fakeFetch(answer: { status?: number; body?: string; hang?: boolean; fail?: boolean; headers?: Record<string, string> } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (answer.fail) throw new Error("offline");
    if (answer.hang) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return new Response(answer.body ?? on(), { status: answer.status ?? 200, headers: answer.headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("parseLaunchDoc: the site file's shape", () => {
  test("the off file and a full on file parse", () => {
    expect(parseLaunchDoc('{"v":1,"campaign":"product-hunt-2026","on":false}')).toEqual({ v: 1, campaign: "product-hunt-2026", on: false });
    expect(parseLaunchDoc(on())).toEqual({ v: 1, campaign: "product-hunt-2026", on: true, url: GOOD_URL, startsAt: START, endsAt: END });
  });

  test("keys it does not know are ignored, and never kept or passed on (the words ship in the release)", () => {
    expect(parseLaunchDoc(on({ title: "Words from the site", line: "<b>x</b>", image: "https://evil.example/x.png" }))).toEqual(
      { v: 1, campaign: "product-hunt-2026", on: true, url: GOOD_URL, startsAt: START, endsAt: END },
    );
  });

  test.each([
    ["a product page", "https://www.producthunt.com/products/plannotator"],
    ["a product launch page", "https://www.producthunt.com/products/plannotator/launches/plannotator-2"],
    ["launch=<slug>", "https://www.producthunt.com/posts/plannotator?launch=plannotator"],
    ["utm_* keys", "https://www.producthunt.com/posts/plannotator?utm_source=plannotator&utm_medium=app.inbox&utm_campaign=ph_2026-12"],
    ["launch and utm together", "https://www.producthunt.com/products/plannotator?launch=plannotator&utm_source=plannotator"],
  ])("accepts %s", (_name, url) => {
    expect(parseLaunchDoc(on({ url }))).not.toBeNull();
  });

  test.each([
    ["another host", "https://www.example.com/posts/plannotator"],
    ["the bare host", "https://producthunt.com/posts/plannotator"],
    ["a lookalike host (suffix)", "https://www.producthunt.com.evil.example/posts/plannotator"],
    ["a lookalike host (no dot)", "https://wwwproducthunt.com/posts/plannotator"],
    ["a lookalike host (tld)", "https://www.producthunt.co/posts/plannotator"],
    ["a lookalike host (punycode)", "https://www.xn--producthnt-ecb.com/posts/plannotator"],
    ["a trailing dot", "https://www.producthunt.com./posts/plannotator"],
    ["upper case", "https://WWW.producthunt.com/posts/plannotator"],
    ["http", "http://www.producthunt.com/posts/plannotator"],
    ["a port", "https://www.producthunt.com:8443/posts/plannotator"],
    ["the default port written out", "https://www.producthunt.com:443/posts/plannotator"],
    ["user info", "https://a@www.producthunt.com/posts/plannotator"],
    ["user info with a password", "https://a:b@www.producthunt.com/posts/plannotator"],
    ["a hash", "https://www.producthunt.com/posts/plannotator#comments"],
    ["an empty hash", "https://www.producthunt.com/posts/plannotator#"],
    ["another query key", "https://www.producthunt.com/posts/plannotator?ref=plannotator"],
    ["another key beside utm", "https://www.producthunt.com/posts/plannotator?utm_source=x&next=https://evil.example"],
    ["a repeated key", "https://www.producthunt.com/posts/plannotator?utm_source=a&utm_source=b"],
    ["an empty query", "https://www.producthunt.com/posts/plannotator?"],
    ["an escaped value", "https://www.producthunt.com/posts/plannotator?utm_source=a%20b"],
    ["a launch value with capitals", "https://www.producthunt.com/posts/plannotator?launch=Plannotator"],
    ["another path", "https://www.producthunt.com/login"],
    ["a post subpath", "https://www.producthunt.com/posts/plannotator/reviews"],
    ["a dot segment", "https://www.producthunt.com/products/../login"],
    ["a trailing slash", "https://www.producthunt.com/posts/plannotator/"],
    ["a backslash", "https://www.producthunt.com\\posts/plannotator"],
    ["javascript", "javascript:alert(1)"],
    ["not a string", 42],
  ])("refuses %s", (_name, url) => {
    expect(parseLaunchDoc(on({ url }))).toBeNull();
  });

  test.each([
    ["not ISO", { startsAt: "December 2, 2026" }],
    ["a date only", { startsAt: "2026-12-02" }],
    ["no zone", { startsAt: "2026-12-02T08:00:00" }],
    ["a day that does not exist", { startsAt: "2026-02-30T08:00:00Z", endsAt: "2026-03-01T08:00:00Z" }],
    ["an hour that does not exist", { startsAt: "2026-12-02T24:00:00Z" }],
    ["an end before the start", { startsAt: END, endsAt: START }],
    ["an end at the start", { endsAt: START }],
    ["a span over 14 days", { endsAt: "2026-12-16T08:00:01Z" }],
    ["a start without an end", { endsAt: undefined }],
    ["an on without dates", { startsAt: undefined, endsAt: undefined }],
  ])("refuses dates: %s", (_name, over) => {
    expect(parseLaunchDoc(on(over))).toBeNull();
  });

  test("accepts exactly 14 days, and an offset", () => {
    expect(parseLaunchDoc(on({ endsAt: "2026-12-16T08:00:00Z" }))).not.toBeNull();
    expect(parseLaunchDoc(on({ startsAt: "2026-12-02T00:01:00-08:00", endsAt: "2026-12-03T00:00:00-08:00" }))).not.toBeNull();
  });

  test.each([
    ["not JSON", "{v:1}"],
    ["JSON that is not an object", "[1]"],
    ["another v", on({ v: 2 })],
    ["v as text", on({ v: "1" })],
    ["a campaign with capitals", on({ campaign: "Product-Hunt" })],
    ["a campaign over 40", on({ campaign: "a".repeat(41) })],
    ["on as text", on({ on: "true" })],
    ["an on without url", on({ url: undefined })],
    ["an off with a bad url", JSON.stringify({ v: 1, campaign: "x", on: false, url: "https://evil.example/" })],
  ])("refuses %s", (_name, text) => {
    expect(parseLaunchDoc(text)).toBeNull();
  });

  test("a body that is not valid UTF-8 is off, even when the rest is a good on file", () => {
    const good = new TextEncoder().encode(on({ note: "__" }));
    const at = new TextDecoder().decode(good).indexOf("__");
    const bad = good.slice();
    bad[at] = 0xff; // never valid in UTF-8
    bad[at + 1] = 0xfe;
    expect(parseLaunchDoc(good)).toMatchObject({ on: true });
    expect(parseLaunchDoc(bad)).toBeNull();
  });

  test("a valid document over 4 KB is off; at 4 KB it parses", () => {
    const base = on();
    expect(parseLaunchDoc(base + " ".repeat(LAUNCH_SWITCH_MAX_BYTES - base.length))).not.toBeNull();
    expect(parseLaunchDoc(base + " ".repeat(LAUNCH_SWITCH_MAX_BYTES - base.length + 1))).toBeNull();
  });
});

describe("launchActive: the dates", () => {
  const doc = parseLaunchDoc(on());
  test("on from startsAt, off from endsAt", () => {
    expect(launchActive(doc, T_START - 1)).toBe(false);
    expect(launchActive(doc, T_START)).toBe(true);
    expect(launchActive(doc, T_END - 1)).toBe(true);
    expect(launchActive(doc, T_END)).toBe(false);
    expect(launchActive(parseLaunchDoc(on({ on: false })), T_START + 1)).toBe(false);
  });
});

describe("launchSwitchEndpoint: who asks", () => {
  const LOOP = "http://127.0.0.1:4555/launch.json";
  test("a release outside the sandbox asks plannotator.ai, and ignores any other URL", () => {
    expect(launchSwitchEndpoint({}, true, true)).toBe(LAUNCH_SWITCH_URL);
    expect(launchSwitchEndpoint({ PLANNOTATOR_LAUNCH_URL: "https://evil.example/launch.json" }, true, true)).toBe(LAUNCH_SWITCH_URL);
    expect(launchSwitchEndpoint({ PLANNOTATOR_LAUNCH_URL: LOOP }, true, true)).toBe(LAUNCH_SWITCH_URL);
  });
  test("under the sandbox, only a loopback URL", () => {
    expect(launchSwitchEndpoint({ PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_LAUNCH_URL: LOOP }, false, true)).toBe(LOOP);
    expect(launchSwitchEndpoint({ PLANNOTATOR_TEST_SANDBOX: "1" }, true, true)).toBeNull();
    expect(launchSwitchEndpoint({ NODE_ENV: "test", PLANNOTATOR_LAUNCH_URL: "https://plannotator.ai/launch.json" }, true, true)).toBeNull();
    expect(launchSwitchEndpoint({ PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_LAUNCH_URL: "http://10.0.0.2/launch.json" }, true, true)).toBeNull();
  });

  // Each opt-out, against a release and against the sandbox's loopback URL: no request at all (counted).
  test.each([
    ["PLANNOTATOR_LAUNCH_URL=off", { PLANNOTATOR_LAUNCH_URL: "off" }, true, true],
    ["update checks off in config.json", {}, true, false],
    ["NO_ANON_PING=1", { NO_ANON_PING: "1" }, true, true],
    ["DO_NOT_TRACK=1", { DO_NOT_TRACK: "1" }, true, true],
    ["CI=true", { CI: "true" }, true, true],
    ["GITHUB_ACTIONS=true", { GITHUB_ACTIONS: "true" }, true, true],
    ["a dev build", {}, false, true],
  ] as const)("%s: zero fetches", async (_name, env, release, updateCheck) => {
    for (const sandbox of [{}, { PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_LAUNCH_URL: env.PLANNOTATOR_LAUNCH_URL ?? LOOP }]) {
      const fullEnv = { ...env, ...sandbox } as NodeJS.ProcessEnv;
      // The sandbox's loopback URL needs no release: a dev build is judged outside it only.
      if (!release && "PLANNOTATOR_TEST_SANDBOX" in sandbox) continue;
      const f = fakeFetch();
      const dir = dataDir();
      const service = createLaunchSwitch({ dataDir: () => dir, endpoint: () => launchSwitchEndpoint(fullEnv, release, updateCheck), shown: memoryShown(), fetch: f.fn });
      expect(await service.refresh()).toBe("off");
      service.claim();
      await new Promise((r) => setTimeout(r, 5));
      expect(f.calls.length).toBe(0);
      expect(() => readFileSync(join(dir, LAUNCH_SWITCH_FILE))).toThrow();
    }
  });

  test("PLANNOTATOR_UPDATE_CHECK=0 in the environment stops it too (the endpoint's update check reads it)", async () => {
    const { resolveUpdateCheck } = await import("./config");
    expect(launchSwitchEndpoint({}, true, resolveUpdateCheck({}, { PLANNOTATOR_UPDATE_CHECK: "0" }))).toBeNull();
    expect(launchSwitchEndpoint({}, true, resolveUpdateCheck({ updateCheck: false }, {}))).toBeNull();
  });
});

describe("the reader", () => {
  const ENDPOINT = "http://127.0.0.1:9/launch.json";

  test("keeps what the site said; asks again only after 15 minutes, across services sharing the folder", async () => {
    const dir = dataDir();
    let now = T_START + 1000;
    const f = fakeFetch();
    const make = () => createLaunchSwitch({ dataDir: () => dir, endpoint: () => ENDPOINT, shown: memoryShown(), fetch: f.fn, now: () => now });
    expect(await make().refresh()).toBe("asked");
    expect(readLaunchKept(dir).doc).toMatchObject({ on: true, url: GOOD_URL });
    now += LAUNCH_SWITCH_REFRESH_MS - 1;
    expect(await make().refresh()).toBe("fresh");
    expect(f.calls.length).toBe(1);
    now += 1;
    expect(await make().refresh()).toBe("asked");
    expect(f.calls.length).toBe(2);
  });

  test("how often it asks: 3 hours while off or absent, hourly while an on waits for startsAt, 15 minutes while on", async () => {
    const cases: { doc: string | null; at: number; fresh: number }[] = [
      { doc: null, at: T_START, fresh: LAUNCH_SWITCH_OFF_REFRESH_MS },
      { doc: JSON.stringify({ v: 1, campaign: "product-hunt-2026", on: false }), at: T_START, fresh: LAUNCH_SWITCH_OFF_REFRESH_MS },
      { doc: on(), at: T_START - 5 * 60 * 60 * 1000, fresh: LAUNCH_SWITCH_AHEAD_REFRESH_MS },
      { doc: on(), at: T_START + 1000, fresh: LAUNCH_SWITCH_REFRESH_MS },
      { doc: on(), at: T_END + 1000, fresh: LAUNCH_SWITCH_OFF_REFRESH_MS },
    ];
    expect(LAUNCH_SWITCH_OFF_REFRESH_MS).toBe(3 * 60 * 60 * 1000);
    expect(LAUNCH_SWITCH_AHEAD_REFRESH_MS).toBe(60 * 60 * 1000);
    for (const { doc, at, fresh } of cases) {
      const dir = dataDir();
      writeFileSync(join(dir, LAUNCH_SWITCH_FILE), JSON.stringify({ checkedAt: new Date(at).toISOString(), doc: doc === null ? null : JSON.parse(doc) }));
      let now = at + fresh - 1;
      const f = fakeFetch();
      const service = createLaunchSwitch({ dataDir: () => dir, endpoint: () => ENDPOINT, shown: memoryShown(), fetch: f.fn, now: () => now });
      expect(await service.refresh()).toBe("fresh");
      now = at + fresh;
      expect(await service.refresh()).toBe("asked");
      expect(f.calls.length).toBe(1);
    }
  });

  test("an on copy kept ahead of startsAt becomes due at startsAt with no request", async () => {
    const dir = dataDir();
    writeFileSync(join(dir, LAUNCH_SWITCH_FILE), JSON.stringify({ checkedAt: new Date(T_START - 10 * 60 * 1000).toISOString(), doc: JSON.parse(on()) }));
    let now = T_START - 1;
    const f = fakeFetch();
    const service = createLaunchSwitch({ dataDir: () => dir, endpoint: () => ENDPOINT, shown: memoryShown(), fetch: f.fn, now: () => now });
    expect(service.claim()).toEqual({ show: false });
    now = T_START;
    expect(service.claim()).toMatchObject({ show: true, campaign: "product-hunt-2026" });
    await new Promise((r) => setTimeout(r, 10));
    expect(f.calls.length).toBe(0);
  });

  test("no timer keeps a process alive: a reader started with a site that never answers lets the process exit", () => {
    const dir = dataDir();
    const script = join(dir, "run.ts");
    const mod = join(import.meta.dir, "launch-switch.ts");
    writeFileSync(script, `
      import { createLaunchSwitch, fetchLaunchDoc } from ${JSON.stringify(mod)};
      const hang = ((_u, init) => new Promise((_, no) => init.signal.addEventListener("abort", () => no(new Error("aborted"))))) as typeof fetch;
      const store = { read: () => undefined, write: () => true, stamp: () => "stamped" as const };
      createLaunchSwitch({ dataDir: () => ${JSON.stringify(dir)}, endpoint: () => "http://127.0.0.1:9/launch.json", shown: store, fetch: hang, timeoutMs: 20_000 }).start();
      void fetchLaunchDoc(hang, "http://127.0.0.1:9/launch.json", 20_000);
      setTimeout(() => {}, 50);
    `);
    const before = Date.now();
    const run = Bun.spawnSync([process.execPath, script], { env: { PATH: process.env.PATH ?? "", PLANNOTATOR_DATA_DIR: dir, PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9", PLANNOTATOR_TEST_SANDBOX: "1" }, timeout: 15_000 });
    expect(run.exitCode).toBe(0);
    expect(Date.now() - before).toBeLessThan(10_000);
  });

  test("a failure (offline, 500, a redirect, too slow) keeps the last good copy; an invalid 200 replaces it with off", async () => {
    const dir = dataDir();
    let now = T_START + 1000;
    const run = async (answer: Parameters<typeof fakeFetch>[0]) => {
      const f = fakeFetch(answer);
      await createLaunchSwitch({ dataDir: () => dir, endpoint: () => ENDPOINT, shown: memoryShown(), fetch: f.fn, now: () => now, timeoutMs: 30 }).refresh();
      now += LAUNCH_SWITCH_REFRESH_MS;
      return readLaunchKept(dir).doc;
    };
    expect(await run({})).toMatchObject({ on: true });
    expect(await run({ fail: true })).toMatchObject({ on: true });
    expect(await run({ status: 500 })).toMatchObject({ on: true });
    expect(await run({ status: 302, headers: { location: "https://evil.example/launch.json" } })).toMatchObject({ on: true });
    expect(await run({ hang: true })).toMatchObject({ on: true });
    expect(await run({ body: on({ url: "https://evil.example/" }) })).toBeNull();
  });

  test("a kept on copy turns itself off at endsAt, with no request", async () => {
    const dir = dataDir();
    let now = T_END - 60_000;
    const f = fakeFetch();
    const service = createLaunchSwitch({ dataDir: () => dir, endpoint: () => ENDPOINT, shown: memoryShown(), fetch: f.fn, now: () => now });
    await service.refresh();
    expect(service.claim()).toMatchObject({ show: true, campaign: "product-hunt-2026", url: GOOD_URL });
    now = T_END;
    expect(service.claim()).toEqual({ show: false });
    expect(service.shown()).toEqual({ show: false });
    expect(f.calls.length).toBe(1);
  });

  test("a claim never waits on the site: a fetch that never answers", async () => {
    const dir = dataDir();
    writeFileSync(join(dir, LAUNCH_SWITCH_FILE), JSON.stringify({ checkedAt: new Date(T_START - LAUNCH_SWITCH_REFRESH_MS * 2).toISOString(), doc: JSON.parse(on()) }));
    const f = fakeFetch({ hang: true });
    const service = createLaunchSwitch({ dataDir: () => dir, endpoint: () => ENDPOINT, shown: memoryShown(), fetch: f.fn, now: () => T_START + 1, timeoutMs: 200 });
    const before = performance.now();
    const answered = launchSwitchRoute(service, "POST", "/api/launch-switch/claim", {});
    expect(performance.now() - before).toBeLessThan(50);
    expect(answered?.body).toMatchObject({ show: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(f.calls.length).toBe(1); // the due refresh started in the background
  });

  test("a hand-edited kept file is read with the same strict rules", () => {
    const dir = dataDir();
    writeFileSync(join(dir, LAUNCH_SWITCH_FILE), JSON.stringify({ checkedAt: new Date(T_START).toISOString(), doc: JSON.parse(on({ url: "https://evil.example/" })) }));
    const service = createLaunchSwitch({ dataDir: () => dir, endpoint: () => ENDPOINT, shown: memoryShown(), fetch: fakeFetch().fn, now: () => T_START + 1 });
    expect(service.claim()).toEqual({ show: false });
  });
});

describe("the request (a stand-in site on loopback)", () => {
  test("GET with no query, no cookie, user-agent plannotator; a redirect is not followed", async () => {
    const seen: { url: string; ua: string | null; cookie: string | null; method: string }[] = [];
    let followed = 0;
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/elsewhere") {
          followed++;
          return new Response(on());
        }
        seen.push({ url: req.url, ua: req.headers.get("user-agent"), cookie: req.headers.get("cookie"), method: req.method });
        if (url.pathname === "/moved") return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
        if (url.pathname === "/big") return new Response("x".repeat(LAUNCH_SWITCH_MAX_BYTES + 1));
        return new Response(on());
      },
    });
    try {
      const base = `http://127.0.0.1:${site.port}`;
      const got = await fetchLaunchDoc(fetch, `${base}/launch.json`);
      expect(got).toBeInstanceOf(Uint8Array);
      expect(parseLaunchDoc(got as Uint8Array)).toMatchObject({ on: true });
      expect(seen[0]).toEqual({ url: `${base}/launch.json`, ua: "plannotator", cookie: null, method: "GET" });
      expect(await fetchLaunchDoc(fetch, `${base}/moved`)).toBeNull();
      expect(followed).toBe(0);
      expect(await fetchLaunchDoc(fetch, `${base}/big`)).toBe("invalid");
    } finally {
      site.stop(true);
    }
  });
});

describe("once per computer", () => {
  test("shown once: a second surface's claim and stamp say no; the answer is kept once", async () => {
    const dir = dataDir();
    const shown = memoryShown();
    const f = fakeFetch();
    const a = createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/x", shown, fetch: f.fn, now: () => T_START + 1 });
    const b = createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/x", shown, fetch: f.fn, now: () => T_START + 2 });
    await a.refresh();
    expect(a.claim()).toMatchObject({ show: true });
    expect(b.claim()).toMatchObject({ show: true });
    expect(a.shown("product-hunt-2026")).toEqual({ show: true });
    expect(b.claim()).toEqual({ show: false });
    expect(b.shown()).toEqual({ show: false });
    expect(b.answer("opened")).toEqual({ ok: true });
    expect(a.answer("dismissed")).toEqual({ ok: true });
    expect(shown.all["product-hunt-2026"]?.answer).toBe("opened");
  });

  test("two surfaces stamping at once (separate processes, one data folder): the first stamp stays, the other gets no", async () => {
    const original = process.env.PLANNOTATOR_DATA_DIR;
    const dir = dataDir();
    process.env.PLANNOTATOR_DATA_DIR = dir;
    try {
      writeFileSync(join(dir, LAUNCH_SWITCH_FILE), JSON.stringify({ checkedAt: new Date(T_START).toISOString(), doc: JSON.parse(on()) }));
      const make = (now: number, shown: LaunchShownStore) =>
        createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/x", shown, fetch: fakeFetch().fn, now: () => now });
      const b = make(T_START + 1, configLaunchShownStore);
      let bSaid: { show: boolean } | null = null;
      let armed = false;
      // A's checks read the record as it was, then B stamps before A writes: the interleaving of two processes.
      const interleaved: LaunchShownStore = {
        ...configLaunchShownStore,
        read(campaign) {
          const was = configLaunchShownStore.read(campaign);
          if (armed && bSaid === null) bSaid = b.shown("product-hunt-2026");
          return was;
        },
      };
      const a = make(T_START + 2, interleaved);
      expect(a.claim()).toMatchObject({ show: true });
      armed = true;
      const aSaid = a.shown("product-hunt-2026");
      expect(bSaid).toEqual({ show: true });
      expect(aSaid).toEqual({ show: false });
      expect(configLaunchShownStore.read("product-hunt-2026")?.shownAt).toBe(new Date(T_START + 1).toISOString());
    } finally {
      if (original === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = original;
    }
  });

  test("a stamp that cannot be written counts as shown for this process: it is never claimed here again", async () => {
    const dir = dataDir();
    const shown = memoryShown();
    shown.stamp = () => "failed";
    shown.write = () => false;
    const a = createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/x", shown, fetch: fakeFetch().fn, now: () => T_START + 1 });
    await a.refresh();
    expect(a.claim()).toMatchObject({ show: true });
    expect(a.shown("product-hunt-2026")).toEqual({ show: true });
    expect(a.claim()).toEqual({ show: false });
    expect(a.shown("product-hunt-2026")).toEqual({ show: false });
  });

  test("a stamp the machine state refuses (a hand-broken config.json): the data folder's mark keeps it to once per computer", async () => {
    const dir = dataDir();
    const broken = () => {
      const shown = memoryShown();
      shown.stamp = () => "failed";
      shown.write = () => false;
      return shown;
    };
    const make = () => createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/x", shown: broken(), fetch: fakeFetch().fn, now: () => T_START + 1 });
    const a = make();
    await a.refresh();
    expect(a.shown("product-hunt-2026")).toEqual({ show: true });
    // Every later plan or review server is a new process: none shows it again.
    const b = make();
    expect(b.claim()).toEqual({ show: false });
    expect(b.shown("product-hunt-2026")).toEqual({ show: false });
    // A refresh rewrites the kept copy and keeps the mark.
    await createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/x", shown: broken(), fetch: fakeFetch().fn, now: () => T_START + 2 * LAUNCH_SWITCH_REFRESH_MS, refreshMs: 1 }).refresh();
    expect(make().claim()).toEqual({ show: false });
  });

  test("a stamp that lands in the machine state also marks the data folder (a config.json broken later still reads as shown)", async () => {
    const dir = dataDir();
    const a = createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/x", shown: memoryShown(), fetch: fakeFetch().fn, now: () => T_START + 1 });
    await a.refresh();
    expect(a.shown("product-hunt-2026")).toEqual({ show: true });
    const emptied = createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/x", shown: memoryShown(), fetch: fakeFetch().fn, now: () => T_START + 2 });
    expect(emptied.claim()).toEqual({ show: false });
  });

  // Root writes into a read-only folder anyway, so there the data folder's mark cannot be made to fail.
  test.skipIf(process.getuid?.() === 0)("neither record can be written (a read-only data folder too): it does not show", async () => {
    const dir = dataDir();
    writeFileSync(join(dir, LAUNCH_SWITCH_FILE), JSON.stringify({ checkedAt: new Date(T_START).toISOString(), doc: JSON.parse(on()) }));
    const shown = memoryShown();
    shown.stamp = () => "failed";
    const a = createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/x", shown, fetch: fakeFetch().fn, now: () => T_START + 1 });
    expect(a.claim()).toMatchObject({ show: true });
    chmodSync(dir, 0o500);
    try {
      expect(a.shown("product-hunt-2026")).toEqual({ show: false });
      // And a new load there is not offered it at all (no dialog drawn and then taken back on every load).
      const b = createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/x", shown: memoryShown(), fetch: fakeFetch().fn, now: () => T_START + 1 });
      expect(b.claim()).toEqual({ show: false });
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a campaign this release does not know is off: a renamed or mistyped campaign never shows these words", async () => {
    expect(parseLaunchDoc(on({ campaign: "product-hunt-2027" }))).toBeNull();
    expect(parseLaunchDoc(on({ campaign: "product-hunt-2026x" }))).toBeNull();
    expect(parseLaunchDoc(on())).not.toBeNull();
    const dir = dataDir();
    writeFileSync(join(dir, LAUNCH_SWITCH_FILE), JSON.stringify({ checkedAt: new Date(T_START).toISOString(), doc: JSON.parse(on({ campaign: "product-hunt-2027" })) }));
    const a = createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/x", shown: memoryShown(), fetch: fakeFetch({ body: on({ campaign: "product-hunt-2027" }) }).fn, now: () => T_START + 1 });
    expect(a.claim()).toEqual({ show: false });
    expect(a.shown("product-hunt-2027")).toEqual({ show: false });
    await a.refresh();
    expect(a.claim()).toEqual({ show: false });
  });

  test("a shown for another campaign, or an answer before any shown, does nothing", async () => {
    const dir = dataDir();
    const shown = memoryShown();
    const a = createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/x", shown, fetch: fakeFetch().fn, now: () => T_START + 1 });
    await a.refresh();
    expect(a.answer("opened")).toEqual({ ok: false });
    expect(a.shown("another-launch")).toEqual({ show: false });
    expect(shown.all).toEqual({});
    expect(launchSwitchRoute(a, "POST", "/api/launch-switch/answer", { answer: "starred" })?.status).toBe(400);
    expect(launchSwitchRoute(a, "GET", "/api/launch-switch/claim", undefined)?.status).toBe(405);
    expect(launchSwitchRoute(a, "POST", "/api/launch-switch/other", {})).toBeNull();
  });
});
