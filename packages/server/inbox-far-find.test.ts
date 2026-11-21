/**
 * An agent finds threads on a linked machine (inbox-machine-agent-find.ts, inbox-far-find.ts, inbox-mcp-far-find.ts):
 * two stores standing for two linked Inboxes, each door's `agent-search` and `agent-threads` answered in process behind
 * a stand-in link. What regresses: far rows missing from search or the list, unmarked, out of order or past `limit`;
 * "this project" that misses the same repository at another path, or takes a different one with the same folder name;
 * a machine asleep, slow or older that hangs the agent or says nothing; a search or list that writes anything on
 * either computer; a paired cloud agent left with this computer's threads only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { InboxSearchIndex } from "@plannotator/shared/inbox/search";
import { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxProject } from "@plannotator/core/inbox-types";
import { doorRouteOf } from "./inbox-devices";
import { agentSearchDoorAnswer, agentThreadsDoorAnswer } from "./inbox-far-find";
import { agentReadDoorAnswer } from "./inbox-far-read";
import { createMachineAgentFind, FAR_FIND_WORDS, farProjectMatches } from "./inbox-machine-agent-find";
import { createMachineAgentRead } from "./inbox-machine-agent-read";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import type { PeerLink } from "./inbox-peer-link";

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, any> };
type Tool = { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Result> };

const roots: string[] = [];
let savedDataDir: string | undefined;
let dataDir = "";
beforeAll(() => {
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-far-find-data-")));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterAll(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]));
}
const folderHashes = (dir: string) => Object.fromEntries(filesUnder(dir).map((file) => [file, sha(readFileSync(join(dir, file)))]));

/**
 * One computer: its store, its project folders (each with the git remote this computer knows for it, or none), its
 * search index and its MCP tools. Folders are made on disk; a project only once a thread is written there.
 */
function machine(name: string, folders: Record<string, string | null>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `plannotator-far-find-${name}-`)));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const remotes = new Map<string, string | null>();
  for (const [folder, remote] of Object.entries(folders)) {
    mkdirSync(join(root, folder), { recursive: true });
    remotes.set(join(root, folder), remote);
  }
  const index = new InboxSearchIndex(store);
  const rootOf = (path: string) => ({ root: path, name: basename(path), folder: path, settled: true, worktree: null });
  const context = {
    store,
    baseUrl: () => `http://localhost:${name.length}/`,
    resolveProject: async (path: string) => store.projectByRoot(path) ?? store.ensureProject({ name: basename(path), root: path }),
    projectRootOf: async (path: string) => rootOf(path),
    findProjects: async (path: string) => ({ projects: [store.projectByRoot(path)].filter((p): p is InboxProject => !!p), unresolved: false }),
    projectRemoteKey: async (path: string) => remotes.get(path) ?? null,
    searchIndex: index,
  } as unknown as InboxMcpContext;
  const tools = () => (createInboxMcpServer(context) as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  const folder = (f: string) => join(root, f);
  return { name, root, store, index, context, tools, folder, remotes };
}
type Machine = ReturnType<typeof machine>;

/** A thread an agent there started in `folder`, and the person's reply. Each a few ms apart, so the order is the time's. */
async function thread(m: Machine, folder: string, subject: string, body: string) {
  await Bun.sleep(5);
  const sent = await m.tools().send_message!.handler({ project_path: m.folder(folder), agent_session: "ses_builder", agent_host: "claude-code", agent_name: "Builder", subject, body }, {});
  expect(sent.isError).toBeUndefined();
  const id = String(sent.structuredContent!.thread_id);
  m.store.sendReply(id, { words: `Noted: ${subject}.`, idempotency_key: `reply-${id}` });
  return id;
}

/** A stand-in link to `far`: its door's agent routes answered in process. */
function linkTo(far: Machine, options: { state?: string; marks?: string[]; request?: PeerLink["request"] } = {}): PeerLink & { asks: string[] } {
  const asks: string[] = [];
  const host = { store: far.store, searchIndex: far.index, remoteKeyOf: (root: string) => far.remotes.get(root) ?? null };
  const door = async (route: string, search: string): Promise<Response> => {
    asks.push(route);
    const url = new URL(`http://door.local/api/inbox/device/${route}${search}`);
    if (route === "agent-search") return agentSearchDoorAnswer(host, url);
    if (route === "agent-threads") return agentThreadsDoorAnswer(host, url);
    if (route === "agent-read") return agentReadDoorAnswer({ store: far.store, stepsOn: () => false }, url);
    return Response.json({ error: "Not a door route.", code: "device_route_not_found" }, { status: 404 });
  };
  return {
    id: `ibx_${far.name.toUpperCase().padEnd(26, "0").replace(/[ILOU]/g, "0")}`,
    state: options.state ?? "online",
    list: { rows: [], marks: options.marks ?? ["agent-read", "agent-search"] },
    request: options.request ?? ((route: string, search: string) => door(route, search)),
    asks,
  } as unknown as PeerLink & { asks: string[] };
}

/** This computer's tools, finding and reading through `peers`. */
function linked(here: Machine, peers: PeerLink[], waitMs?: number) {
  const names = Object.fromEntries(peers.map((p) => [p.id, p.id.startsWith("ibx_M0N") ? "Mini" : "Studio"]));
  const nameOf = (id: string) => names[id] ?? "A linked machine";
  const find = createMachineAgentFind({ peers: () => peers, nameOf, ...(waitMs ? { waitMs } : {}) });
  here.context.findOnMachines = () => find;
  here.context.readOnMachine = createMachineAgentRead({ peers: () => peers, nameOf, ...(waitMs ? { waitMs } : {}) }).readThread;
  return here.tools();
}

describe("search across linked machines", () => {
  test("one list ranked across both computers, cut to limit, each far row marked with its computer, both ways", async () => {
    const studio = machine("Studio", { ledger: "github.com/acme/ledger" });
    const mini = machine("Mini", { ledger: "github.com/acme/ledger" });
    const oldHere = await thread(studio, "ledger", "Old", "the migration of rates");
    const there = await thread(mini, "ledger", "Schema", "the migration of tables");
    const newHere = await thread(studio, "ledger", "New", "the migration of users");
    await Promise.all([studio.index.ensureBuilt(), mini.index.ensureBuilt()]);
    const tools = linked(studio, [linkTo(mini)]);
    const found = await tools.search!.handler({ query: "migration", project_path: studio.folder("ledger") }, {});
    const results = found.structuredContent!.results as { thread_id: string; machine?: { name: string } }[];
    expect(results.map((r) => r.thread_id)).toEqual([newHere, there, oldHere]);
    expect(results.map((r) => r.machine?.name ?? null)).toEqual([null, "Mini", null]);
    expect(found.structuredContent!.total).toBe(3);
    const text = found.content[0]!.text;
    expect(text).toContain(`in thread ${there} ("Schema") · on Mini · Builder`);
    expect(text).not.toContain(`in thread ${newHere} ("New") · on`);

    const two = await tools.search!.handler({ query: "migration", project_path: studio.folder("ledger"), limit: 2 }, {});
    expect((two.structuredContent!.results as { thread_id: string }[]).map((r) => r.thread_id)).toEqual([newHere, there]);
    expect(two.content[0]!.text).toContain("3 messages match \"migration\" in ledger; the best 2:");

    // The other way: Mini's agent finds Studio's.
    const back = linked(mini, [linkTo(studio)]);
    const fromMini = await back.search!.handler({ query: "users", project_path: mini.folder("ledger") }, {});
    expect(fromMini.structuredContent!.results).toMatchObject([{ thread_id: newHere, machine: { name: "Studio" } }]);
  });

  test("this project there is the one with the same git remote, else the same folder name; all_projects is every project", async () => {
    const studio = machine("Studio", { ledger: "github.com/acme/ledger", fresh: "github.com/acme/fresh" });
    const mini = machine("Mini", { "ledger-main": "github.com/acme/ledger", ledger: "github.com/other/ledger", notes: null, fresh: null, misc: null });
    await thread(studio, "ledger", "Here", "deploy plan");
    const sameRemote = await thread(mini, "ledger-main", "Same repo, other folder", "deploy plan");
    const otherRepo = await thread(mini, "ledger", "Another repo, same folder name", "deploy plan");
    const byName = await thread(mini, "fresh", "No remote there, same folder name", "deploy plan");
    const unrelated = await thread(mini, "misc", "Another project", "deploy plan");
    await Promise.all([studio.index.ensureBuilt(), mini.index.ensureBuilt()]);
    const tools = linked(studio, [linkTo(mini)]);
    const ids = async (input: Record<string, unknown>) => ((await tools.search!.handler({ query: "deploy", ...input }, {})).structuredContent!.results as { thread_id: string; machine?: unknown }[]).filter((r) => r.machine).map((r) => r.thread_id);
    expect(await ids({ project_path: studio.folder("ledger") })).toEqual([sameRemote]);
    // A folder with no thread here yet: its name and remote still find the same project there.
    expect(await ids({ project_path: studio.folder("fresh") })).toEqual([byName]);
    expect((await ids({ all_projects: true })).sort()).toEqual([sameRemote, otherRepo, byName, unrelated].sort());
    const all = await tools.search!.handler({ query: "deploy", all_projects: true }, {});
    expect(all.content[0]!.text).toContain(`· on Mini · Builder`);
    expect(all.content[0]!.text).toMatch(/· project ledger-main ·/);

    // The list maps the same way.
    const list = await tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {});
    expect((list.structuredContent!.threads as { thread_id: string; machine?: unknown }[]).filter((t) => t.machine).map((t) => t.thread_id)).toEqual([sameRemote]);
  });

  test("the rule itself: two known remotes decide; a missing one falls back to the folder name", () => {
    expect(farProjectMatches([{ name: "api", remote: "github.com/a/api" }], { name: "api-2", remote: "github.com/a/api" })).toBe(true);
    expect(farProjectMatches([{ name: "api", remote: "github.com/a/api" }], { name: "api", remote: "github.com/b/api" })).toBe(false);
    expect(farProjectMatches([{ name: "api", remote: "github.com/a/api" }], { name: "API", remote: null })).toBe(true);
    expect(farProjectMatches([{ name: "api", remote: null }], { name: "api", remote: "github.com/b/api" })).toBe(true);
    expect(farProjectMatches([{ name: "api", remote: null }], { name: "web", remote: null })).toBe(false);
  });
});

describe("read_thread's list across linked machines", () => {
  test("every agent's threads there, newest activity first among this computer's, marked; limit and include_resolved hold", async () => {
    const studio = machine("Studio", { ledger: "github.com/acme/ledger" });
    const mini = machine("Mini", { ledger: "github.com/acme/ledger" });
    const a = await thread(studio, "ledger", "First here", "one");
    const b = await thread(mini, "ledger", "Migration there", "two");
    const c = await thread(studio, "ledger", "Second here", "three");
    const archived = await thread(mini, "ledger", "Archived there", "four");
    mini.store.resolveThread(archived, true);
    const link = linkTo(mini);
    const tools = linked(studio, [link]);
    const list = await tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {});
    expect((list.structuredContent!.threads as { thread_id: string }[]).map((t) => t.thread_id)).toEqual([c, b, a]);
    expect(list.structuredContent!.total).toBe(3);
    expect(list.content[0]!.text).toContain(`- ${b} · on Mini · "Migration there"`);
    const withResolved = await tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone", include_resolved: true, limit: 2 }, {});
    expect((withResolved.structuredContent!.threads as { thread_id: string }[]).map((t) => t.thread_id)).toEqual([archived, c]);
    expect(withResolved.content[0]!.text).toStartWith("4 threads in ledger, showing 2.");

    // "me": a session here never sent in a thread there, so no machine is asked.
    link.asks.length = 0;
    const mine = await tools.read_thread!.handler({ project_path: studio.folder("ledger"), agent_session: "ses_builder" }, {});
    expect((mine.structuredContent!.threads as { thread_id: string }[]).map((t) => t.thread_id)).toEqual([c, a]);
    expect(link.asks).toEqual([]);

    // Found in the list, then read by its id there.
    const read = await tools.read_thread!.handler({ thread_id: b }, {});
    expect(read.content[0]!.text).toStartWith("This thread is on Mini.");
  });
});

describe("a machine that cannot answer", () => {
  test("asleep, older, or a door without the route: this computer's rows at once and one line naming it", async () => {
    const studio = machine("Studio", { ledger: null });
    const mini = machine("Mini", { ledger: null });
    const here = await thread(studio, "ledger", "Here", "rollout");
    await thread(mini, "ledger", "There", "rollout");
    await Promise.all([studio.index.ensureBuilt(), mini.index.ensureBuilt()]);
    const cases: [PeerLink & { asks: string[] }, "Away" | "Older"][] = [
      [linkTo(mini, { state: "offline" }), "Away"],
      [linkTo(mini, { state: "connecting" }), "Away"],
      [linkTo(mini, { marks: ["agent-read"] }), "Older"],
      [linkTo(mini, { request: async () => Response.json({ code: "device_route_not_found", error: "Not a phone route." }, { status: 404 }) }), "Older"],
      [linkTo(mini, { request: async () => Response.json({ code: "internal_error" }, { status: 502 }) }), "Away"],
    ];
    for (const [link, kind] of cases) {
      const tools = linked(studio, [link]);
      const found = await tools.search!.handler({ query: "rollout", project_path: studio.folder("ledger") }, {});
      expect((found.structuredContent!.results as { thread_id: string }[]).map((r) => r.thread_id)).toEqual([here]);
      expect(found.content[0]!.text).toEndWith(`\n${FAR_FIND_WORDS[`search${kind}`]("Mini")}`);
      const list = await tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {});
      expect((list.structuredContent!.threads as { thread_id: string }[]).map((t) => t.thread_id)).toEqual([here]);
      expect(list.content[0]!.text).toEndWith(`\n${FAR_FIND_WORDS[`list${kind}`]("Mini")}`);
    }
  });

  test("an online machine that never answers, or stalls mid-answer, costs at most the bounded wait", async () => {
    const studio = machine("Studio", { ledger: null });
    const mini = machine("Mini", { ledger: null });
    const here = await thread(studio, "ledger", "Here", "rollout");
    await studio.index.ensureBuilt();
    const never = linkTo(mini, { request: (_route, _search, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))) });
    const stalls = linkTo(mini, {
      request: async (_route, _search, init) =>
        new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"total":1,"results":[')); init.signal?.addEventListener("abort", () => c.error(new Error("aborted"))); } }), { status: 200 }),
    });
    for (const link of [never, stalls]) {
      const tools = linked(studio, [link], 80);
      const started = Date.now();
      const found = await tools.search!.handler({ query: "rollout", project_path: studio.folder("ledger") }, {});
      const list = await tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {});
      expect(Date.now() - started).toBeLessThan(1_000);
      expect((found.structuredContent!.results as { thread_id: string }[]).map((r) => r.thread_id)).toEqual([here]);
      expect(found.content[0]!.text).toContain(FAR_FIND_WORDS.searchAway("Mini"));
      expect(list.content[0]!.text).toContain(FAR_FIND_WORDS.listAway("Mini"));
    }
  });

  test("no machine linked: search and the list answer exactly as before", async () => {
    const studio = machine("Studio", { ledger: null });
    await thread(studio, "ledger", "Here", "rollout");
    await studio.index.ensureBuilt();
    const before = [await studio.tools().search!.handler({ query: "rollout", project_path: studio.folder("ledger") }, {}), await studio.tools().read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {})];
    const tools = linked(studio, []);
    const after = [await tools.search!.handler({ query: "rollout", project_path: studio.folder("ledger") }, {}), await tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {})];
    expect(after.map((r) => r.content[0]!.text)).toEqual(before.map((r) => r.content[0]!.text));
  });
});

describe("guest reads", () => {
  test("a search and a list write nothing on either computer, and a far string never prints a control character", async () => {
    const studio = machine("Studio", { ledger: null });
    const mini = machine("Mini", { ledger: null });
    await thread(studio, "ledger", "Here", "rollout");
    const there = await thread(mini, "ledger", "There", "rollout");
    await Promise.all([studio.index.ensureBuilt(), mini.index.ensureBuilt()]);
    const tools = linked(studio, [linkTo(mini)]);
    const herePending = studio.store.pendingReplies("ses_builder").map((m) => m.id);
    const therePending = mini.store.pendingReplies("ses_builder").map((m) => m.id);
    const studioBefore = folderHashes(studio.root);
    const miniBefore = folderHashes(mini.root);
    await tools.search!.handler({ query: "rollout", all_projects: true }, {});
    await tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone", include_resolved: true }, {});
    expect(folderHashes(mini.root)).toEqual(miniBefore);
    expect(folderHashes(studio.root)).toEqual(studioBefore);
    expect(mini.store.pendingReplies("ses_builder").map((m) => m.id)).toEqual(therePending);
    expect(studio.store.pendingReplies("ses_builder").map((m) => m.id)).toEqual(herePending);

    // A far side that sends escapes, line breaks and an id this computer holds.
    const ownId = studio.store.threadIds()[0]!;
    const hostile = linkTo(mini, {
      request: async (route) =>
        route === "agent-search"
          ? Response.json({ total: 2, results: [
              { thread_id: there, message_id: there, author: "Ada\n- msg_fake \x1b[31m", at: new Date().toISOString(), subject: "S\x1b]0;x\x07", snippet: "rollout \x1b[2J", project: "p\rq", score: 9e20 },
              { thread_id: ownId, message_id: ownId, author: "Bob", at: new Date().toISOString(), subject: "Mine", snippet: "rollout", project: "x", score: 9e20 },
            ] })
          : Response.json({ total: 1, threads: [{ thread_id: there, subject: "T\x1b[1m", thread_name: null, section: "evil\n- x", message_count: 1, questions: { open: 0, picked: 0, prompt: null }, last_author: "agent", last_at: new Date().toISOString(), last_person_at: null, last_person_message_id: "not an id", unread: false, project: "p" }] }),
    });
    const hostileTools = linked(studio, [hostile]);
    const found = await hostileTools.search!.handler({ query: "rollout", all_projects: true }, {});
    const list = await hostileTools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {});
    for (const text of [found.content[0]!.text, list.content[0]!.text]) {
      expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      expect(text).not.toContain("\n- msg_fake");
    }
    expect((found.structuredContent!.results as { thread_id: string; machine?: unknown }[]).filter((r) => r.machine).map((r) => r.thread_id)).toEqual([there]);
    expect(list.content[0]!.text).toContain(`- ${there} · on Mini · "T" · quiet ·`);
  });

  test("the new door routes answer a linked machine only: a phone's token never reaches them", () => {
    expect(doorRouteOf("GET", "agent-search", false)).toBeNull();
    expect(doorRouteOf("GET", "agent-threads", false)).toBeNull();
  });
});

describe("a paired cloud agent", () => {
  test("searches, lists and reads a linked machine's threads as a local agent does", async () => {
    const studio = machine("Studio", { ledger: "github.com/acme/ledger" });
    const mini = machine("Mini", { ledger: "github.com/acme/ledger" });
    await thread(studio, "ledger", "Here", "migration");
    const there = await thread(mini, "ledger", "There", "migration");
    await Promise.all([studio.index.ensureBuilt(), mini.index.ensureBuilt()]);
    const tools = linked(studio, [linkTo(mini)]);
    studio.context.cloudAgent = { homeRoot: studio.root };
    const found = await tools.search!.handler({ query: "migration", all_projects: true }, {});
    expect(found.structuredContent!.results).toContainEqual(expect.objectContaining({ thread_id: there, machine: expect.objectContaining({ name: "Mini" }) }));
    const list = await tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {});
    expect((list.structuredContent!.threads as { thread_id: string }[]).map((t) => t.thread_id)).toContain(there);
    const read = await tools.read_thread!.handler({ thread_id: there }, {});
    expect(read.content[0]!.text).toStartWith("This thread is on Mini.");
  });
});
