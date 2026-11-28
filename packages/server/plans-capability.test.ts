/**
 * Plans as an Inbox capability, in process through the capability seam (no Inbox started), on a scratch data dir.
 * What regresses if these fail:
 * - Off costs something: a `/api/plans` route answers, the library is opened or imported, a file appears under the
 *   data dir, the settings answer gains a key, plan review writes anything new, or Plans reaches the Inbox's agent
 *   tool text, its served tools, plan review, the Claude Code mod or Pi;
 * - on, a route is reachable from anywhere but the owner's window on this computer, another site reads a plan, or a
 *   POST from a stale page (another server session) records a look;
 * - the settings switch takes a malformed value, does not stick, or answers what it did not save;
 * - turning it on does not import the library, and two imports run at once;
 * - a window open when it is turned on or off (from `plannotator plans`, saved through the Inbox) does not hear it:
 *   `event: capabilities` must name `plans: { on: true }` while on and `{ on: false }` on the change that turned it
 *   off, and nothing of Plans otherwise.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { answerInboxCapabilities, capabilitiesFrame, capabilitiesWire, checkInboxCapabilities, namesInboxCapability, routeInboxCapabilities, startInboxCapabilities, type InboxCapabilityGuard } from "./inbox-capability";
import { createPlansCapability, PLAN_HISTORY_WATCH_FOLDERS } from "./plans-capability";
import { createPlanStore, type PlanStore } from "@plannotator/shared/plans/store";
import { saveFinalSnapshot, saveToHistory } from "@plannotator/shared/storage";
import { appendFeedbackRecord } from "@plannotator/shared/feedback-archive";
import { INBOX_MCP_INSTRUCTIONS, INBOX_MCP_TOOLS, inboxServedTools } from "./inbox-mcp";

let dataDir = "";
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "plans-capability-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

const SESSION = "srv-session-1";
const owner: InboxCapabilityGuard = { local: true, crossSite: () => null, serverSession: SESSION };
const request = (method: string, path: string, body?: unknown) =>
  new Request(`http://127.0.0.1:1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) });
const route = (list: ReturnType<typeof capabilityWorld>["list"], method: string, path: string, body?: unknown, guard = owner) =>
  routeInboxCapabilities(list, request(method, path, body), new URL(`http://127.0.0.1:1${path}`), guard);

/** Every file under the data dir, with its bytes. */
function files(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(dataDir, path), readFileSync(path, "base64"));
    }
  };
  walk(dataDir);
  return out;
}

function capabilityWorld(options: { fixed?: boolean; shareFixed?: boolean } = {}) {
  let opened = 0;
  let changed = 0;
  const capability = createPlansCapability({
    dataDir,
    ...options,
    changed: () => changed++,
    pickUpMs: 0,
    openStore: (dir) => {
      opened++;
      return createPlanStore({ dataDir: dir });
    },
  });
  return { list: [capability], capability, opened: () => opened, changed: () => changed };
}

function historyFixture() {
  const dir = join(dataDir, "history", "api", "auth-refactor-2026-11-01");
  mkdirSync(dir, { recursive: true });
  const when = new Date(Date.UTC(2026, 10, 1, 9));
  writeFileSync(join(dir, "001.md"), "# Auth refactor\n\nv1\n");
  utimesSync(join(dir, "001.md"), when, when);
}

describe("Plans off costs nothing", () => {
  test("no route, no store, no import, no file, nothing in the settings answer", async () => {
    historyFixture();
    const before = files();
    const { list, capability, opened } = capabilityWorld();
    expect(capability.on()).toBe(false);
    for (const [method, path] of [["GET", "/api/plans"], ["GET", "/api/plans/pln_x"], ["GET", "/api/plans/pln_x/versions/1"], ["POST", "/api/plans/pln_x/look"]] as const) {
      const answer = await route(list, method, path, method === "POST" ? {} : undefined);
      expect([path, answer?.status, await answer?.json()]).toEqual([path, 404, { error: "Not found", code: "not_found" }]);
    }
    expect(await route(list, "GET", "/api/inbox/threads")).toBeNull();
    startInboxCapabilities(list);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(capabilitiesWire(list)).toEqual({});
    expect(answerInboxCapabilities(list, { theme: "dark" })).toEqual({});
    expect(capability.importing()).toBeNull();
    expect(opened()).toBe(0);
    expect(existsSync(join(dataDir, "plan-library"))).toBe(false);
    expect(files()).toEqual(before);
  });

  test("plan review writes nothing new, off or on", () => {
    for (const on of [false, true]) {
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxPlans: on }));
      const saved = saveToHistory("api", `steps-${on}-2026-11-01`, "# Steps\n");
      saveFinalSnapshot(`steps-${on}-2026-11-01`, "approved", "# Steps\n", "");
      appendFeedbackRecord({ project: "api", surface: "plan", decision: "approved", target: { slug: `steps-${on}-2026-11-01`, planVersion: saved.version } });
      expect(saved.isNew).toBe(true);
      expect(existsSync(join(dataDir, "plan-library"))).toBe(false);
    }
  });

  test("the Inbox's agent tools and their text name nothing of Plans", () => {
    expect(INBOX_MCP_TOOLS.some((name) => /plan/i.test(name))).toBe(false);
    for (const board of [false, true]) for (const steps of [false, true]) for (const scheduled of [false, true]) {
      expect(inboxServedTools({ board, steps, scheduled }).some((name) => /plan/i.test(name))).toBe(false);
    }
    expect(INBOX_MCP_INSTRUCTIONS).not.toMatch(/\bPlans\b|pln_|plan-library|plan library/);
  });

  test("only the capability seam, the plans command and the window's Plans page reach Plans' modules: not plan review, the Inbox tool, the mod or Pi", () => {
    const root = resolve(import.meta.dir, "../..");
    const allowed = new Set([
      "packages/core/plans.ts",
      "packages/shared/plans/store.ts",
      "packages/shared/plans/import.ts",
      "packages/shared/plans/routes.ts",
      "packages/shared/plans/switch.ts",
      // Share this space reads the library to send it: reached only from the capability, behind its own switch.
      "packages/core/space-share.ts",
      "packages/shared/spaces/share-job.ts",
      "packages/shared/spaces/record.ts",
      "packages/shared/spaces/engine.ts",
      "packages/server/inbox-capability.ts",
      "packages/server/plans-capability.ts",
      "packages/server/inbox.ts",
      "apps/hook/server/plans-command.ts",
      "apps/hook/server/index.ts",
    ]);
    const reaches = /from\s+["'](?:@plannotator\/core\/plans|@plannotator\/shared\/plans\/[a-z]+|\.\.?\/(?:[\w./-]*\/)?plans(?:\/[a-z]+)?|\.\/(?:plans-capability|plans-command|inbox-capability))["']/;
    const found: string[] = [];
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const rel = relative(root, path).split("\\").join("/");
          // The Inbox window's Plans page reads the routes' records (types and pure checks only: core is browser-safe).
          if (!allowed.has(rel) && !rel.startsWith("packages/inbox/plans/") && reaches.test(readFileSync(path, "utf8"))) found.push(rel);
        }
      }
    };
    for (const top of ["packages", "apps"]) walk(join(root, top));
    expect(found).toEqual([]);
    // And the Inbox core reaches it only through the seam.
    const inbox = readFileSync(join(root, "packages/server/inbox.ts"), "utf8");
    expect(inbox.match(/from\s+["'][^"']*plans[^"']*["']/g)).toBeNull();
  });
});

describe("Plans on", () => {
  test("routes answer only the owner's window on this computer, same-site; a stale page's POST is refused", async () => {
    historyFixture();
    const { list, capability } = capabilityWorld({ fixed: true });
    await capability.sync();
    const listed = await route(list, "GET", "/api/plans");
    expect(listed?.status).toBe(200);
    const [plan] = ((await listed!.json()) as { plans: { id: string }[] }).plans;
    expect(plan).toBeDefined();

    // The tailnet, a phone's door, a linked machine: as if absent.
    expect((await route(list, "GET", "/api/plans", undefined, { ...owner, local: false }))?.status).toBe(404);
    // Another site: refused, reads included.
    const refusal = Response.json({ code: "cross_origin" }, { status: 403 });
    expect((await route(list, "GET", `/api/plans/${plan!.id}`, undefined, { ...owner, crossSite: () => refusal }))?.status).toBe(403);
    // A page from another server session: refused before anything is written.
    expect((await route(list, "POST", `/api/plans/${plan!.id}/look`, { serverSession: "old", seen: 1 }))?.status).toBe(409);
    expect(createPlanStore({ dataDir }).looks().plans[plan!.id]).toBeUndefined();
    const looked = await route(list, "POST", `/api/plans/${plan!.id}/look`, { serverSession: SESSION, seen: 1 });
    expect(looked?.status).toBe(200);

    const bytes = await route(list, "GET", `/api/plans/${plan!.id}/versions/1`);
    expect(bytes?.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(bytes?.headers.get("content-security-policy")).toBe("sandbox");
    expect(await bytes?.text()).toBe("# Auth refactor\n\nv1\n");
    expect((await route(list, "GET", "/api/plans/nope/x"))?.status).toBe(404);
  });

  test("a route picks up what plan review wrote since, in the background; one import at a time", async () => {
    historyFixture();
    const { list, capability } = capabilityWorld({ fixed: true });
    const first = await route(list, "GET", "/api/plans");
    expect(((await first!.json()) as { importing: boolean }).importing).toBe(true);
    const running = capability.importing();
    expect(running).not.toBeNull();
    expect(capability.sync()).toBe(running!);
    await running;
    // Caught up: the pickup this request starts is not "importing", or a window polling while importing never stops.
    const second = (await (await route(list, "GET", "/api/plans"))!.json()) as { plans: unknown[]; importing: boolean };
    expect(second.plans).toHaveLength(1);
    expect(capability.importing()).not.toBeNull();
    expect(second.importing).toBe(false);
    await capability.importing();
  });

  test("the home's poll: 304 with no body while nothing changed, and it picks up plan history at most once per pollPickUpMs", async () => {
    historyFixture();
    const capability = createPlansCapability({ dataDir, fixed: true, changed: () => {}, pickUpMs: 0, pollPickUpMs: 60_000, openStore: (dir) => createPlanStore({ dataDir: dir }) });
    const list = [capability];
    const get = (path: string, etag?: string) => routeInboxCapabilities(list, new Request(`http://127.0.0.1:1${path}`, etag ? { headers: { "If-None-Match": etag } } : {}), new URL(`http://127.0.0.1:1${path}`), owner);
    // An ordinary read picks up (and the whole import runs once).
    await get("/api/plans");
    await capability.importing();
    const answer = (await get("/api/plans?poll=1"))!;
    // A poll right after: no pickup (the last one was under a minute ago).
    expect(capability.importing()).toBeNull();
    const etag = answer.headers.get("ETag")!;
    expect(etag).toBeTruthy();
    const unchanged = (await get("/api/plans?poll=1", etag))!;
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(capability.importing()).toBeNull();
    // An ordinary read still picks up at once.
    await get("/api/plans");
    expect(capability.importing()).not.toBeNull();
    await capability.importing();
  });

  test("plan review's write into history is heard: the next poll picks it up and answers with it, past the slow pickup", async () => {
    historyFixture();
    const capability = createPlansCapability({ dataDir, fixed: true, changed: () => {}, pickUpMs: 0, pollPickUpMs: 60_000, settleMs: 0, openStore: (dir) => createPlanStore({ dataDir: dir }) });
    const list = [capability];
    const poll = async () => (await (await routeInboxCapabilities(list, new Request("http://127.0.0.1:1/api/plans?poll=1"), new URL("http://127.0.0.1:1/api/plans?poll=1"), owner))!.json()) as { plans: { name: string }[] };
    await routeInboxCapabilities(list, new Request("http://127.0.0.1:1/api/plans"), new URL("http://127.0.0.1:1/api/plans"), owner);
    await capability.importing();
    expect((await poll()).plans.map((p) => p.name)).toEqual(["Auth refactor"]);
    // Plan review writes a new plan (settled: an hour old); within the minute the slow pickup would wait.
    const dir = join(dataDir, "history", "api", "rate-limits-2026-11-02");
    mkdirSync(dir, { recursive: true });
    const when = new Date(Date.now() - 3_600_000);
    writeFileSync(join(dir, "001.md"), "# Rate limits\n\nv1\n");
    utimesSync(join(dir, "001.md"), when, when);
    let names: string[] = [];
    for (let i = 0; i < 200 && !names.includes("Rate limits"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      names = (await poll()).plans.map((p) => p.name);
    }
    expect(names.sort()).toEqual(["Auth refactor", "Rate limits"]);
    // Heard once: the poll after it waits again.
    await poll();
    expect(capability.importing()).toBeNull();
  }, 15_000);

  test("on Linux a history of more folders than PLAN_HISTORY_WATCH_FOLDERS is not watched (inotify is shared): the slow pickup alone finds it", async () => {
    historyFixture();
    for (let i = 0; i <= PLAN_HISTORY_WATCH_FOLDERS; i++) mkdirSync(join(dataDir, "history", "bulk", `plan-${i}`), { recursive: true });
    const capability = createPlansCapability({ dataDir, fixed: true, changed: () => {}, pickUpMs: 0, pollPickUpMs: 60_000, settleMs: 0, platform: "linux", openStore: (dir) => createPlanStore({ dataDir: dir }) });
    const list = [capability];
    const poll = async () => (await (await routeInboxCapabilities(list, new Request("http://127.0.0.1:1/api/plans?poll=1"), new URL("http://127.0.0.1:1/api/plans?poll=1"), owner))!.json()) as { plans: { name: string }[] };
    await routeInboxCapabilities(list, new Request("http://127.0.0.1:1/api/plans"), new URL("http://127.0.0.1:1/api/plans"), owner);
    await capability.importing();
    const dir = join(dataDir, "history", "api", "rate-limits-2026-11-02");
    mkdirSync(dir, { recursive: true });
    const when = new Date(Date.now() - 3_600_000);
    writeFileSync(join(dir, "001.md"), "# Rate limits\n\nv1\n");
    utimesSync(join(dir, "001.md"), when, when);
    // Long past the time a heard write is picked up here (under a second): nothing was heard, so the poll waits.
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await poll()).plans.map((p) => p.name)).toEqual(["Auth refactor"]);
    }
  }, 15_000);

  test("an import that keeps failing waits longer each time, is logged once, says so in the list, and Try again runs it now", async () => {
    historyFixture();
    const lines: string[] = [];
    let fail = true;
    let imports = 0;
    const real = createPlanStore({ dataDir });
    const store = new Proxy(real, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (key === "legacyMap") imports++;
          if (fail && key === "legacyMap") throw new Error("disk says no");
          return value.apply(target, args);
        };
      },
    });
    const capability = createPlansCapability({ dataDir, fixed: true, changed: () => {}, pickUpMs: 0, retryMs: 1000, retryMaxMs: 3000, log: (line) => lines.push(line), openStore: () => store });
    const list = [capability];
    const read = async (path = "/api/plans") => (await (await route(list, "GET", path))!.json()) as { importing: boolean; import_error: string | null };
    let now = Date.UTC(2026, 10, 2, 9);
    const at = (ms: number) => setSystemTime(new Date((now += ms)));
    /** Polls the list at `ms` from the last step, and says whether that poll started an import. */
    const pollStarts = async (ms: number) => {
      at(ms);
      const before = imports;
      const answer = await read();
      expect(answer.importing).toBe(false);
      await capability.importing()?.catch(() => {});
      return imports > before;
    };

    try {
      at(0);
      await capability.sync().catch(() => {});
      // Failed: said in the list (not "importing"), and logged once.
      const answer = await read();
      expect(answer.import_error).toContain("disk says no");
      expect(capability.importing()).toBeNull();
      // Waits 1 s, then 2 s, then 3 s (the cap), then 3 s: the polls in between start nothing.
      expect(await pollStarts(500)).toBe(false);
      expect(await pollStarts(600)).toBe(true);
      expect(await pollStarts(1500)).toBe(false);
      expect(await pollStarts(600)).toBe(true);
      expect(await pollStarts(2900)).toBe(false);
      expect(await pollStarts(200)).toBe(true);
      expect(await pollStarts(2900)).toBe(false);
      expect(await pollStarts(200)).toBe(true);
      // The same error each time: one line in the log.
      expect(lines).toHaveLength(1);

      // Try again: runs now, whatever the wait, and the list says importing until it ends.
      fail = false;
      at(10);
      const retried = await read("/api/plans?retry=1");
      expect(retried.importing).toBe(true);
      await capability.importing();
      const after = await read();
      expect(after.import_error).toBeNull();
      expect(lines).toHaveLength(1);
    } finally {
      setSystemTime();
    }
  });
});

describe("Share this space is its own switch", () => {
  test("off by default: its paths are any unknown plan path's 404, the settings answer is unchanged, nothing is written", async () => {
    historyFixture();
    const { list, capability } = capabilityWorld({ fixed: true });
    await capability.sync();
    const id = createPlanStore({ dataDir }).list()[0]!.id;
    const before = files();
    for (const [method, tail] of [["GET", ""], ["POST", ""], ["POST", "/keep"], ["POST", "/delete"]] as const) {
      const answer = await route(list, method, `/api/plans/${id}/share${tail}`, method === "POST" ? {} : undefined);
      expect([tail, answer?.status]).toEqual([tail, 404]);
    }
    expect(capabilitiesWire(list)).toEqual({ plans: { on: true } });
    expect(files()).toEqual(before);
  });

  test("on: the status answers the owner's window only, the settings say so, and PLANNOTATOR_SHARE=disabled turns it off", async () => {
    historyFixture();
    const { list, capability } = capabilityWorld({ fixed: true, shareFixed: true });
    await capability.sync();
    const id = createPlanStore({ dataDir }).list()[0]!.id;
    const answer = await route(list, "GET", `/api/plans/${id}/share`);
    expect(answer?.status).toBe(200);
    expect(await answer!.json()).toMatchObject({ phase: "none", link: null, signed_in: false });
    // Going down with the Inbox: nothing of a share is left going.
    capability.stopped!();
    expect(capability.shares().running(id)).toBeNull();
    expect(capabilitiesWire(list)).toEqual({ plans: { on: true, share: true } });
    expect((await route(list, "GET", `/api/plans/${id}/share`, undefined, { ...owner, local: false }))?.status).toBe(404);
    expect((await route(list, "POST", `/api/plans/${id}/share`, { serverSession: "another-page" }))?.status).toBe(409);
    // The real switch: config.json, and the one off switch every share has.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxPlans: true, inboxSpaceShare: true }));
    const real = createPlansCapability({ dataDir, changed: () => {} });
    expect(real.settingsWire!()).toEqual({ plans: { on: true, share: true } });
    const was = process.env.PLANNOTATOR_SHARE;
    process.env.PLANNOTATOR_SHARE = "disabled";
    try {
      expect(real.settingsWire!()).toEqual({ plans: { on: true } });
      expect((await routeInboxCapabilities([real], request("GET", `/api/plans/${id}/share`), new URL(`http://127.0.0.1:1/api/plans/${id}/share`), owner))?.status).toBe(404);
    } finally {
      if (was === undefined) delete process.env.PLANNOTATOR_SHARE;
      else process.env.PLANNOTATOR_SHARE = was;
    }
  });
});

describe("Plans' settings switch", () => {
  test("validated before any save; saved, answered and heard by every window; on starts the import", async () => {
    historyFixture();
    const { list, capability, changed } = capabilityWorld();
    expect(namesInboxCapability(list, { theme: "dark" })).toBe(false);
    expect(namesInboxCapability(list, { plans: { on: true } })).toBe(true);
    for (const bad of [true, { on: "yes" }, { on: true, extra: 1 }, null]) {
      expect(() => checkInboxCapabilities(list, { plans: bad })).toThrow("plans: { on: boolean }.");
    }
    expect(existsSync(join(dataDir, "config.json"))).toBe(false);

    expect(answerInboxCapabilities(list, { plans: { on: true } })).toEqual({ plans: { on: true } });
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxPlans).toBe(true);
    expect(changed()).toBe(1);
    expect(capabilitiesWire(list)).toEqual({ plans: { on: true } });
    await capability.importing();
    expect(createPlanStore({ dataDir }).list()).toHaveLength(1);

    // Off: answered to the save that turned it off, then absent; the library stays.
    expect(answerInboxCapabilities(list, { plans: { on: false } })).toEqual({ plans: { on: false } });
    expect(capabilitiesWire(list)).toEqual({});
    expect(changed()).toBe(2);
    expect(statSync(join(dataDir, "plan-library")).isDirectory()).toBe(true);
    expect((await route(list, "GET", "/api/plans"))?.status).toBe(404);
  });

  test("every open window hears it: the capabilities frame names Plans while on, and off only on the change", async () => {
    historyFixture();
    const { list, capability, changed } = capabilityWorld();
    // Off and unchanged: a frame for another switch names nothing of Plans.
    expect(capabilitiesFrame(list, false)).toEqual({});
    // Saved on (what `plannotator plans` posts to a running Inbox): the windows are told, and the frame says so.
    answerInboxCapabilities(list, { plans: { on: true } });
    expect(changed()).toBe(1);
    expect(capabilitiesFrame(list, true)).toEqual({ plans: { on: true } });
    expect(capabilitiesFrame(list, false)).toEqual({ plans: { on: true } });
    await capability.importing();
    // Saved off (`plannotator plans off`): told again; that frame says off, a later frame for another switch nothing.
    answerInboxCapabilities(list, { plans: { on: false } });
    expect(changed()).toBe(2);
    expect(capabilitiesFrame(list, true)).toEqual({ plans: { on: false } });
    expect(capabilitiesFrame(list, false)).toEqual({});
  });

  test("a window the routes do not answer (a phone, a linked device) is never told of Plans, so it shows no dead row", async () => {
    historyFixture();
    const { list, capability } = capabilityWorld();
    answerInboxCapabilities(list, { plans: { on: true } });
    await capability.importing();
    expect(capabilitiesWire(list, true)).toEqual({ plans: { on: true } });
    expect(capabilitiesWire(list, false)).toEqual({});
    expect(capabilitiesFrame(list, true, false)).toEqual({});
    expect(capabilitiesFrame(list, false, false)).toEqual({});
    // The same windows the routes refuse.
    expect((await route(list, "GET", "/api/plans", undefined, { ...owner, local: false }))?.status).toBe(404);
    answerInboxCapabilities(list, { plans: { on: false } });
    expect(capabilitiesFrame(list, true, false)).toEqual({});
  });

  test("started while on: the import runs once the Inbox is up", async () => {
    historyFixture();
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxPlans: true }));
    const { list, capability } = capabilityWorld();
    startInboxCapabilities(list);
    for (let i = 0; i < 50 && !capability.importing(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await capability.importing();
    const store: PlanStore = createPlanStore({ dataDir });
    expect(store.list().map((p) => p.name)).toEqual(["Auth refactor"]);
  });
});
