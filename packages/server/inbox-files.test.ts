/**
 * Files: the thread's project folder in the Inbox (packages/server/inbox-files.ts),
 * proved against a real started Inbox on loopback (temp data dir), a real git
 * repository built here, and the agent through the MCP SDK. What it guards:
 * the listing rule (everything but `.git`, ignored marked, dotenv / hidden /
 * outside locked), every refusal code, the 5,000 cap, the change marks and
 * their base (the commit the thread started on), the files root following a
 * linked worktree, and project-file comments riding a Send.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxAnnotationRecord } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, args: string[], date?: string): string {
  const env = date ? { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : GIT_ENV;
  const run = Bun.spawnSync(["git", ...args], { cwd, env });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

function write(path: string, content: string | Uint8Array = "") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const BEFORE = "2020-01-01T00:00:00Z";
const AFTER = "2099-01-01T00:00:00Z";

function scratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/** The repository every test reads: one commit dated before the thread, then whatever the test does. */
function repo() {
  const root = scratch("plannotator-inbox-files-");
  const project = join(root, "shop");
  const outside = join(root, "outside");
  write(join(outside, "secret.txt"), "OUTSIDE SECRET");
  write(join(project, ".gitignore"), "node_modules/\ndist\nmany/\n");
  write(join(project, "README.md"), "# Shop\n");
  write(join(project, "src", "a.ts"), "export const a = 1;\n");
  write(join(project, "src", "old.ts"), "export const old = 1;\n");
  write(join(project, ".github", "workflows", "ci.yml"), "on: push\n");
  write(join(project, ".env.example"), "KEY=\n");
  write(join(project, "page.html"), '<h1>Page</h1><img src="logo.png">');
  write(join(project, "logo.png"), PNG);
  write(join(project, "doc.pdf"), "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n");
  write(join(project, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 254]));
  git(project, ["init", "-q", "-b", "main"]);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "start"], BEFORE);
  // Untracked, ignored, hidden, secret and linked entries.
  write(join(project, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  write(join(project, "dist", "app.js"), "built\n");
  write(join(project, "packages", "web", "dist", "bundle.js"), "built\n");
  write(join(project, "packages", "web", "index.ts"), "export {};\n");
  write(join(project, ".claude", "settings.json"), '{"secret":true}');
  write(join(project, ".env"), "TOKEN=hunter2\n");
  write(join(project, "config", "prod.env"), "TOKEN=prod\n");
  write(join(project, "config", "app.json"), "{}\n");
  symlinkSync(join(outside, "secret.txt"), join(project, "link-out-file"));
  symlinkSync(outside, join(project, "link-out-dir"));
  symlinkSync(join(project, "src", "a.ts"), join(project, "link-in"));
  symlinkSync(join(project, "src"), join(project, "link-dir-in"));
  symlinkSync(join(project, "gone.txt"), join(project, "dangling"));
  Bun.spawnSync(["mkfifo", join(project, "pipe")]);
  return { root, project, outside };
}

async function start(root: string): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  return server;
}

async function send(server: InboxServer, projectPath: string, extra: Record<string, unknown> = {}): Promise<{ thread_id: string; message_id: string }> {
  const client = new Client({ name: "inbox-files-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const result = (await client.callTool({
    name: "send_message",
    arguments: { project_path: projectPath, body: "Done; have a look.", agent_session: "ses_files", ...extra },
  })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent as { thread_id: string; message_id: string };
}

const get = (server: InboxServer, path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers });
const post = (server: InboxServer, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

type Entry = { name: string; kind: "dir" | "file"; ignored: boolean; locked: null | "dotenv" | "hidden" | "outside"; size: number | null };
type Listing = { root: { name: string; branch: string | null; git: boolean }; dir: string; entries: Entry[]; more: number };

async function list(server: InboxServer, thread: string, dir?: string): Promise<Listing> {
  const res = await get(server, `/api/inbox/threads/${thread}/files${dir === undefined ? "" : `?dir=${encodeURIComponent(dir)}`}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Listing;
}

const byName = (listing: Listing) => new Map(listing.entries.map((e) => [e.name, e]));
const code = async (res: Response) => {
  const body = (await res.json()) as { code: string; reason?: string };
  return [res.status, body.code, ...(body.reason ? [body.reason] : [])];
};
const content = (server: InboxServer, thread: string, path: string, route = "content") =>
  get(server, `/api/inbox/threads/${thread}/files/${route}?path=${encodeURIComponent(path)}`);

test("the root listing: everything but .git, ignored marked, secrets and escapes locked, folders first", async () => {
  const { root, project } = repo();
  const server = await start(root);
  const { thread_id } = await send(server, project);
  const listing = await list(server, thread_id);
  expect(listing.root).toEqual({ name: "shop", branch: "main", git: true });
  expect(listing.dir).toBe("");
  expect(listing.more).toBe(0);
  const names = listing.entries.map((e) => e.name);
  expect(names).not.toContain(".git");
  // Folders first (a symlink to a folder inside the root is a folder), each group by name.
  const firstFile = listing.entries.findIndex((e) => e.kind === "file");
  expect(listing.entries.slice(0, firstFile).every((e) => e.kind === "dir")).toBe(true);
  expect(listing.entries.slice(firstFile).every((e) => e.kind === "file")).toBe(true);
  const entries = byName(listing);
  const pick = (name: string) => {
    const e = entries.get(name)!;
    return [e.kind, e.ignored, e.locked];
  };
  expect(pick("node_modules")).toEqual(["dir", true, null]);
  expect(pick("dist")).toEqual(["dir", true, null]);
  expect(pick("src")).toEqual(["dir", false, null]);
  expect(pick(".github")).toEqual(["dir", false, null]);
  // A hidden folder git tracks nothing under: listed, expandable, unlocked (its files are locked).
  expect(pick(".claude")).toEqual(["dir", false, null]);
  expect(pick(".env")).toEqual(["file", false, "dotenv"]);
  expect(pick(".env.example")).toEqual(["file", false, null]);
  expect(pick(".gitignore")).toEqual(["file", false, null]);
  expect(pick("link-out-file")).toEqual(["file", false, "outside"]);
  expect(pick("link-out-dir")).toEqual(["file", false, "outside"]);
  expect(pick("dangling")).toEqual(["file", false, "outside"]);
  expect(pick("link-in")).toEqual(["file", false, null]);
  expect(pick("link-dir-in")).toEqual(["dir", false, null]);
  expect(pick("pipe")[0]).toBe("file");
  expect(entries.get("README.md")!.size).toBe("# Shop\n".length);
  expect(entries.get("link-out-file")!.size).toBeNull();
});

test("deeper levels: ignored folders' children, nested ignored paths, hidden-untracked files, dotenv by name, links inside", async () => {
  const { root, project } = repo();
  const server = await start(root);
  const { thread_id } = await send(server, project);
  expect(byName(await list(server, thread_id, "node_modules/pkg")).get("index.js")).toMatchObject({ ignored: true, locked: null });
  const web = byName(await list(server, thread_id, "packages/web"));
  expect(web.get("dist")!.ignored).toBe(true);
  expect(web.get("index.ts")!.ignored).toBe(false);
  expect(byName(await list(server, thread_id, ".claude")).get("settings.json")!.locked).toBe("hidden");
  expect(byName(await list(server, thread_id, ".github/workflows")).get("ci.yml")!.locked).toBeNull();
  const config = byName(await list(server, thread_id, "config"));
  expect(config.get("prod.env")!.locked).toBe("dotenv");
  expect(config.get("app.json")!.locked).toBeNull();
  // A folder link inside the root lists its target's entries.
  expect(byName(await list(server, thread_id, "link-dir-in")).has("a.ts")).toBe(true);
});

test("listing refusals: bad paths, escapes, .git, missing, a file", async () => {
  const { root, project } = repo();
  const server = await start(root);
  const { thread_id } = await send(server, project);
  const dir = (d: string, headers: Record<string, string> = {}) => get(server, `/api/inbox/threads/${thread_id}/files?dir=${encodeURIComponent(d)}`, headers);
  expect(await code(await dir("../outside"))).toEqual([400, "invalid_path"]);
  expect(await code(await dir("/etc"))).toEqual([400, "invalid_path"]);
  expect(await code(await dir("src\0"))).toEqual([400, "invalid_path"]);
  expect(await code(await dir("link-out-dir"))).toEqual([403, "outside_root"]);
  expect(await code(await dir(".git"))).toEqual([404, "not_found"]);
  expect(await code(await dir("nope"))).toEqual([404, "not_found"]);
  expect(await code(await dir("README.md"))).toEqual([400, "not_a_dir"]);
  expect(await code(await dir("", { "Sec-Fetch-Site": "cross-site" }))).toEqual([403, "cross_origin"]);
  expect(await code(await get(server, "/api/inbox/threads/msg_nothere/files"))).toEqual([404, "thread_not_found"]);
});

test("a folder of more than 5,000 entries lists 5,000 and counts the rest", async () => {
  const { root, project } = repo();
  mkdirSync(join(project, "many"));
  for (let i = 0; i < 5_003; i++) writeFileSync(join(project, "many", `f${i}.txt`), "");
  const server = await start(root);
  const { thread_id } = await send(server, project);
  const listing = await list(server, thread_id, "many");
  expect(listing.entries).toHaveLength(5_000);
  expect(listing.more).toBe(3);
  // Numeric order: f2 before f10.
  expect(listing.entries.slice(0, 3).map((e) => e.name)).toEqual(["f0.txt", "f1.txt", "f2.txt"]);
});

test("content: kinds from the bytes, html through the asset route, a link inside followed, big text a download", async () => {
  const { root, project } = repo();
  write(join(project, "big.txt"), "x");
  truncateSync(join(project, "big.txt"), 16 * 1024 * 1024 + 1);
  const server = await start(root);
  const { thread_id } = await send(server, project);
  const read = async (path: string) => {
    const res = await content(server, thread_id, path);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, any>;
  };
  const readme = await read("README.md");
  expect([readme.kind, readme.text, readme.path, readme.name, readme.size]).toEqual(["markdown", "# Shop\n", "README.md", "README.md", 7]);
  expect(readme.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect((await read("src/a.ts")).kind).toBe("code");
  const page = await read("page.html");
  expect(page.kind).toBe("html");
  expect(page.html).toMatch(/<base href="\/api\/html-assets\/[A-Za-z0-9_-]+\/"/);
  const image = await read("logo.png");
  expect([image.kind, image.media_type, image.width, image.height, image.text]).toEqual(["image", "image/png", 1, 1, null]);
  expect((await read("doc.pdf")).kind).toBe("pdf");
  expect((await read("blob.bin")).kind).toBe("file");
  expect((await read(".env.example")).text).toBe("KEY=\n");
  const linked = await read("link-in");
  expect([linked.path, linked.text]).toEqual(["link-in", "export const a = 1;\n"]);
  expect((await read("link-dir-in/a.ts")).text).toBe("export const a = 1;\n");
  const big = await read("big.txt");
  expect([big.kind, big.text, big.size]).toEqual(["file", null, 16 * 1024 * 1024 + 1]);
});

test("content and raw refuse every bad case with its code", async () => {
  const { root, project } = repo();
  const server = await start(root);
  const { thread_id } = await send(server, project);
  for (const route of ["content", "raw"]) {
    const refused = async (path: string) => code(await content(server, thread_id, path, route));
    expect(await refused("../outside/secret.txt")).toEqual([400, "invalid_path"]);
    expect(await refused("/etc/hosts")).toEqual([400, "invalid_path"]);
    expect(await refused("README.md\0")).toEqual([400, "invalid_path"]);
    expect(await refused("")).toEqual([400, "invalid_path"]);
    expect(await refused("link-out-file")).toEqual([403, "outside_root"]);
    expect(await refused("link-out-dir/secret.txt")).toEqual([403, "outside_root"]);
    expect(await refused(".env")).toEqual([403, "locked", "dotenv"]);
    expect(await refused("config/prod.env")).toEqual([403, "locked", "dotenv"]);
    expect(await refused(".claude/settings.json")).toEqual([403, "locked", "hidden"]);
    expect(await refused(".git/config")).toEqual([404, "not_found"]);
    expect(await refused("dangling")).toEqual([404, "not_found"]);
    expect(await refused("nope.txt")).toEqual([404, "not_found"]);
    expect(await refused("src")).toEqual([400, "not_a_file"]);
    expect(await refused("pipe")).toEqual([400, "not_a_file"]);
    expect(await code(await get(server, `/api/inbox/threads/${thread_id}/files/${route}?path=README.md`, { "Sec-Fetch-Site": "same-site" }))).toEqual([403, "cross_origin"]);
  }
  // A tracked hidden file reads.
  expect((await content(server, thread_id, ".github/workflows/ci.yml")).status).toBe(200);
});

test("a folder that is not a git repository: no git, every hidden file locked, names still listed", async () => {
  const root = scratch("plannotator-inbox-files-home-");
  const home = join(root, "home");
  write(join(home, ".ssh", "id_rsa"), "PRIVATE KEY");
  write(join(home, ".bashrc"), "export X=1");
  write(join(home, "notes.txt"), "hello");
  const server = await start(root);
  const { thread_id } = await send(server, home);
  const listing = await list(server, thread_id);
  expect(listing.root.git).toBe(false);
  expect(listing.root.branch).toBeNull();
  const entries = byName(listing);
  expect(entries.get(".ssh")).toMatchObject({ kind: "dir", locked: null, ignored: false });
  expect(entries.get(".bashrc")!.locked).toBe("hidden");
  expect(byName(await list(server, thread_id, ".ssh")).get("id_rsa")!.locked).toBe("hidden");
  expect(await code(await content(server, thread_id, ".ssh/id_rsa"))).toEqual([403, "locked", "hidden"]);
  expect((await content(server, thread_id, "notes.txt")).status).toBe(200);
  const changed = (await (await get(server, `/api/inbox/threads/${thread_id}/files/changed`)).json()) as Record<string, unknown>;
  expect(changed).toMatchObject({ git: false, changes: {}, base: { commit: null, source: "none" } });
});

test("raw: sniffed image inline with the guard headers, download on request, everything else an attachment, a cap", async () => {
  const { root, project } = repo();
  write(join(project, "huge.png"), PNG);
  truncateSync(join(project, "huge.png"), 64 * 1024 * 1024 + 1);
  const server = await start(root);
  const { thread_id } = await send(server, project);
  const image = await content(server, thread_id, "logo.png", "raw");
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(image.headers.get("x-content-type-options")).toBe("nosniff");
  expect(image.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(image.headers.get("content-security-policy")).toContain("sandbox");
  expect(image.headers.get("content-disposition")).toStartWith("inline");
  expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true);
  const download = await get(server, `/api/inbox/threads/${thread_id}/files/raw?path=logo.png&download=1`);
  expect(download.headers.get("content-disposition")).toStartWith("attachment");
  // An HTML page is never served as HTML on this origin.
  const page = await content(server, thread_id, "page.html", "raw");
  expect(page.headers.get("content-type")).toBe("application/octet-stream");
  expect(page.headers.get("content-disposition")).toStartWith("attachment");
  expect((await content(server, thread_id, "doc.pdf", "raw")).headers.get("content-type")).toBe("application/pdf");
  expect(await code(await content(server, thread_id, "huge.png", "raw"))).toEqual([413, "too_large"]);
});

test("change marks: commits since the thread began, uncommitted edits, untracked; not what came before", async () => {
  const { root, project } = repo();
  const server = await start(root);
  const { thread_id } = await send(server, project);
  const startCommit = git(project, ["rev-parse", "HEAD"]).trim();
  // A commit after the thread's first message.
  write(join(project, "src", "old.ts"), "export const old = 2;\n");
  write(join(project, "src", "added.ts"), "export const added = 1;\n");
  git(project, ["add", "src/old.ts", "src/added.ts"]);
  git(project, ["commit", "-qm", "after"], AFTER);
  // Uncommitted: an edit, a deletion, an untracked file.
  write(join(project, "README.md"), "# Shop!\n");
  rmSync(join(project, "doc.pdf"));
  write(join(project, "notes.txt"), "todo\n");
  const res = await get(server, `/api/inbox/threads/${thread_id}/files/changed`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { git: boolean; base: { commit: string | null; source: string }; changes: Record<string, string>; truncated: boolean };
  expect(body.git).toBe(true);
  expect(body.base).toEqual({ commit: startCommit, source: "thread_start" });
  expect(body.truncated).toBe(false);
  expect(body.changes["src/old.ts"]).toBe("M");
  expect(body.changes["src/added.ts"]).toBe("A");
  expect(body.changes["README.md"]).toBe("M");
  expect(body.changes["doc.pdf"]).toBe("D");
  expect(body.changes["notes.txt"]).toBe("U");
  expect(body.changes[".claude/settings.json"]).toBe("U");
  // Committed before the thread began: not marked. Ignored: not marked.
  expect(body.changes["src/a.ts"]).toBeUndefined();
  expect(body.changes["node_modules/pkg/index.js"]).toBeUndefined();
});

test("a repository younger than the thread: no base, uncommitted changes only", async () => {
  const root = scratch("plannotator-inbox-files-young-");
  const project = join(root, "young");
  write(join(project, "a.txt"), "1\n");
  write(join(project, "b.txt"), "1\n");
  git(project, ["init", "-q", "-b", "main"]);
  git(project, ["add", "-A"]);
  // Every commit is dated after the thread's first message.
  git(project, ["commit", "-qm", "first"], AFTER);
  write(join(project, "b.txt"), "2\n");
  const server = await start(root);
  const { thread_id } = await send(server, project);
  const body = (await (await get(server, `/api/inbox/threads/${thread_id}/files/changed`)).json()) as { base: unknown; changes: Record<string, string> };
  expect(body.base).toEqual({ commit: null, source: "none" });
  expect(body.changes).toEqual({ "b.txt": "M" });
});

test("the files root follows the latest agent message into a linked worktree", async () => {
  const { root, project } = repo();
  const worktree = join(project, ".claude", "worktrees", "agent-1");
  git(project, ["worktree", "add", "-q", "-b", "feature", worktree]);
  write(join(worktree, "only-here.txt"), "worktree\n");
  const server = await start(root);
  const first = await send(server, project);
  expect(byName(await list(server, first.thread_id)).has("only-here.txt")).toBe(false);
  // The same thread, now from the worktree: the Files view moves with the agent.
  const second = await send(server, worktree, { reply_to: first.message_id });
  expect(second.thread_id).toBe(first.thread_id);
  const listing = await list(server, first.thread_id);
  expect(listing.root).toMatchObject({ name: "agent-1", branch: "feature", git: true });
  const entries = byName(listing);
  expect(entries.has("only-here.txt")).toBe(true);
  // A worktree's `.git` is a file: never listed either.
  expect(entries.has(".git")).toBe(false);
  // Its reads stay inside the worktree.
  expect(await code(await content(server, first.thread_id, "../../../README.md"))).toEqual([400, "invalid_path"]);
  expect((await content(server, first.thread_id, "only-here.txt")).status).toBe(200);
});

test("comments on project files: saved, pending, refused on secrets and downloads, carried and closed by a Send", async () => {
  const { root, project } = repo();
  const server = await start(root);
  const { thread_id, message_id } = await send(server, project);
  const route = `/api/inbox/threads/${thread_id}/files/annotations`;
  const note = (id: string) => ({ id, blockId: "line-1", type: "COMMENT", text: "Rename this.", originalText: "export const a = 1;" });
  const save = (path: string, id = "ann-pf-1", session = server.serverSession) => post(server, route, { serverSession: session, path, annotation: note(id) });

  const saved = await save("src/a.ts");
  expect(saved.status).toBe(200);
  const record = ((await saved.json()) as { annotation: InboxAnnotationRecord }).annotation;
  expect(record).toMatchObject({ attachment_id: "", path: join(project, "src", "a.ts"), version: "current", project_file: { path: "src/a.ts" }, message_id, thread_id });

  expect(await code(await save(".env", "ann-pf-2"))).toEqual([403, "locked", "dotenv"]);
  expect(await code(await save("link-out-file", "ann-pf-2"))).toEqual([403, "outside_root"]);
  expect(await code(await save(".claude/settings.json", "ann-pf-2"))).toEqual([403, "locked", "hidden"]);
  expect(await code(await save("doc.pdf", "ann-pf-2"))).toEqual([422, "annotation_not_allowed"]);
  expect(await code(await save("blob.bin", "ann-pf-2"))).toEqual([422, "annotation_not_allowed"]);
  expect(await code(await save("src/a.ts", "ann-pf-2", "an-older-inbox"))).toEqual([409, "session_mismatch"]);
  // An id already used on another file.
  expect(await code(await save("README.md", "ann-pf-1"))).toEqual([422, "validation_error"]);

  // Removal through the shared route, then a second comment that rides a Send.
  expect((await post(server, `/api/inbox/annotations/ann-pf-1/remove`, {})).status).toBe(200);
  expect((await save("README.md", "ann-pf-3")).status).toBe(200);
  const pending = async () => ((await (await get(server, `/api/inbox/threads/${thread_id}/attachments`)).json()) as { annotations: InboxAnnotationRecord[] }).annotations;
  expect((await pending()).map((r) => [r.id, r.project_file?.path])).toEqual([["ann-pf-3", "README.md"]]);
  const reply = await post(server, `/api/inbox/messages/${message_id}/reply`, {
    idempotency_key: "files-send-1",
    words: "One note on the README.",
    feedback: "README.md: Rename this.",
    annotation_ids: ["ann-pf-3"],
  });
  expect(reply.status).toBe(200);
  expect(await pending()).toHaveLength(0);
  expect(server.store.pendingAnnotations(thread_id)).toHaveLength(0);
  // Sent: closed to edits.
  expect(await code(await save("README.md", "ann-pf-3"))).toEqual([409, "annotation_closed"]);
  // An archived thread takes no new comments.
  expect((await post(server, `/api/inbox/messages/${thread_id}/resolve`, { serverSession: server.serverSession, resolved: true })).status).toBe(200);
  expect(await code(await save("src/a.ts", "ann-pf-4"))).toEqual([409, "thread_resolved"]);
});
