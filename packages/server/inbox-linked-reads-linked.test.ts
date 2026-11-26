/**
 * The reads a linked computer's window makes of the other computer's threads (mark `linked-reads`), on two real
 * Inboxes linked both ways (docs/agent-guides/inbox-machines.md), every proof made both ways: Studio's window reads
 * Laptop's thread and Laptop's window reads Studio's. Nothing here stubs `doorOf`: each read goes through the real
 * forward, the far door, its dispatch and `fromDeviceDoor`, and the far Inbox decides by the window's mark
 * (`MACHINE_WINDOW_HEADER`) the forward adds.
 *
 * What regresses:
 *  - a thread's steps read under this computer's Steps switch instead of the thread's machine's;
 *  - a guided review's whole file, image sides, a changed Markdown file's picture or package changes not read there,
 *    or read by an agent's bare call on this computer, or by a phone's token at the far door;
 *  - a code span's hover or the file check refused for the window (the window's mark lost on the way), or answered
 *    for a call there without it;
 *  - Viewed: a tick made while that machine is away not held, landing wrong, or a held tick undoing another (one
 *    ticked before it, one ticked on that machine meanwhile);
 *  - a Tag search not finding the far thread by the far computer's tag, or asking an older machine that does not say
 *    the mark.
 *
 * Starts Inboxes: CI runs it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { waitFor } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

/** No real tailscale ever runs: the loopback transport is the test's, and serve holds nothing. */
const tailscale: TailscaleRunner = (args) => ({ status: 0, stdout: args[1] === "status" ? "{}" : "", stderr: "" });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Bob Tully", GIT_AUTHOR_EMAIL: "bob@example.com", GIT_COMMITTER_NAME: "Bob Tully", GIT_COMMITTER_EMAIL: "bob@example.com" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const png = (tag: string) => Buffer.concat([PNG, Buffer.from(tag, "latin1")]);
const manifest = (name: string, dependencies: Record<string, string>) => `${JSON.stringify({ name, version: "1.0.0", dependencies }, null, 2)}\n`;
const FILES = ["src/retry.ts", "assets/chart.png", "NOTES.md", "package.json"];

interface Machine {
  name: string;
  data: string;
  /** Laptop serves phones, so a phone's token can be shown the door's unknown route. */
  phones: boolean;
  /** Its Steps switch: on for Laptop, off for Studio. */
  steps: boolean;
  server: InboxServer;
  id: string;
  project: string;
  /** The guided review its agent sent, and its thread. */
  review: { message: string; thread: string };
  /** Its token on the other machine (the other's link to it is this machine's way in there). */
  tokenThere: string;
}

const at = (m: Machine) => `http://127.0.0.1:${m.server.port}`;
const getJson = async (m: Machine, path: string): Promise<Json> => (await (await fetch(`${at(m)}${path}`)).json()) as Json;
/** A read from the Inbox window: Fetch Metadata says same-origin. */
const windowGet = (m: Machine, path: string) => fetch(`${at(m)}${path}`, { headers: { "Sec-Fetch-Site": "same-origin" } });
let keys = 0;
/** A press in the window: its Origin, its page session and the key the window adds. */
async function windowPost(m: Machine, path: string, body: Json): Promise<Response> {
  const { serverSession } = await getJson(m, "/api/inbox/health");
  return fetch(`${at(m)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: at(m), "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ serverSession, idempotency_key: `window-linked-reads-${++keys}`, ...body }),
  });
}

function git(project: string, ...args: string[]): string {
  const done = Bun.spawnSync(["git", ...args], { cwd: project, env: GIT_ENV });
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
  return done.stdout.toString();
}

/** A project whose last commit changes a file, a picture, a Markdown file that shows the picture, and package.json. */
function project(root: string, name: string, on: string): { dir: string; patch: string } {
  const dir = join(root, name);
  for (const sub of ["src", "assets"]) mkdirSync(join(dir, sub), { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, "src/retry.ts"), `export const tries = 3;\n// ${on}\n`);
  writeFileSync(join(dir, "assets/chart.png"), png(`${on} before`));
  writeFileSync(join(dir, "NOTES.md"), "# Notes\n");
  writeFileSync(join(dir, "package.json"), manifest(name, { "left-pad": "^1.1.0" }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  writeFileSync(join(dir, "src/retry.ts"), `export const tries = 5;\n// ${on}\n`);
  writeFileSync(join(dir, "assets/chart.png"), png(`${on} after`));
  writeFileSync(join(dir, "NOTES.md"), "# Notes\n\n![chart](assets/chart.png)\n");
  writeFileSync(join(dir, "package.json"), manifest(name, { "left-pad": "^1.3.0", "tiny-queue": "^0.2.1" }));
  git(dir, "commit", "-qam", "the change");
  return { dir, patch: git(dir, "diff", "--no-renames", "HEAD~1", "HEAD") };
}

async function sendReview(m: Machine, patch: string): Promise<{ message: string; thread: string }> {
  const client = new Client({ name: "inbox-linked-reads-linked", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${at(m)}/mcp`)));
  try {
    const result = (await client.callTool({
      name: "submit_guide",
      arguments: {
        project_path: m.project,
        patch,
        review: true,
        subject: `Retry budget on ${m.name}`,
        guide: { title: `Retry budget on ${m.name}`, intent: "More tries, a new chart.", sections: [{ title: "The change", overview: "Four files.", diffs: FILES.map((file) => ({ file, summary: "changed" })) }] },
        agent_session: `ses_${m.name.toLowerCase()}`,
        agent_name: "Claude Code",
        agent_host: "claude-code",
      },
    })) as { isError?: boolean; content: { text: string }[]; structuredContent: { message_id: string; thread_id: string } };
    if (result.isError) throw new Error(result.content[0]!.text);
    return { message: result.structuredContent.message_id, thread: result.structuredContent.thread_id };
  } finally {
    await client.close().catch(() => {});
  }
}

const viewedThere = (m: Machine) => [...(m.server.store.message(m.review.message)?.guide_viewed ?? [])].sort();
const stateOf = async (here: Machine, there: Machine) => ((await getJson(here, "/api/inbox/machines")).machines as Json[]).find((x) => x.id === there.id)?.state ?? null;
const heldFor = async (here: Machine, there: Machine) => ((await getJson(here, `/api/inbox/outbox?machine=${there.id}`)).waiting as Json[]).filter((e) => /\/guide\/viewed$/.test(e.route));

describe("a linked computer's reads of the other's threads, two real Inboxes linked both ways (mark `linked-reads`)", () => {
  const dirs: string[] = [];
  const sandboxWas = process.env.PLANNOTATOR_TEST_SANDBOX;
  let studio: Machine;
  let laptop: Machine;
  let phoneToken = "";

  const scratch = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  const boot = (m: Pick<Machine, "data" | "phones" | "steps">) =>
    startInboxServer({ dataDir: m.data, binaryPath: null, phones: m.phones, steps: m.steps, codeReview: true, tailscale, readProjectRepo: async () => null });

  /** Stop `m`, run `away` while the other sees it away, start it again, and wait until the other sees it back. */
  async function whileAway(m: Machine, other: Machine, away: () => Promise<void>): Promise<void> {
    m.server.stop();
    await waitFor(`${m.name} away on ${other.name}`, async () => (await stateOf(other, m)) === "offline", 30_000);
    await away();
    m.server = await boot(m);
    await waitFor(`${m.name} back on ${other.name}`, async () => (await stateOf(other, m)) === "online", 45_000);
  }

  beforeAll(async () => {
    process.env.PLANNOTATOR_TEST_SANDBOX = "1";
    const machines: Machine[] = [];
    for (const [name, projectName, phones, steps] of [
      ["Studio", "fern-api", false, false],
      ["Laptop", "harbor", true, true],
    ] as const) {
      const root = scratch(`plannotator-linked-reads-${name.toLowerCase()}-`);
      const made = project(root, projectName, name);
      const m = { name, data: join(root, "data"), phones, steps, id: "", project: made.dir, review: { message: "", thread: "" }, tokenThere: "" } as Machine;
      m.server = await boot(m);
      m.id = (await getJson(m, "/api/inbox/health")).inbox_id as string;
      m.review = await sendReview(m, made.patch);
      // The agent's checklist, on its review's thread.
      m.server.store.setThreadSteps({ thread_id: m.review.thread, agent: { kind: "agent", host: "claude-code", session: `ses_${name.toLowerCase()}`, name: "Claude Code" }, steps: [{ step: `Raise the retry budget on ${name}`, status: "doing" }, { step: "Ship it", status: "todo" }] });
      machines.push(m);
    }
    [studio, laptop] = machines as [Machine, Machine];
    const offered = (await (await fetch(`${at(laptop)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
    const linked = await fetch(`${at(studio)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(laptop), back: at(studio) }) });
    expect(linked.status).toBe(201);
    const tokenOf = (m: Machine, there: Machine) => ((JSON.parse(readFileSync(join(m.data, "inbox", "machines.json"), "utf8")) as Json).links as Json[]).find((l) => l.id === there.id)!.token as string;
    for (const [here, there] of [
      [studio, laptop],
      [laptop, studio],
    ] as const) {
      await waitFor(`${here.name} has read ${there.name}'s list with the mark`, async () => {
        const view = ((await getJson(here, "/api/inbox/machines")).machines as Json[]).find((x) => x.id === there.id);
        return view?.state === "online" && (view.marks as string[]).includes("linked-reads");
      });
      here.tokenThere = tokenOf(here, there);
    }
    // A phone paired with Laptop.
    const made = (await (await fetch(`${at(laptop)}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as Json;
    const paired = await fetch(`${at(laptop)}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) });
    expect(paired.status).toBe(201);
    phoneToken = ((await paired.json()) as Json).token as string;
  }, 120_000);

  afterAll(() => {
    studio?.server.stop();
    laptop?.server.stop();
    if (sandboxWas === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
    else process.env.PLANNOTATOR_TEST_SANDBOX = sandboxWas;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const both = () =>
    [
      [studio, laptop],
      [laptop, studio],
    ] as const;

  test("a thread's steps read under its own machine's Steps switch, whatever this computer's", async () => {
    // Laptop's switch on (Studio's off): Studio's window reads Laptop's checklist.
    const fromStudio = (await (await windowGet(studio, `/api/inbox/m/${laptop.id}/threads/${laptop.review.thread}/steps`)).json()) as Json;
    expect(fromStudio.on).toBe(true);
    expect((fromStudio.steps as Json[])[0].steps.map((s: Json) => s.step)).toEqual(["Raise the retry budget on Laptop", "Ship it"]);
    // Studio's switch off (Laptop's on): Laptop's window reads none of Studio's, though Studio keeps one.
    expect(studio.server.store.threadSteps(studio.review.thread)).toHaveLength(1);
    const fromLaptop = (await (await windowGet(laptop, `/api/inbox/m/${studio.id}/threads/${studio.review.thread}/steps`)).json()) as Json;
    expect([fromLaptop.on, fromLaptop.steps]).toEqual([false, []]);
    // A changed step is read there again.
    laptop.server.store.setThreadSteps({ thread_id: laptop.review.thread, agent: { kind: "agent", host: "claude-code", session: "ses_laptop", name: "Claude Code" }, steps: [{ step: "Raise the retry budget on Laptop", status: "done" }, { step: "Ship it", status: "doing" }] });
    const again = (await (await windowGet(studio, `/api/inbox/m/${laptop.id}/threads/${laptop.review.thread}/steps`)).json()) as Json;
    expect((again.steps as Json[])[0].steps.map((s: Json) => s.status)).toEqual(["done", "doing"]);
  }, 30_000);

  test("a guided review's whole file, picture sides, Markdown picture and package changes: that machine's, for the window only", async () => {
    for (const [here, there] of both()) {
      const id = there.review.message;
      const guide = `/api/inbox/m/${there.id}/messages/${id}/guide`;
      const reads = {
        file: `${guide}/file?path=${encodeURIComponent("src/retry.ts")}`,
        image: `${guide}/review-image?path=${encodeURIComponent("assets/chart.png")}&side=new&snapshot=${id}`,
        markdown: `${guide}/review-markdown-image?doc=NOTES.md&side=new&src=${encodeURIComponent("assets/chart.png")}&snapshot=${id}`,
        packages: `${guide}/package-changes?snapshot=${id}`,
      };

      const file = await windowGet(here, reads.file);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(file.headers.get("cache-control")).toBe("no-store");
      expect(((await file.json()) as Json).newContent).toBe(`export const tries = 5;\n// ${there.name}\n`);

      for (const picture of [reads.image, reads.markdown]) {
        const answer = await windowGet(here, picture);
        expect(answer.status).toBe(200);
        // An image only, under this Inbox's picture headers: that machine's bytes.
        expect(answer.headers.get("content-type")).toBe("image/png");
        expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
        expect(answer.headers.get("content-security-policy")).toBeTruthy();
        expect(Buffer.from(await answer.arrayBuffer()).equals(png(`${there.name} after`))).toBe(true);
      }

      const cards = (await (await windowGet(here, reads.packages)).json()) as { cards: { path: string; changes: { name: string; kind: string }[] }[] };
      expect(cards.cards.flatMap((card) => card.changes.map((c) => `${card.path} ${c.name} ${c.kind}`)).sort()).toEqual(["package.json left-pad upgraded", "package.json tiny-queue added"]);

      // An agent's or a script's bare call on this computer: refused here, as a far file is.
      for (const path of Object.values(reads)) {
        const bare = await fetch(`${at(here)}${path}`);
        expect([path, bare.status, ((await bare.json()) as Json).code]).toEqual([path, 403, "window_only"]);
      }
    }
    // A phone's token at Laptop's door: the unknown route, as before these reads were on it.
    const id = laptop.review.message;
    for (const [method, route] of [
      ["GET", `messages/${id}/guide/file?path=src%2Fretry.ts`],
      ["GET", `messages/${id}/guide/review-image?path=assets%2Fchart.png&side=new&snapshot=${id}`],
      ["GET", `messages/${id}/guide/review-markdown-image?doc=NOTES.md&side=new&src=assets%2Fchart.png&snapshot=${id}`],
      ["GET", `messages/${id}/guide/package-changes?snapshot=${id}`],
      ["POST", `messages/${id}/guide/viewed`],
      ["GET", `threads/${laptop.review.thread}/steps`],
      ["GET", `open-in/file/code?thread=${laptop.review.thread}&path=src%2Fretry.ts`],
      ["GET", `open-in/file?thread=${laptop.review.thread}&path=src%2Fretry.ts`],
    ] as const) {
      const phone = await fetch(`${at(laptop)}/api/inbox/device/${route}`, {
        method,
        headers: { Authorization: `Bearer ${phoneToken}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify({ path: "src/retry.ts", viewed: true, idempotency_key: "phone-1" }) } : {}),
      });
      expect([route, phone.status, ((await phone.json()) as Json).code]).toEqual([route, 404, "device_route_not_found"]);
    }
    expect(viewedThere(laptop)).toEqual([]);
  }, 60_000);

  test("a code span's hover and the file check: answered for the window through the real door, refused there without its mark", async () => {
    for (const [here, there] of both()) {
      const query = new URLSearchParams({ thread: there.review.thread, message: there.review.message, path: "src/retry.ts" }).toString();
      // The window's read: the forward adds the window's mark, the far door's dispatch keeps it, and the far Inbox answers.
      const hover = await windowGet(here, `/api/inbox/m/${there.id}/open-in/file/code?${query}`);
      expect(hover.status).toBe(200);
      expect(((await hover.json()) as Json).contents).toBe(`export const tries = 5;\n// ${there.name}\n`);
      const check = (await (await windowGet(here, `/api/inbox/m/${there.id}/open-in/file?${query}`)).json()) as Json;
      expect(check.found).toBe(true);
      // The path on that machine (its Copy path), never one on this computer.
      expect(check.path).toBe(join(there.project, "src/retry.ts"));
      // A bare call here, and this machine's own token at that door without the window's mark: refused.
      expect((await fetch(`${at(here)}/api/inbox/m/${there.id}/open-in/file/code?${query}`)).status).toBe(403);
      const door = (headers: Record<string, string>) => fetch(`${at(there)}/api/inbox/device/open-in/file/code?${query}`, { headers: { Authorization: `Bearer ${here.tokenThere}`, ...headers } });
      const unmarked = await door({});
      expect([unmarked.status, ((await unmarked.json()) as Json).code]).toEqual([403, "window_only"]);
      expect((await door({ "X-Plannotator-Window": "1" })).status).toBe(200);
      // Launching an app there is on no door.
      const launch = await windowPost(here, `/api/inbox/m/${there.id}/open-in/file`, { thread: there.review.thread, path: "src/retry.ts", app_id: "vscode" });
      expect(launch.ok).toBe(false);
    }
  }, 60_000);

  test("Viewed, one file's change: held while that machine is away, then lands once; a tick before it and one made there meanwhile both stay", async () => {
    for (const [here, there] of both()) {
      const route = `/api/inbox/m/${there.id}/messages/${there.review.message}/guide/viewed`;
      // This computer's own review, as it was: no tick of the other's lands here.
      const ownBefore = viewedThere(here);
      // Online: it lands there at once.
      const now = await windowPost(here, route, { path: "src/retry.ts", viewed: true });
      expect(now.status).toBe(200);
      expect(viewedThere(there)).toEqual(["src/retry.ts"]);
      // Ticked on that machine's own window, after this window last read the review.
      expect((await windowPost(there, `/api/inbox/messages/${there.review.message}/guide/viewed`, { path: "NOTES.md", viewed: true })).status).toBe(200);

      await whileAway(there, here, async () => {
        // A tick while it is away: held, never refused.
        const held = await windowPost(here, route, { path: "assets/chart.png", viewed: true });
        expect(held.status).toBe(202);
        // The review opened again (its outbox read), then a second file ticked: both wait, each as its own file.
        const reopened = await heldFor(here, there);
        expect(reopened.map((e) => e.viewed)).toEqual([{ path: "assets/chart.png", viewed: true }]);
        expect((await windowPost(here, route, { path: "package.json", viewed: true })).status).toBe(202);
        expect((await heldFor(here, there)).map((e) => e.viewed)).toEqual([
          { path: "assets/chart.png", viewed: true },
          { path: "package.json", viewed: true },
        ]);
      });
      await waitFor(`the held ticks land on ${there.name}`, async () => (await heldFor(here, there)).length === 0, 30_000);
      // Every tick: the one before, the one made there meanwhile, and both held ones; none undone, none twice.
      expect(viewedThere(there)).toEqual(["NOTES.md", "assets/chart.png", "package.json", "src/retry.ts"]);
      expect(new Set(there.server.store.message(there.review.message)!.guide_viewed).size).toBe(4);
      expect(viewedThere(here)).toEqual(ownBefore);
    }
  }, 240_000);

  test("search with a Tag filter finds the far thread by the far computer's tag", async () => {
    for (const [here, there] of both()) {
      const tag = there.server.store.createInitiative({ name: `Release on ${there.name}`, by: { kind: "person" } });
      expect((await windowPost(there, `/api/inbox/threads/${there.review.thread}/tags`, { tag: tag.id, on: true })).status).toBe(200);
      const found = await waitFor(`${there.name}'s tagged thread in ${here.name}'s search`, async () => {
        const answer = await getJson(here, `/api/inbox/search?q=${encodeURIComponent("Retry budget")}&tag=${tag.id}&machines=1`);
        const rows = (answer.groups?.threads ?? []) as Json[];
        return rows.some((row) => row.thread_id === there.review.thread) ? { answer, rows } : null;
      });
      expect(found.rows.find((row) => row.thread_id === there.review.thread)!.project.machine).toBe(there.id);
      // This computer's own thread is in no tag of that id: not found by it.
      expect(found.rows.some((row) => row.thread_id === here.review.thread)).toBe(false);
      expect(found.answer.unanswered).toBeUndefined();
    }
  }, 60_000);
});

describe("an older linked machine (its list names no `linked-reads`)", () => {
  test("a search without a Tag filter asks it as before; a Tag search never asks it, and does not name it unanswered", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-linked-reads-older-")));
    const id = "ibx_01K0000000000000000000000Q";
    const asked: string[] = [];
    const door = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch(req) {
        const url = new URL(req.url);
        const route = url.pathname.replace("/api/inbox/device/", "");
        asked.push(`${route}${url.search}`);
        if (route === "health") return Response.json({ ok: true, inbox_id: id, machine_links: 1, version: "0.28.62" });
        if (route === "events") return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":0}\n\n`)) }), { headers: { "Content-Type": "text/event-stream" } });
        if (route === "threads") return Response.json({ cursor: 0, sections: [{ id: "new", threads: [] }], projects: [], pins: [], marks: ["tags"] });
        if (route === "search") return Response.json({ serverSession: "s", q: url.searchParams.get("q") ?? "", terms: [], took_ms: 1, indexing: false, threads: 0, totals: { threads: 0, messages: 0, files: 0, projects: 0, comments: 0 }, groups: { threads: [] }, recent: null });
        return Response.json({ code: "device_route_not_found", error: "Not a phone route." }, { status: 404 });
      },
    });
    const dataDir = join(root, "data");
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "machines.json"), JSON.stringify({ v: 1, self: { id: "ibx_01K00000000000000000000009" }, links: [{ id, name: "Laptop", token: "tok_0", transport: { kind: "tailnet", url: `http://127.0.0.1:${door.port}` }, device_id: null, linked_at: "2026-11-20T00:00:00Z" }] }), { mode: 0o600 });
    const sandboxWas = process.env.PLANNOTATOR_TEST_SANDBOX;
    process.env.PLANNOTATOR_TEST_SANDBOX = "1";
    const inbox = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale, readProjectRepo: async () => null });
    const base = `http://127.0.0.1:${inbox.port}`;
    try {
      await waitFor("the older machine's list", async () => {
        const view = (((await (await fetch(`${base}/api/inbox/machines`)).json()) as Json).machines as Json[]).find((m) => m.id === id);
        return view?.state === "online" && typeof view.list_cursor === "number";
      });
      const searches = () => asked.filter((one) => one.startsWith("search")).length;
      // Without a Tag filter it is asked, as before (once this Inbox's own index is ready).
      await waitFor("the older machine asked a plain search", async () => {
        await fetch(`${base}/api/inbox/search?q=notes&machines=1`);
        return searches() > 0;
      });
      const before = searches();
      const tag = inbox.store.createInitiative({ name: "Release", by: { kind: "person" } });
      const tagged = (await (await fetch(`${base}/api/inbox/search?q=notes&tag=${tag.id}&machines=1`)).json()) as Json;
      expect(tagged.unanswered).toBeUndefined();
      expect(searches()).toBe(before);
      // And nothing of the new reads was ever asked of it by the server on its own.
      expect(asked.filter((one) => /steps|guide\/|open-in\//.test(one))).toEqual([]);
    } finally {
      inbox.stop();
      door.stop(true);
      if (sandboxWas === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
      else process.env.PLANNOTATOR_TEST_SANDBOX = sandboxWas;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
