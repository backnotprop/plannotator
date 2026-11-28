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
import { parseRemoteHost, parseRemoteUrl } from "@plannotator/shared/repo";
import { agentSearchDoorAnswer, agentThreadsDoorAnswer } from "./inbox-far-find";
import { agentReadDoorAnswer } from "./inbox-far-read";
import { createMachineAgentFind, FAR_FIND_WORDS, FAR_REMOTE_UNKNOWN, farProjectMatches, farRemoteKey, farRemoteOf, type FarRemote } from "./inbox-machine-agent-find";
import { createInboxRepoCache } from "./inbox-repos";
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
 * One computer: its store, its project folders (each with the git remote this computer knows for it, none, or
 * `FAR_REMOTE_UNKNOWN` while git has not said), its search index and its MCP tools. Folders are made on disk; a
 * project only once a thread is written there.
 */
function machine(name: string, folders: Record<string, FarRemote>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `plannotator-far-find-${name}-`)));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const remotes = new Map<string, FarRemote>();
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
    projectRemoteKey: async (path: string) => (remotes.has(path) ? remotes.get(path)! : null),
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
  const host = { store: far.store, searchIndex: far.index, remoteOf: async (root: string) => (far.remotes.has(root) ? far.remotes.get(root)! : null) };
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
    // The header names this project; a far row in another folder there names its own.
    const scoped = (await tools.search!.handler({ query: "deploy", project_path: studio.folder("ledger") }, {})).content[0]!.text;
    expect(scoped).toStartWith('2 messages match "deploy" in ledger:');
    expect(scoped).toContain(`in thread ${sameRemote} ("Same repo, other folder") · on Mini · Builder ·`);
    expect(scoped).toMatch(/· on Mini · Builder · [^\n]* · project ledger-main · /);
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

  test("the rule itself: two known remotes decide; none falls back to the folder name; unknown matches nothing", () => {
    expect(farProjectMatches([{ name: "api", remote: "github.com/a/api" }], { name: "api-2", remote: "github.com/a/api" })).toBe(true);
    expect(farProjectMatches([{ name: "api", remote: "github.com/a/api" }], { name: "api", remote: "github.com/b/api" })).toBe(false);
    expect(farProjectMatches([{ name: "api", remote: "github.com/a/api" }], { name: "API", remote: null })).toBe(true);
    expect(farProjectMatches([{ name: "api", remote: null }], { name: "api", remote: "github.com/b/api" })).toBe(true);
    expect(farProjectMatches([{ name: "api", remote: null }], { name: "web", remote: null })).toBe(false);
    // Not read yet, on either side: never the folder name (two different repositories may share it).
    expect(farProjectMatches([{ name: "api", remote: "github.com/a/api" }], { name: "api", remote: FAR_REMOTE_UNKNOWN })).toBe(false);
    expect(farProjectMatches([{ name: "api", remote: FAR_REMOTE_UNKNOWN }], { name: "api", remote: null })).toBe(false);
    expect(farProjectMatches([{ name: "api", remote: FAR_REMOTE_UNKNOWN }], { name: "api", remote: "github.com/a/api" })).toBe(false);
    // The same repository through an SSH host alias on one side: owner/repo decides.
    expect(farProjectMatches([{ name: "api", remote: "github-work/a/api" }], { name: "api", remote: "github.com/a/api" })).toBe(true);
    expect(farProjectMatches([{ name: "api", remote: "github-work/a/api" }], { name: "api", remote: "github.com/b/api" })).toBe(false);
  });

  test("the remote key: ssh and https forms, .git, case, ports and aliases give one owner/repo; a token is never in it", () => {
    const key = (url: string) => farRemoteKey({ display: parseRemoteUrl(url)!, host: parseRemoteHost(url) });
    const same = (a: string, b: string) => farProjectMatches([{ name: "x", remote: key(a) }], { name: "y", remote: key(b) });
    const ledger = "github.com/acme/ledger";
    for (const url of [
      "git@github.com:acme/ledger.git",
      "git@github.com:acme/ledger",
      "https://github.com/acme/ledger.git",
      "https://github.com/acme/ledger",
      "https://GitHub.com/Acme/Ledger.git",
      "ssh://git@github.com:22/acme/ledger.git",
      "ssh://git@github.com/acme/ledger",
      "https://github.com:443/acme/ledger.git",
      "https://x-access-token:ghp_SECRET123@github.com/acme/ledger.git",
      "https://ghp_SECRET123@github.com/acme/ledger",
    ]) {
      expect([url, key(url)]).toEqual([url, ledger]);
      expect(key(url)).not.toContain("SECRET");
    }
    // An SSH host alias (`Host github-work` in ~/.ssh/config): its own host, the same repository.
    expect(key("git@github-work:acme/ledger.git")).toBe("github-work/acme/ledger");
    expect(same("git@github-work:acme/ledger.git", "https://github.com/acme/ledger")).toBe(true);
    expect(same("git@github.com:acme/ledger.git", "https://github.com/acme/ledger")).toBe(true);
    expect(same("git@github.com:acme/ledger.git", "https://github.com/acme/ledger-2")).toBe(false);
    expect(same("git@github.com:acme/ledger.git", "https://github.com/other/ledger")).toBe(false);
    // A group's subgroups are part of the path.
    expect(key("https://gitlab.com/acme/tools/ledger.git")).toBe("gitlab.com/acme/tools/ledger");
    expect(same("https://gitlab.com/acme/tools/ledger.git", "https://gitlab.com/acme/ledger.git")).toBe(false);
    // A display that somehow kept a userinfo still never carries it.
    expect(farRemoteKey({ display: "user:tok@acme/ledger", host: "user:tok@github.com:22" })).toBe("github.com/acme/ledger");
    expect(farRemoteKey(null)).toBeNull();
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
    expect(list.content[0]!.text).toContain(`- ${there} · on Mini · in p · "T" · quiet ·`);
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

describe("a remote git has not named yet", () => {
  test("is unknown, never none: the cache's answer once read, git's within the wait, unknown past it", async () => {
    let release: (() => void) | null = null;
    const slow = createInboxRepoCache({ read: () => new Promise((resolve) => (release = () => resolve({ display: "acme/ledger", host: "github.com" }))) });
    expect(await farRemoteOf(slow, "/w/ledger", 30)).toBe(FAR_REMOTE_UNKNOWN);
    release!();
    await Bun.sleep(5);
    expect(await farRemoteOf(slow, "/w/ledger", 30)).toBe("github.com/acme/ledger");
    // Read and found none: none, so the folder name decides.
    const none = createInboxRepoCache({ read: async () => null });
    expect(await farRemoteOf(none, "/w/notes", 500)).toBeNull();
    // A git that answers inside the wait is waited for: a cold cache right after a restart still names it.
    const quick = createInboxRepoCache({ read: async () => (await Bun.sleep(20), { display: "acme/ledger", host: "github.com" }) });
    expect(await farRemoteOf(quick, "/w/ledger", 500)).toBe("github.com/acme/ledger");
  });

  test("right after a restart, ledger never matches the other computer's unrelated ledger, either way round", async () => {
    // Studio's ledger is github.com/acme/ledger; Mini's ledger is another repository, its remote not read yet there.
    const studio = machine("Studio", { ledger: "github.com/acme/ledger", notes: FAR_REMOTE_UNKNOWN });
    const mini = machine("Mini", { ledger: FAR_REMOTE_UNKNOWN, notes: null });
    await thread(studio, "ledger", "Here", "deploy plan");
    const unrelated = await thread(mini, "ledger", "Another ledger", "deploy plan");
    const notesThere = await thread(mini, "notes", "Notes there", "deploy plan");
    await Promise.all([studio.index.ensureBuilt(), mini.index.ensureBuilt()]);
    const tools = linked(studio, [linkTo(mini)]);
    const far = async (input: Record<string, unknown>) => ((await tools.search!.handler({ query: "deploy", ...input }, {})).structuredContent!.results as { thread_id: string; machine?: unknown }[]).filter((r) => r.machine).map((r) => r.thread_id);
    const farListed = async (folder: string) => ((await tools.read_thread!.handler({ project_path: studio.folder(folder), asked_by: "anyone" }, {})).structuredContent!.threads as { thread_id: string; machine?: unknown }[]).filter((t) => t.machine).map((t) => t.thread_id);
    // The far side's remote unknown: no match by folder name.
    expect(await far({ project_path: studio.folder("ledger") })).toEqual([]);
    expect(await farListed("ledger")).toEqual([]);
    // This side's remote unknown (git ran past its wait): the far "notes" with no remote is not taken by its name either.
    expect(await far({ project_path: studio.folder("notes") })).toEqual([]);
    expect(await farListed("notes")).toEqual([]);
    // all_projects is unaffected.
    expect((await far({ all_projects: true })).sort()).toEqual([unrelated, notesThere].sort());
  });

  test("the door with a cold repo cache: git that answers within the door's wait names it; one that does not is unknown", async () => {
    const mini = machine("Mini", { ledger: null });
    const there = await thread(mini, "ledger", "There", "deploy plan");
    await mini.index.ensureBuilt();
    const ask = (remote: string) => new URL(`http://door.local/api/inbox/device/agent-search?q=deploy&limit=10&scope=${encodeURIComponent(JSON.stringify([{ name: "ledger", remote }]))}`);
    const ids = async (response: Response) => ((await response.json()) as { results: { thread_id: string }[] }).results.map((r) => r.thread_id);
    // Mini's ledger is another repository; git has not answered when the ask comes.
    const never = createInboxRepoCache({ read: () => new Promise(() => {}) });
    const coldHost = { store: mini.store, searchIndex: mini.index, remoteOf: (root: string, waitMs: number) => farRemoteOf(never, root, waitMs) };
    const started = Date.now();
    expect(await ids(await agentSearchDoorAnswer(coldHost, ask("github.com/acme/ledger")))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_500);
    const threads = new URL(`http://door.local/api/inbox/device/agent-threads?limit=10&scope=${encodeURIComponent(JSON.stringify([{ name: "ledger", remote: "github.com/acme/ledger" }]))}`);
    expect(((await (await agentThreadsDoorAnswer(coldHost, threads)).json()) as { threads: unknown[] }).threads).toEqual([]);
    // Git answers fast on a cold cache: the same repository is found on the first ask, another one is not.
    const quick = createInboxRepoCache({ read: async () => (await Bun.sleep(10), { display: "acme/ledger", host: "github.com" }) });
    const quickHost = { store: mini.store, searchIndex: mini.index, remoteOf: (root: string, waitMs: number) => farRemoteOf(quick, root, waitMs) };
    expect(await ids(await agentSearchDoorAnswer(quickHost, ask("git-alias/acme/ledger")))).toEqual([there]);
    expect(await ids(await agentSearchDoorAnswer(quickHost, ask("github.com/someone/ledger")))).toEqual([]);
  });
});

describe("a machine that answered but could not search", () => {
  const indexing = () => Response.json({ code: "search_indexing", error: "The search index is still being built." }, { status: 503 });

  test("a search still being prepared there is asked again within the bound; still not ready, it says so", async () => {
    const studio = machine("Studio", { ledger: null });
    const mini = machine("Mini", { ledger: null });
    const here = await thread(studio, "ledger", "Here", "rollout");
    const there = await thread(mini, "ledger", "There", "rollout");
    await Promise.all([studio.index.ensureBuilt(), mini.index.ensureBuilt()]);
    let first = true;
    const once = linkTo(mini);
    const real = once.request;
    once.request = (async (route: string, search: string, init: never) => (route === "agent-search" && first ? ((first = false), indexing()) : real(route, search, init))) as PeerLink["request"];
    const found = await linked(studio, [once]).search!.handler({ query: "rollout", project_path: studio.folder("ledger") }, {});
    expect((found.structuredContent!.results as { thread_id: string }[]).map((r) => r.thread_id).sort()).toEqual([here, there].sort());
    expect(found.structuredContent!.not_searched).toBeUndefined();

    let asked = 0;
    const always = linkTo(mini, { request: async (route) => (route === "agent-search" ? (asked++, indexing()) : Response.json({ total: 0, threads: [] })) });
    const started = Date.now();
    const still = await linked(studio, [always], 1_200).search!.handler({ query: "rollout", project_path: studio.folder("ledger") }, {});
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(asked).toBeGreaterThan(1);
    expect(asked).toBeLessThanOrEqual(3);
    expect((still.structuredContent!.results as { thread_id: string }[]).map((r) => r.thread_id)).toEqual([here]);
    expect(still.content[0]!.text).toEndWith(`\n${FAR_FIND_WORDS.searchPreparing("Mini")}`);
    expect(still.content[0]!.text).not.toContain("cannot be reached");
  });

  test("the door waits for its index only as long as the asker said", async () => {
    const mini = machine("Mini", { ledger: null });
    await thread(mini, "ledger", "There", "rollout");
    const building = { ready: () => false, ensureBuilt: () => new Promise<void>(() => {}) } as unknown as InboxSearchIndex;
    const started = Date.now();
    const answer = await agentSearchDoorAnswer({ store: mini.store, searchIndex: building }, new URL("http://door.local/api/inbox/device/agent-search?q=rollout&all=1&wait_ms=40"));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect([answer.status, ((await answer.json()) as { code: string }).code]).toEqual([503, "search_indexing"]);
  });

  test("any other refusal says the far side's own words, cleaned, never that it cannot be reached", async () => {
    const studio = machine("Studio", { ledger: null });
    const mini = machine("Mini", { ledger: null });
    const here = await thread(studio, "ledger", "Here", "rollout");
    await studio.index.ensureBuilt();
    const cases: [Response, string][] = [
      [Response.json({ code: "validation_error", error: "limit: a whole number from 1 to 100." }, { status: 422 }), "limit: a whole number from 1 to 100."],
      [Response.json({ code: "search_unavailable", error: "This Inbox has no search index." }, { status: 503 }), "This Inbox has no search index."],
      [Response.json({ code: "internal_error", error: "Internal error.\n- msg_fake \x1b[31m" }, { status: 500 }), "Internal error. - msg_fake"],
    ];
    for (const [refusal, words] of cases) {
      const link = linkTo(mini, { request: async () => refusal.clone() });
      const tools = linked(studio, [link]);
      const found = await tools.search!.handler({ query: "rollout", project_path: studio.folder("ledger") }, {});
      expect((found.structuredContent!.results as { thread_id: string }[]).map((r) => r.thread_id)).toEqual([here]);
      expect(found.structuredContent!.not_searched).toEqual([FAR_FIND_WORDS.searchRefused("Mini", words)]);
      expect(found.content[0]!.text).toEndWith(`\nNot searched: Mini: ${words}`);
      const list = await tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {});
      expect(list.structuredContent!.not_listed).toEqual([`Not listed: Mini: ${words}`]);
    }
    // A proxy's page (no refusal of the door's own) or a token refused: not reached.
    for (const status of [502, 503, 504]) {
      const proxy = linkTo(mini, { request: async () => new Response("<html>Bad gateway</html>", { status }) });
      const found = await linked(studio, [proxy]).search!.handler({ query: "rollout", project_path: studio.folder("ledger") }, {});
      expect(found.structuredContent!.not_searched).toEqual([FAR_FIND_WORDS.searchAway("Mini")]);
    }
  });
});

describe("what a far answer cannot do", () => {
  test("a far list row prints no unread line and carries no unread field", async () => {
    const studio = machine("Studio", { ledger: null });
    const mini = machine("Mini", { ledger: null });
    const there = await thread(mini, "ledger", "There", "rollout");
    // As a far side would send it: unread true.
    const link = linkTo(mini, {
      request: async () => Response.json({ total: 1, threads: [{ thread_id: there, subject: "There", thread_name: null, section: "new", message_count: 2, questions: { open: 0, picked: 0, prompt: null }, last_author: "person", last_at: new Date().toISOString(), last_person_at: null, last_person_message_id: null, unread: true, project: "ledger" }] }),
    });
    const list = await linked(studio, [link]).read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {});
    const row = (list.structuredContent!.threads as Record<string, unknown>[]).find((t) => t.thread_id === there)!;
    expect(row).toBeDefined();
    expect("unread" in row).toBe(false);
    expect(list.content[0]!.text).not.toContain("unread");
    // The door sends none either.
    const door = await agentThreadsDoorAnswer({ store: mini.store }, new URL("http://door.local/api/inbox/device/agent-threads?all=1"));
    expect(((await door.json()) as { threads: Record<string, unknown>[] }).threads.every((t) => !("unread" in t))).toBe(true);
  });

  test("a hostile total is a count: never Infinity, never past a safe integer", async () => {
    const studio = machine("Studio", { ledger: null });
    const mini = machine("Mini", { ledger: null });
    await thread(studio, "ledger", "Here", "rollout");
    const there = await thread(mini, "ledger", "There", "rollout");
    await studio.index.ensureBuilt();
    const row = `{"thread_id":"${there}","message_id":"${there}","author":"Ada","at":"${new Date().toISOString()}","subject":"S","snippet":"rollout","project":"ledger","score":1}`;
    for (const total of ["1e400", "-5", "1e300", "2.5"]) {
      const link = linkTo(mini, {
        request: async (route) =>
          route === "agent-search"
            ? new Response(`{"total":${total},"results":[${row}]}`, { headers: { "content-type": "application/json" } })
            : new Response(`{"total":${total},"threads":[]}`, { headers: { "content-type": "application/json" } }),
      });
      const tools = linked(studio, [link]);
      const found = await tools.search!.handler({ query: "rollout", project_path: studio.folder("ledger") }, {});
      expect([total, found.structuredContent!.total]).toEqual([total, 2]);
      expect(found.content[0]!.text).toStartWith('2 messages match "rollout" in ledger:');
      const list = await tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {});
      expect([total, list.structuredContent!.total]).toEqual([total, 1]);
      expect(list.content[0]!.text).not.toContain("Infinity");
    }
  });

  test("an id two linked machines both claim is on neither, and a row repeated in one answer counts once", async () => {
    const studio = machine("Studio", { ledger: null });
    const mini = machine("Mini", { ledger: null });
    const box = machine("Box", { ledger: null });
    const here = await thread(studio, "ledger", "Here", "rollout");
    const claimed = await thread(mini, "ledger", "Claimed", "rollout");
    const onlyMini = await thread(mini, "ledger", "Only Mini", "rollout");
    await studio.index.ensureBuilt();
    const at = new Date().toISOString();
    const result = (id: string, score: number) => ({ thread_id: id, message_id: id, author: "Ada", at, subject: "S", snippet: "rollout", project: "ledger", score });
    const listRow = (id: string) => ({ thread_id: id, subject: "S", thread_name: null, section: "quiet", message_count: 1, questions: { open: 0, picked: 0, prompt: null }, last_author: "agent", last_at: at, last_person_at: null, last_person_message_id: null, project: "ledger" });
    const answering = (results: unknown[], threads: unknown[]) => async (route: string) => (route === "agent-search" ? Response.json({ total: results.length, results }) : Response.json({ total: threads.length, threads }));
    const a = linkTo(mini, { request: answering([result(claimed, 50), ...Array(5).fill(result(onlyMini, 40))], [listRow(claimed), ...Array(5).fill(listRow(onlyMini))]) });
    const b = linkTo(box, { request: answering([result(claimed, 50)], [listRow(claimed)]) });
    const tools = linked(studio, [a, b]);
    const found = await tools.search!.handler({ query: "rollout", project_path: studio.folder("ledger"), limit: 3 }, {});
    expect((found.structuredContent!.results as { thread_id: string }[]).map((r) => r.thread_id).sort()).toEqual([onlyMini, here].sort());
    expect(found.content[0]!.text).not.toContain(claimed);
    const list = await tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone", limit: 3 }, {});
    expect((list.structuredContent!.threads as { thread_id: string }[]).map((t) => t.thread_id).sort()).toEqual([onlyMini, here].sort());
    expect(list.content[0]!.text).not.toContain(claimed);
  });
});

describe("the bound is the whole wait", () => {
  test("every machine asleep: no project root and no git is asked for", async () => {
    const studio = machine("Studio", { ledger: null });
    const mini = machine("Mini", { ledger: null });
    const here = await thread(studio, "ledger", "Here", "rollout");
    await studio.index.ensureBuilt();
    let asked = 0;
    const rootOf = studio.context.projectRootOf!;
    studio.context.projectRootOf = (async (path: string) => (asked++, rootOf(path))) as typeof rootOf;
    studio.context.projectRemoteKey = async () => (asked++, null);
    const tools = linked(studio, [linkTo(mini, { state: "offline" })]);
    const found = await tools.search!.handler({ query: "rollout", project_path: studio.folder("ledger") }, {});
    const list = await tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {});
    expect(asked).toBe(0);
    expect((found.structuredContent!.results as { thread_id: string }[]).map((r) => r.thread_id)).toEqual([here]);
    expect(found.structuredContent!.not_searched).toEqual([FAR_FIND_WORDS.searchAway("Mini")]);
    expect(list.structuredContent!.not_listed).toEqual([FAR_FIND_WORDS.listAway("Mini")]);
  });

  test("git that never answers and a machine that never answers together cost one bound, not two", async () => {
    const studio = machine("Studio", { ledger: null });
    const mini = machine("Mini", { ledger: null });
    const here = await thread(studio, "ledger", "Here", "rollout");
    await studio.index.ensureBuilt();
    studio.context.projectRemoteKey = () => new Promise(() => {});
    studio.context.projectRootOf = (() => new Promise(() => {})) as never;
    const never = linkTo(mini, { request: (_route, _search, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))) });
    const tools = linked(studio, [never], 400);
    for (const run of [() => tools.search!.handler({ query: "rollout", project_path: studio.folder("ledger") }, {}), () => tools.read_thread!.handler({ project_path: studio.folder("ledger"), asked_by: "anyone" }, {})]) {
      const started = Date.now();
      const answer = await run();
      expect(Date.now() - started).toBeLessThan(700);
      expect(answer.content[0]!.text).toContain(here);
      expect(answer.content[0]!.text).toContain("cannot be reached now");
    }
  });
});

describe("this computer's own rows, with no far rows merged", () => {
  test("two projects in scope (the one an older Inbox kept for its worktree): the order and words main gave", async () => {
    const studio = machine("Studio", { ledger: null, "ledger-old": null });
    const older = await thread(studio, "ledger", "Plain", "a rollout note");
    const stronger = await thread(studio, "ledger-old", "Rollout rollout", "rollout rollout rollout plan");
    await studio.index.ensureBuilt();
    const projects = [studio.store.projectByRoot(studio.folder("ledger"))!, studio.store.projectByRoot(studio.folder("ledger-old"))!];
    studio.context.findProjects = (async () => ({ projects, unresolved: false })) as never;
    // Main's search: project by project, in the scope's order, then cut.
    const expected = projects.flatMap((p) => (studio.index.search({ q: "rollout", project: p.id, group: "messages", offset: 0, limit: 10 }).groups?.messages ?? []).map((r) => (r as { thread_id: string }).thread_id));
    expect(expected[0]).toBe(older);
    expect(expected.slice(1).every((id) => id === stronger)).toBe(true);
    // The ranks alone would put the stronger match first: this test tells the two orders apart.
    const scores = projects.map((p) => studio.index.search({ q: "rollout", project: p.id, group: "messages", offset: 0, limit: 10, scores: true }).scores?.messages?.[0] ?? 0);
    expect(scores[1]!).toBeGreaterThan(scores[0]!);
    const ask = { query: "rollout", project_path: studio.folder("ledger") };
    const alone = await studio.tools().search!.handler(ask, {});
    expect((alone.structuredContent!.results as { thread_id: string }[]).map((r) => r.thread_id)).toEqual(expected);
    // A machine linked but asleep (no far rows): the same rows in the same order, then its line.
    const asleep = await linked(studio, [linkTo(machine("Mini", { ledger: null }), { state: "offline" })]).search!.handler(ask, {});
    expect(asleep.content[0]!.text).toBe(`${alone.content[0]!.text}\n${FAR_FIND_WORDS.searchAway("Mini")}`);
    // None linked at all: byte for byte.
    const none = await linked(studio, []).search!.handler(ask, {});
    expect(none.content[0]!.text).toBe(alone.content[0]!.text);
    expect(none.structuredContent).toEqual(alone.structuredContent);
  });
});

describe("parity: a guest from a linked machine reaches exactly what the far side's own agent sees", () => {
  test("search all_projects and the anyone list, over an archived, a snoozed, a drafted and a deleted thread", async () => {
    const studio = machine("Studio", { ledger: null });
    const mini = machine("Mini", { ledger: null, notes: null });
    await thread(mini, "ledger", "Open", "zephyr open");
    const archived = await thread(mini, "ledger", "Archived", "zephyr archived");
    mini.store.resolveThread(archived, true);
    const snoozed = await thread(mini, "notes", "Snoozed", "zephyr snoozed");
    mini.store.setSnooze(snoozed, new Date(Date.now() + 86_400_000).toISOString());
    const drafted = await thread(mini, "ledger", "Drafted", "zephyr drafted");
    mini.store.saveReplyDraft(drafted, { body: "zephyr quokka draft words" });
    const deleted = await thread(mini, "ledger", "Deleted", "zephyr deleted quokka");
    mini.store.deleteThread(deleted);
    await mini.index.ensureBuilt();
    const tools = linked(studio, [linkTo(mini)]);
    const own = mini.tools();
    for (const query of ["zephyr", "quokka"]) {
      const theirs = (await own.search!.handler({ query, all_projects: true, limit: 50 }, {})).structuredContent!.results as { message_id: string }[];
      const door = ((await (await agentSearchDoorAnswer({ store: mini.store, searchIndex: mini.index }, new URL(`http://door.local/api/inbox/device/agent-search?q=${query}&limit=50&all=1`))).json()) as { results: { message_id: string }[] }).results;
      const guest = ((await tools.search!.handler({ query, all_projects: true, limit: 50 }, {})).structuredContent!.results as { message_id: string; machine?: unknown }[]).filter((r) => r.machine);
      expect([query, door.map((r) => r.message_id).sort()]).toEqual([query, theirs.map((r) => r.message_id).sort()]);
      expect([query, guest.map((r) => r.message_id).sort()]).toEqual([query, theirs.map((r) => r.message_id).sort()]);
    }
    for (const include_resolved of [false, true]) {
      for (const folder of ["ledger", "notes"]) {
        const theirs = (await own.read_thread!.handler({ project_path: mini.folder(folder), asked_by: "anyone", include_resolved, limit: 100 }, {})).structuredContent!.threads as { thread_id: string }[];
        const scope = encodeURIComponent(JSON.stringify([{ name: folder, remote: null }]));
        const door = ((await (await agentThreadsDoorAnswer({ store: mini.store, remoteOf: async () => null }, new URL(`http://door.local/api/inbox/device/agent-threads?limit=100&scope=${scope}${include_resolved ? "&include_resolved=1" : ""}`))).json()) as { threads: { thread_id: string }[] }).threads;
        expect([folder, include_resolved, door.map((t) => t.thread_id).sort()]).toEqual([folder, include_resolved, theirs.map((t) => t.thread_id).sort()]);
      }
    }
    // The deleted thread is in no list there, an archived one is (as the far side's own agent lists it).
    const everything = JSON.stringify((await (await agentThreadsDoorAnswer({ store: mini.store }, new URL("http://door.local/api/inbox/device/agent-threads?limit=100&all=1&include_resolved=1"))).json()));
    expect(everything).not.toContain(deleted);
    expect(everything).toContain(archived);
  });
});
