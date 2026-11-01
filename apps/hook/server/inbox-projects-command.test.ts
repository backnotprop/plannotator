/**
 * `plannotator inbox projects …` as real processes (approval "project-combine"):
 * after the window's toast this is the only way back from a combine, so what can
 * regress is an undo that loses a thread, a card or a name, one that needs the
 * session or the Inbox process that combined, a refusal that reads as success,
 * and the guide naming a command the parser does not take. Every process gets a
 * temp HOME and data dir; only Inboxes these tests started are stopped.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INBOX_CARD_ACTION_ON } from "@plannotator/core/inbox-types";
import { mcpAnswerOf } from "@plannotator/shared/inbox/connection";
import { type InboxRegistryEntry, readInboxRegistry } from "@plannotator/shared/inbox/registry";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { type InboxEntry, inboxEntryOf, mustSignalInbox, stopProvenInboxes, waitGone } from "../../../tests/helpers/inbox-process";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { parseProjectsCommand, runInboxProjectsCommand } from "./inbox-projects-command";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
let stubs: string[] = [];
const started: { entry: InboxEntry; root: string }[] = [];

beforeAll(() => {
  // The CLI imports the built HTML; these tests never read the pages.
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(async () => {
  await stopProvenInboxes(started.splice(0), { signal: "SIGKILL" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-projects-cli-")));
  roots.push(root);
  const dataDir = join(root, "home", ".plannotator");
  const docs = join(root, "code", "docs");
  const site = join(root, "code", "docs-site");
  const elsewhere = join(root, "elsewhere");
  for (const folder of [docs, site, elsewhere, dataDir]) mkdirSync(folder, { recursive: true });
  const browserMarker = join(root, "browser-opened");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(root, "home"),
    TMPDIR: tmpdir(),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: "0",
    ...GIT_ENV,
  };
  // The Board is something the person turns on: on here, for the cards.
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxBoard: true }));
  return { root, dataDir, docs, site, elsewhere, browserMarker, env };
}

type Box = ReturnType<typeof sandbox>;

async function projects(box: Box, args: string[], options: { cwd?: string; session?: string } = {}) {
  const env = { ...box.env, ...(options.session ? { PLANNOTATOR_SESSION_TAG: `claude-code:${options.session}` } : {}) };
  const proc = Bun.spawn([process.execPath, "run", entry, "inbox", "projects", ...args], { cwd: options.cwd ?? box.docs, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const inbox = inboxEntryOf(box.dataDir);
  if (inbox && !started.some((s) => s.entry.pid === inbox.pid)) started.push({ entry: inbox, root: box.root });
  return { code, stdout, stderr };
}

const port = (box: Box) => readInboxRegistry(box.dataDir)!.port;
const api = async (box: Box, path: string) => (await fetch(`http://127.0.0.1:${port(box)}${path}`)).json() as Promise<any>;

async function tool(box: Box, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port(box)}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const result = mcpAnswerOf(await response.text())?.result as { structuredContent?: unknown; isError?: boolean; content?: { text?: string }[] };
  expect(result.isError ? result.content?.[0]?.text : undefined).toBeUndefined();
  return result.structuredContent;
}

const say = (box: Box, folder: string, fields: Record<string, unknown>) => tool(box, "send_message", { project_path: folder, agent_name: "Claude Code", agent_host: "claude-code", agent_session: "ses_writer", ...fields });
const bodies = async (box: Box, thread: string): Promise<string[]> => (await api(box, `/api/inbox/threads/${thread}`)).thread.messages.map((message: { body: string }) => message.body);
const listedIn = async (box: Box, project: string): Promise<string[]> =>
  (await api(box, `/api/inbox/threads?project=${project}`)).sections.flatMap((section: { threads: { thread_id: string }[] }) => section.threads.map((row) => row.thread_id)).sort();
const cards = async (box: Box, folder: string): Promise<string[]> => (await tool(box, "card", { op: "list", project_path: folder, asked_by: "anyone" })).cards.map((card: { id: string }) => card.id).sort();
const listing = async (box: Box) => JSON.parse((await projects(box, ["--json"])).stdout) as { projects: { id: string; name: string; root: string; threads: number; combined?: { id: string; name: string }[] }[]; suggestions: { from: { id: string }; into: { id: string }; why: string }[] };

async function seeded() {
  const box = sandbox();
  expect((await projects(box, [])).stdout).toBe("No projects yet.\n");
  const docs = await say(box, box.docs, { subject: "Release notes", thread: "release", body: "The heron notes." });
  const site = await say(box, box.site, { subject: "Landing copy", thread: "landing", body: "The marlin copy." });
  return { box, docs: docs.project.id as string, site: site.project.id as string, docsThread: docs.thread_id as string, siteThread: site.thread_id as string };
}

describe("plannotator inbox projects", () => {
  test("lists each project with its folder and thread count, starting a stopped Inbox without a browser", async () => {
    const { box, docs, site } = await seeded();
    expect(existsSync(box.browserMarker)).toBe(false);
    const text = (await projects(box, [])).stdout;
    expect(text).toContain(`docs  ${docs}\n  ${box.docs}\n  1 thread\n`);
    expect(text).toContain(`docs-site  ${site}\n  ${box.site}\n  1 thread\n`);
    expect((await listing(box)).projects.map((project) => project.id).sort()).toEqual([docs, site].sort());
  });

  test("two clones of one repository come as a suggestion, and the command it prints runs as printed", async () => {
    const box = sandbox();
    for (const folder of [box.docs, box.site]) {
      for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/acme/docs.git"]]) expect(spawnSync("git", args, { cwd: folder, env: { ...process.env, ...GIT_ENV } }).status).toBe(0);
    }
    await projects(box, []);
    await say(box, box.docs, { subject: "One", body: "One." });
    await say(box, box.site, { subject: "Two", body: "Two." });
    let found = (await listing(box)).suggestions;
    for (let i = 0; i < 50 && found.length === 0; i++) {
      await Bun.sleep(50);
      found = (await listing(box)).suggestions;
    }
    expect(found).toHaveLength(1);
    expect(found[0]!.why).toBe("same repository");
    const line = /plannotator inbox projects (combine .+)/.exec((await projects(box, [])).stdout)![1]!;
    expect((await projects(box, line.split(" "))).code).toBe(0);
    const after = await listing(box);
    expect(after.projects).toHaveLength(1);
    expect(after.suggestions).toEqual([]);
  });

  test.if(INBOX_CARD_ACTION_ON)("combine, then undo later from another session: threads, cards and names all come back", async () => {
    const { box, docs, site, docsThread, siteThread } = await seeded();
    const serverSession = (await api(box, "/api/inbox/projects")).serverSession;
    const named = await fetch(`http://127.0.0.1:${port(box)}/api/inbox/projects/${site}/name`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession, name: "Marketing site" }) });
    expect(named.status).toBe(200);
    const cardBefore = (await tool(box, "card", { op: "create", title: "Landing page", project_path: box.site, agent_name: "Claude Code", agent_host: "claude-code" })).card.id as string;

    const combined = await projects(box, ["combine", site, "--into", docs], { session: "ses-combiner-0001" });
    expect(combined.stderr).toBe("");
    expect(combined.code).toBe(0);
    expect(combined.stdout).toContain(`Combined Marketing site into docs. To undo: plannotator inbox projects undo ${site}`);

    // One project now, with what the folders do while it stands.
    const one = (await listing(box)).projects;
    expect(one.map((project) => project.id)).toEqual([docs]);
    expect(one[0]!.combined?.map((member) => [member.id, member.name])).toEqual([[site, "Marketing site"]]);
    expect(await listedIn(box, docs)).toEqual([docsThread, siteThread].sort());
    const joined = await say(box, box.site, { thread: "release", body: "A kingfisher note from the site." });
    expect(joined.thread_id).toBe(docsThread);
    const sinceThread = (await say(box, box.site, { subject: "Redesign", thread: "redesign", body: "The osprey plan." })).thread_id as string;
    const sinceCard = (await tool(box, "card", { op: "create", title: "Redesign", thread_id: sinceThread, project_path: box.docs, agent_name: "Claude Code", agent_host: "claude-code" })).card.id as string;
    expect(await cards(box, box.docs)).toEqual([cardBefore, sinceCard].sort());
    const before = { docs: await bodies(box, docsThread), site: await bodies(box, siteThread), since: await bodies(box, sinceThread) };

    // Later: another Inbox process, another session, another folder. Nothing is remembered from the combine.
    await mustSignalInbox(inboxEntryOf(box.dataDir), box.root, "SIGKILL");
    await waitGone(started.map((s) => s.entry.pid), 5_000);
    const undone = await projects(box, ["undo", site], { session: "ses-undoer-0002", cwd: box.elsewhere });
    expect(undone.stderr).toBe("");
    expect(undone.code).toBe(0);
    expect(undone.stdout).toBe("Marketing site is its own project again.\n");

    // Names.
    const apart = (await listing(box)).projects;
    expect(apart.map((project) => [project.id, project.name]).sort()).toEqual([[docs, "docs"], [site, "Marketing site"]].sort());
    expect(apart.every((project) => project.combined === undefined)).toBe(true);
    // Threads: each with the folder that started it, the one started since too, and every message.
    expect(await listedIn(box, docs)).toEqual([docsThread]);
    expect(await listedIn(box, site)).toEqual([siteThread, sinceThread].sort());
    expect(await bodies(box, docsThread)).toEqual(before.docs);
    expect(await bodies(box, siteThread)).toEqual(before.site);
    expect(await bodies(box, sinceThread)).toEqual(before.since);
    // What joined the other folder's thread stays in it.
    expect(before.docs).toContain("A kingfisher note from the site.");
    // Cards: both go back with the site, the one made from the other folder too.
    expect(await cards(box, box.site)).toEqual([cardBefore, sinceCard].sort());
    expect(await cards(box, box.docs)).toEqual([]);
    // Routing: the same name from the other folder is another thread again.
    expect((await say(box, box.docs, { subject: "Mine", thread: "landing", body: "A thread of its own." })).thread_id).not.toBe(siteThread);
  });

  test("undoing a project with others in it keeps them, and says so", async () => {
    const { box, docs, site } = await seeded();
    const web = (await say(box, box.elsewhere, { subject: "Web", body: "Web." })).project.id as string;
    expect((await projects(box, ["combine", web, "--into", site])).code).toBe(0);
    expect((await projects(box, ["combine", site, "--into", docs])).code).toBe(0);
    expect((await listing(box)).projects.map((project) => project.id)).toEqual([docs]);
    const undone = await projects(box, ["undo", site]);
    expect(undone.stdout).toBe("docs-site is its own project again, with elsewhere still combined into it.\n");
    expect((await listing(box)).projects.map((project) => project.id).sort()).toEqual([docs, site].sort());
  });

  test("a refusal never reads as done: exit 1 with the code, and nothing written", async () => {
    const { box, docs, site } = await seeded();
    const notCombined = await projects(box, ["undo", site]);
    expect([notCombined.code, notCombined.stdout]).toEqual([1, ""]);
    expect(notCombined.stderr).toBe("not_combined: docs-site is not combined into another project.\n");
    const self = await projects(box, ["combine", site, "--into", site]);
    expect(self.code).toBe(1);
    expect(self.stderr).toStartWith("validation_error:");
    const nobody = "prj_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    for (const args of [["undo", nobody], ["combine", nobody, "--into", docs], ["combine", site, "--into", nobody]]) {
      const missing = await projects(box, args);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toStartWith("project_not_found:");
    }
    // A name for an id, the likely slip, points at the ids.
    const byName = await projects(box, ["combine", "docs-site", "--into", docs]);
    expect(byName.code).toBe(1);
    expect(byName.stderr).toStartWith("validation_error: docs-site is not a project id.");
    expect((await listing(box)).projects.map((project) => project.id).sort()).toEqual([docs, site].sort());

    // Opposite combines cannot make a loop.
    expect((await projects(box, ["combine", site, "--into", docs])).code).toBe(0);
    expect((await projects(box, ["combine", docs, "--into", site])).stderr).toStartWith("validation_error:");
    // A combine that is already true changes nothing, and says that.
    const again = await projects(box, ["combine", site, "--into", docs, "--json"]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ changed: false, project: { id: docs } });
  });

  test("bad usage exits 2 with the usage, and starts no Inbox", async () => {
    const box = sandbox();
    for (const args of [["merge"], ["combine", "prj_a"], ["combine", "prj_a", "--into"], ["combine", "--into", "prj_b"], ["undo"], ["undo", "prj_a", "prj_b"], ["combine", "prj_a", "--into", "prj_b", "--force"]]) {
      const bad = await projects(box, args);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain("plannotator inbox projects combine <project id> --into <project id>");
    }
    const help = await projects(box, ["--help"]);
    expect([help.code, help.stderr]).toEqual([0, ""]);
    expect(help.stdout).toContain("plannotator inbox projects undo <project id>");
    expect(inboxEntryOf(box.dataDir)).toBeNull();
  });

  test("every projects command the agents' guide names is one the parser takes", () => {
    const box = sandbox();
    const guide = spawnSync(process.execPath, ["run", entry, "inbox", "--help"], { cwd: box.docs, env: box.env, encoding: "utf8" }).stdout;
    // Command lines only: the usage's description column follows two spaces.
    const lines = [...guide.matchAll(/^ *plannotator inbox projects(?: (?! )(.*))?$/gm)].map((match) => (match[1] ?? "").replace("[--json]", "").replaceAll("<project id>", "prj_x").trim());
    const named = new Set(lines.map((line) => parseProjectsCommand(line === "" ? [] : line.split(/\s+/))).map((parsed) => (parsed.ok ? parsed.op : parsed.error)));
    expect([...named].sort()).toEqual(["combine", "list", "undo"]);
  });

  test("an Inbox older than the command says so, instead of a bare 404", async () => {
    const from = "prj_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const into = "prj_01BX5ZZKBKACTAV9WEVGEMMVRZ";
    // What any Inbox answers for a route it does not have.
    const older = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => (new URL(req.url).pathname === "/api/inbox/projects" ? Response.json({ serverSession: "s", projects: [{ id: from, name: "a", root: "/a", threads: 0 }] }) : Response.json({ error: "Not found", code: "not_found" }, { status: 404 })),
    });
    try {
      const errors: string[] = [];
      const code = await runInboxProjectsCommand(["combine", from, "--into", into], { json: false, ensureRunning: async () => ({ port: older.port }) as InboxRegistryEntry, out: () => {}, err: (text) => errors.push(text) });
      expect(code).toBe(1);
      expect(errors.join("")).toStartWith("not_supported:");
    } finally {
      older.stop(true);
    }
  });
});
