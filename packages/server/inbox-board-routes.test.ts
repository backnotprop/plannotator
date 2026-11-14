/**
 * The Board page's server routes (approval "inbox-board", step 2) on a real
 * Inbox, with a scripted gh (never the real one): an opened card's links read
 * through the hover cards' resolver only when asked, with their live state,
 * refused to another site; a card's history; and the first-visit dialog
 * claimed once per machine. What regresses: a link fetched before the card is
 * opened, a host outside the hover cards' rules being asked, a Jira issue URL
 * refused (or fetched) again, a YouTrack issue or any web link refused,
 * stored twice or fetched, a favicon fetched for a link an agent added, the dialog
 * showing on every visit (or to two tabs), or a read-only config showing it
 * forever.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "./inbox";
import type { RefCli, RefCommandResult, RefRunner } from "./ref-cards";
import type { CardFaviconOptions } from "./inbox-card-favicons";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import type { InboxProjectRepo } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const ok = (stdout: unknown): RefCommandResult => ({ stdout: JSON.stringify(stdout), stderr: "", exitCode: 0 });

function merged(number: number, title: string) {
  return {
    data: {
      repository: {
        nameWithOwner: "acme/widgets",
        issueOrPullRequest: {
          __typename: "PullRequest",
          number,
          title,
          url: `https://github.com/acme/widgets/pull/${number}`,
          state: "MERGED",
          isDraft: false,
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-02T00:00:00Z",
          closedAt: "2026-10-02T00:00:00Z",
          mergedAt: "2026-10-02T00:00:00Z",
          body: "",
          author: { login: "ada", avatarUrl: null },
          labels: { nodes: [] },
          assignees: { nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          baseRefName: "main",
          headRefName: "x",
          additions: 1,
          deletions: 1,
          changedFiles: 1,
          reviewDecision: null,
          closingIssuesReferences: { nodes: [] },
          commits: { nodes: [] },
        },
      },
    },
  };
}

async function world(options: { readProjectRepo?: (root: string) => Promise<InboxProjectRepo | null>; cardFavicons?: CardFaviconOptions } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-board-routes-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  // The Inbox reads config.json through the env, even when handed dataDir.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const calls: { cli: RefCli; args: string[] }[] = [];
  const run: RefRunner = async (cli, args) => {
    calls.push({ cli, args });
    return ok(merged(12, "vite 8 for the review app"));
  };
  const server = await startInboxServer({ dataDir, binaryPath: null, refRunner: run, phones: false, board: true, ...options });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const project = server.store.ensureProject({ name: "web", root: join(root, "web") });
  const post = (path: string, body: Record<string, unknown> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { dataDir, server, base, project, calls, post };
}

/** A scripted `tailscale` that serves this Inbox over a tailnet `magic` name, `owner` its login (as inbox-card-marks.test.ts). */
function scriptedTailscale(magic: string, owner: string): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${magic}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: owner } } }));
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      return ok(
        JSON.stringify({
          TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
          Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${magic}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
        }),
      );
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok(`https://${magic}:${httpsPort}/\n`);
  };
}

/** An agent's `card` tool call over `/mcp`, as Claude Code makes it. */
function agentCardCall(base: string, projectRoot: string) {
  return async (args: Record<string, unknown>) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card", arguments: { project_path: projectRoot, agent_session: "ses_y", agent_host: "claude-code", ...args } } }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    return JSON.parse(data ? data.slice(5) : text).result as { isError?: boolean; content: { text: string }[]; structuredContent?: { card?: { refs: unknown[] } } };
  };
}

describe("the Board page's routes", () => {
  test("an opened card's links: read only when asked, with their live state; another site is refused", async () => {
    const { server, base, project, calls } = await world();
    const { card } = server.store.createCard({ project_id: project.id, by: { kind: "agent", host: "codex", session: "s", name: "Codex" }, title: "Forge", prs: ["acme/widgets#12"] });
    expect(calls).toEqual([]);
    const answer = await fetch(`${base}/api/inbox/cards/${card.id}/refs`);
    expect(answer.status).toBe(200);
    const { refs } = (await answer.json()) as { refs: { ref: { ref: string }; result: { ok: boolean; data?: { title: string; state: string } } }[] };
    expect(refs).toHaveLength(1);
    expect(refs[0]!.ref.ref).toBe("acme/widgets#12");
    expect(refs[0]!.result).toMatchObject({ ok: true, data: { title: "vite 8 for the review app", state: "merged" } });
    expect(calls.some((call) => call.cli === "gh" && call.args.includes("--hostname"))).toBe(true);
    expect((await fetch(`${base}/api/inbox/cards/${card.id}/refs`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await fetch(`${base}/api/inbox/cards/crd_00000000000000000000000000/refs`)).status).toBe(404);
  });

  test("a Jira issue URL links through the agent's card call: stored as its key, kept on reopen, never fetched", async () => {
    const { dataDir, server, base, project, calls } = await world();
    mkdirSync(project.root, { recursive: true });
    const mcp = async (args: Record<string, unknown>) => {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card", arguments: { project_path: project.root, agent_session: "ses_j", agent_host: "claude-code", ...args } } }),
      });
      const text = await response.text();
      const data = text.split("\n").find((line) => line.startsWith("data:"));
      return JSON.parse(data ? data.slice(5) : text).result as { isError?: boolean; content: { text: string }[]; structuredContent?: { card?: { refs: unknown[] } } };
    };
    const { card } = server.store.createCard({ project_id: project.id, by: { kind: "person" }, title: "Jira" });
    // User feedback #9's exact call.
    const linked = await mcp({ op: "link", card_id: card.id, ref: "https://example.atlassian.net/browse/DEMO-123" });
    expect(linked.isError ?? false).toBe(false);
    const jira = { kind: "issue", source: "jira", ref: "DEMO-123", url: "https://example.atlassian.net/browse/DEMO-123", via: "ref" };
    expect(linked.structuredContent?.card?.refs).toEqual([jira]);
    // The same issue pasted from a board is the same link, not a second one.
    const again = await mcp({ op: "link", card_id: card.id, ref: "https://example.atlassian.net/jira/software/projects/DEMO/boards/1?selectedIssue=DEMO-123" });
    expect(again.structuredContent?.card?.refs).toEqual([jira]);
    // The same key on another Jira site is another issue: both are kept.
    const other = { kind: "issue", source: "jira", ref: "DEMO-123", url: "https://jira.acme.corp/browse/DEMO-123", via: "ref" };
    const twoSites = await mcp({ op: "link", card_id: card.id, ref: other.url });
    expect(twoSites.structuredContent?.card?.refs).toEqual([jira, other]);
    // A page that only looks like Jira is a plain web link, never a Jira issue (checked in card-refs.test.ts);
    // a link that is no web link is refused, with the accepted forms in the answer.
    const refused = await mcp({ op: "link", card_id: card.id, ref: "javascript:alert(1)" });
    expect(refused.content[0]!.text).toStartWith("validation_error: ref:");
    expect(refused.content[0]!.text).toContain("http(s)");
    // Opened, it has no resolver: unsupported, and no gh or glab ran for it.
    const { refs } = (await (await fetch(`${base}/api/inbox/cards/${card.id}/refs`)).json()) as { refs: { ref: unknown; result: { ok: boolean; error?: string } }[] };
    const unsupported = { result: expect.objectContaining({ ok: false, error: "unsupported" }) };
    expect(refs).toEqual([{ ref: jira, ...unsupported }, { ref: other, ...unsupported }]);
    expect(calls).toEqual([]);
    // Stored like any ref: the card read back from disk keeps them.
    expect(InboxStore.open(dataDir).card(card.id)!.refs).toEqual([jira, other]);
  });

  test("a YouTrack issue and any web link link through the agent's card call: stored once each, kept on reopen, never fetched", async () => {
    const fetched: string[] = [];
    const { dataDir, server, base, project, calls } = await world({ cardFavicons: { fetch: async (url) => (fetched.push(url), new Response(null, { status: 404 })), lookup: async () => ["93.184.216.34"] } });
    mkdirSync(project.root, { recursive: true });
    const mcp = agentCardCall(base, project.root);
    const { card } = server.store.createCard({ project_id: project.id, by: { kind: "person" }, title: "Tickets" });
    // User feedback #10's case: a YouTrack ticket, as the browser's address bar has it (with the summary slug).
    const linked = await mcp({ op: "link", card_id: card.id, ref: "https://acme.youtrack.cloud/issue/PROJ-123/Crash-on-save" });
    expect(linked.isError ?? false).toBe(false);
    const youtrack = { kind: "issue", source: "youtrack", ref: "PROJ-123", url: "https://acme.youtrack.cloud/issue/PROJ-123", via: "ref" };
    expect(linked.structuredContent?.card?.refs).toEqual([youtrack]);
    // The same issue without its slug is the same link.
    expect((await mcp({ op: "link", card_id: card.id, ref: "https://acme.youtrack.cloud/issue/proj-123" })).structuredContent?.card?.refs).toEqual([youtrack]);
    // Any other web page: a plain link, once however it is pasted.
    const notion = { kind: "link", source: "web", ref: "notion.so/acme/Roadmap-2026", url: "https://www.notion.so/acme/Roadmap-2026", via: "ref" };
    await mcp({ op: "link", card_id: card.id, ref: notion.url });
    const twice = await mcp({ op: "link", card_id: card.id, ref: "https://WWW.Notion.so:443/acme/Roadmap-2026" });
    expect(twice.structuredContent?.card?.refs).toEqual([youtrack, notion]);
    // Opened: no resolver reads either (unsupported), no gh or glab ran, and no favicon was asked for an agent's link.
    const { refs } = (await (await fetch(`${base}/api/inbox/cards/${card.id}/refs`)).json()) as { refs: { ref: unknown; result: { ok: boolean; error?: string } }[] };
    const unsupported = { result: expect.objectContaining({ ok: false, error: "unsupported" }) };
    expect(refs).toEqual([{ ref: youtrack, ...unsupported }, { ref: notion, ...unsupported }]);
    expect(calls).toEqual([]);
    expect(fetched).toEqual([]);
    expect(InboxStore.open(dataDir).card(card.id)!.refs).toEqual([youtrack, notion]);
  });

  test("a web link's favicon: fetched and served from this origin only for a link the person added, never an agent's", async () => {
    const fetched: { url: string; init: RequestInit }[] = [];
    const ico = new Uint8Array(64);
    ico.set([0, 0, 1, 0, 1, 0]);
    const { server, base, project, post } = await world({
      cardFavicons: {
        fetch: async (url, init) => {
          fetched.push({ url, init });
          return new Response(ico, { headers: { "content-type": "image/vnd.microsoft.icon" } });
        },
        lookup: async () => ["93.184.216.34"],
      },
    });
    const { card } = server.store.createCard({ project_id: project.id, by: { kind: "person" }, title: "Links" });
    const agentLink = "https://linear.app/acme/issue/ENG-1";
    const personLink = "https://www.notion.so/acme/Roadmap";
    server.store.updateCard(card.id, { by: { kind: "agent", host: "codex", session: "s", name: "Codex" }, refs: [agentLink] });
    expect((await post(`/api/inbox/cards/${card.id}`, { op: "link", ref: personLink })).status).toBe(200);
    const stored = server.store.card(card.id)!.refs!;
    expect(stored.find((ref) => ref.url === agentLink)!.by).toBeUndefined();
    expect(stored.find((ref) => ref.url === personLink)!.by).toBe("person");
    const favicon = (link: string, headers: Record<string, string> = {}) => fetch(`${base}/api/inbox/cards/${card.id}/favicon?url=${encodeURIComponent(link)}`, { headers });

    // An agent's link: refused before anything is fetched.
    const refused = await favicon(agentLink);
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { code: string }).code).toBe("favicon_not_yours");
    expect(fetched).toEqual([]);

    // The person's link: its host's /favicon.ico, no redirects followed blindly, no credentials; served as an image, never a page.
    const served = await favicon(personLink);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/x-icon");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(ico);
    expect(fetched.map((call) => call.url)).toEqual(["https://www.notion.so/favicon.ico"]);
    expect(fetched[0]!.init).toMatchObject({ redirect: "manual", credentials: "omit" });
    // Cached per host: asked again, nothing is fetched.
    expect((await favicon(personLink)).status).toBe(200);
    expect(fetched).toHaveLength(1);

    // A link not on the card, another site's page, and a write are refused.
    expect((await favicon("https://example.org/")).status).toBe(404);
    expect((await favicon(personLink, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await fetch(`${base}/api/inbox/cards/${card.id}/favicon?url=${encodeURIComponent(personLink)}`, { method: "POST" })).status).toBe(405);

    // The person linking the agent's link makes it theirs.
    await post(`/api/inbox/cards/${card.id}`, { op: "link", ref: agentLink });
    expect(server.store.card(card.id)!.refs!.find((ref) => ref.url === agentLink)!.by).toBe("person");
    expect((await favicon(agentLink)).status).toBe(200);
    expect(fetched.map((call) => call.url)).toEqual(["https://www.notion.so/favicon.ico", "https://linear.app/favicon.ico"]);
  });

  test("a favicon is never fetched with the Board off; the owner over the tailnet gets it (review of #2540, P3-2)", async () => {
    const MAGIC = "macbook-pro.tail0000.ts.net";
    const OWNER = "ramos@example.com";
    const savedTailscale = process.env.PLANNOTATOR_INBOX_TAILSCALE;
    delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
    try {
      const fetched: string[] = [];
      const ico = new Uint8Array(64);
      ico.set([0, 0, 1, 0, 1, 0]);
      const cardFavicons: CardFaviconOptions = {
        fetch: async (url) => (fetched.push(url), new Response(ico, { headers: { "content-type": "image/x-icon" } })),
        lookup: async () => ["93.184.216.34"],
      };
      const start = async (board: boolean) => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-board-favicon-")));
        roots.push(root);
        const dataDir = join(root, "data");
        mkdirSync(dataDir, { recursive: true });
        process.env.PLANNOTATOR_DATA_DIR = dataDir;
        writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: true, inboxBoard: board }));
        const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, board, cardFavicons, tailscale: scriptedTailscale(MAGIC, OWNER) });
        servers.push(server);
        const project = server.store.ensureProject({ name: "web", root: join(root, "web") });
        const { card } = server.store.createCard({ project_id: project.id, by: { kind: "person" }, title: "Links", refs: ["https://linear.app/acme/issue/ENG-1"] });
        const path = `/api/inbox/cards/${card.id}/favicon?url=${encodeURIComponent("https://linear.app/acme/issue/ENG-1")}`;
        return { server, path };
      };

      const on = await start(true);
      const listener = on.server.tailscale.listenerPort();
      expect(listener).not.toBeNull();
      const through = (login: string) =>
        fetch(`http://127.0.0.1:${listener}${on.path}`, { headers: { Host: `${MAGIC}:${on.server.port}`, "Tailscale-User-Login": login, Origin: `https://${MAGIC}:${on.server.port}` } });
      expect((await through(OWNER)).status).toBe(200);
      expect(fetched).toEqual(["https://linear.app/favicon.ico"]);

      const off = await start(false);
      const refused = await fetch(`http://127.0.0.1:${off.server.port}${off.path}`);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe("board_off");
      expect(fetched).toHaveLength(1);
    } finally {
      if (savedTailscale === undefined) delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
      else process.env.PLANNOTATOR_INBOX_TAILSCALE = savedTailscale;
    }
  });

  test("a card and its history, newest first", async () => {
    const { server, base, project } = await world();
    const { card } = server.store.createCard({ project_id: project.id, by: { kind: "person" }, title: "Roadmap" });
    server.store.updateCard(card.id, { by: { kind: "person" }, column: "in_progress" });
    const answer = (await (await fetch(`${base}/api/inbox/cards/${card.id}`)).json()) as { card: { id: string }; history: { kind: string }[] };
    expect(answer.card.id).toBe(card.id);
    expect(answer.history.map((entry) => entry.kind)).toEqual(["moved", "created"]);
  });

  test("an opened card carries its own project's repo, so its text links #123 there", async () => {
    const { server, base, project } = await world({
      readProjectRepo: async (root) => (root.endsWith("/tui") ? { display: "backnotprop/plannotator-tui", host: "github.com" } : { display: "acme/web", host: "github.com" }),
    });
    const tui = server.store.ensureProject({ name: "tui", root: join(project.root, "..", "tui") });
    const { card } = server.store.createCard({ project_id: tui.id, by: { kind: "person" }, title: "Hover cards" });
    let repo: unknown;
    // The repo resolves off the request path: the first read may still answer null.
    for (let i = 0; i < 100; i++) {
      repo = ((await (await fetch(`${base}/api/inbox/cards/${card.id}`)).json()) as { repo?: unknown }).repo;
      if (repo) break;
      await Bun.sleep(20);
    }
    expect(repo).toEqual({ display: "backnotprop/plannotator-tui", host: "github.com" });
  });

  test("the first-visit dialog: the first page to ask gets it, once per machine, kept in config.json", async () => {
    const { dataDir, base, post } = await world();
    expect(await (await post("/api/inbox/board/intro")).json()).toEqual({ show: true });
    expect(await (await post("/api/inbox/board/intro")).json()).toEqual({ show: false });
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxBoardIntro.shownAt).toMatch(/^\d{4}-/);
    expect((await post("/api/inbox/board/intro", { serverSession: "another" })).status).toBe(409);
    expect((await fetch(`${base}/api/inbox/board/intro`)).status).toBe(405);
  });
});

describe("the Board's initiatives over the routes (approval \"board-initiatives\")", () => {
  test("made, set on a card (and on a New card), renamed, deleted: the cards read follows each, and a delete leaves its cards in none", async () => {
    const { base, project, post } = await world();
    type Read = { cards: { id: string; initiative: string | null }[]; initiatives: { id: string; name: string; deleted_at: string | null }[] };
    const read = async () => (await (await fetch(`${base}/api/inbox/cards`)).json()) as Read;
    const made = (await (await post("/api/inbox/initiatives", { name: "Shape" })).json()) as { initiative: { id: string } };
    const id = made.initiative.id;
    const clash = await post("/api/inbox/initiatives", { name: "shape" });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { code: string }).code).toBe("initiative_exists");
    // A New card on a Board filtered to it starts in it.
    const fresh = (await (await post("/api/inbox/cards", { project: project.id, title: "Tokens pass", initiative: id })).json()) as { card: { id: string; initiative: string } };
    expect(fresh.card.initiative).toBe(id);
    const plain = (await (await post("/api/inbox/cards", { project: project.id, title: "Favicon" })).json()) as { card: { id: string; initiative: string | null } };
    expect(plain.card.initiative).toBeNull();
    const set = (await (await post(`/api/inbox/cards/${plain.card.id}`, { op: "initiative", initiative: id })).json()) as { card: { initiative: string } };
    expect(set.card.initiative).toBe(id);
    expect((await post(`/api/inbox/cards/${plain.card.id}`, { op: "initiative" })).status).toBe(422);
    expect((await post(`/api/inbox/initiatives/${id}`, { op: "rename", name: "Shape v2" })).status).toBe(200);
    let model = await read();
    expect(model.initiatives.map((i) => i.name)).toEqual(["Shape v2"]);
    expect(model.cards.filter((c) => c.initiative === id).length).toBe(2);
    expect((await post(`/api/inbox/initiatives/${id}`, { op: "delete" })).status).toBe(200);
    // The toast's Undo: the initiative and its cards back; deleted again for what follows.
    expect((await post(`/api/inbox/initiatives/${id}`, { op: "restore" })).status).toBe(200);
    expect(((await (await fetch(`${base}/api/inbox/cards`)).json()) as Read).cards.filter((c) => c.initiative === id).length).toBe(2);
    expect((await post(`/api/inbox/initiatives/${id}`, { op: "delete" })).status).toBe(200);
    model = await read();
    expect(model.initiatives[0]!.deleted_at).not.toBeNull();
    expect(model.cards.map((c) => c.initiative)).toEqual([null, null]);
    // A stale window's write is refused like every other.
    expect((await post("/api/inbox/initiatives", { name: "Memory", serverSession: "another" })).status).toBe(409);
    expect((await fetch(`${base}/api/inbox/initiatives`)).status).toBe(405);
  });
});

describe("# tags in the cards read (approval \"board-hashtags\")", () => {
  test("`initiative_threads`: the few latest tagged threads no card of it links, with their rows, and the total", async () => {
    const { server, base, project } = await world();
    const store = server.store;
    const shape = store.createInitiative({ name: "Shape", by: { kind: "person" } });
    const agent = { kind: "agent", host: "codex", session: "s", name: "Codex" } as const;
    const linked = store.sendMessage({ project_id: project.id, author: agent, body: "Card work #Shape", thread: "linked" }).message;
    const { card } = store.createCard({ project_id: project.id, by: agent, title: "Linked", threads: [linked.thread_id] });
    store.setCardInitiative(card.id, shape.id, { kind: "person" });
    const tagged = Array.from({ length: 7 }, (_, i) => store.sendMessage({ project_id: project.id, author: agent, body: `Note ${i} for #shape`, thread: `t${i}` }).message.thread_id);
    store.sendMessage({ project_id: project.id, author: agent, body: "Only `#Shape` in code", thread: "code" });
    type Read = { initiative_threads?: Record<string, { threads: string[]; total: number }>; threads: Record<string, unknown> };
    const model = (await (await fetch(`${base}/api/inbox/cards`)).json()) as Read;
    // Bounded: the 4 latest unlinked tagged threads (3 shown + the one being read), and how many in all.
    const latest = [...tagged].reverse();
    expect(model.initiative_threads).toEqual({ [shape.id]: { threads: latest.slice(0, 4), total: 7 } });
    // Rows: the linked card's own thread, and those 4.
    expect(Object.keys(model.threads).sort()).toEqual([linked.thread_id, ...latest.slice(0, 4)].sort());
  });
});
