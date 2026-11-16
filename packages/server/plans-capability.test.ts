/**
 * Plans as an Inbox capability, in process through the capability seam (no Inbox started), on a scratch data dir.
 * What regresses if these fail:
 * - Off costs something: a `/api/plans` route answers, the library is opened or imported, a file appears under the
 *   data dir, the settings answer gains a key, plan review writes anything new, or Plans reaches the Inbox's agent
 *   tool text, its served tools, plan review, the Claude Code mod or Pi;
 * - on, a route is reachable from anywhere but the owner's window on this computer, another site reads a plan, or a
 *   POST from a stale page (another server session) records a look;
 * - the settings switch takes a malformed value, does not stick, or answers what it did not save;
 * - turning it on does not import the library, and two imports run at once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { answerInboxCapabilities, capabilitiesWire, checkInboxCapabilities, namesInboxCapability, routeInboxCapabilities, startInboxCapabilities, type InboxCapabilityGuard } from "./inbox-capability";
import { createPlansCapability } from "./plans-capability";
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

function capabilityWorld(options: { fixed?: boolean } = {}) {
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

  test("only the capability seam and the plans command reach Plans' modules: not plan review, the Inbox tool, the mod or Pi", () => {
    const root = resolve(import.meta.dir, "../..");
    const allowed = new Set([
      "packages/core/plans.ts",
      "packages/shared/plans/store.ts",
      "packages/shared/plans/import.ts",
      "packages/shared/plans/routes.ts",
      "packages/shared/plans/switch.ts",
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
          if (!allowed.has(rel) && reaches.test(readFileSync(path, "utf8"))) found.push(rel);
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
    const second = (await (await route(list, "GET", "/api/plans"))!.json()) as { plans: unknown[] };
    expect(second.plans).toHaveLength(1);
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
