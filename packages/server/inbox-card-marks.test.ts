/**
 * The Board's lane marks (owner, 2026-10-26: "a symbol ... to indicate merged
 * vs unmerged"), with a scripted gh and glab (never the real ones). What
 * regresses: one gh per link instead of one per repository, a host this
 * computer is not signed in to being asked, a fetch on every Board render
 * (no cache), an error drawn instead of a quiet unknown, or the route
 * answering while the Board is off, another site or a stale tab.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxCardRef } from "@plannotator/core/inbox-types";
import { inboxCardMarkRef } from "@plannotator/core/inbox-types";
import { CARD_MARK_FAILURE_MS, CARD_MARK_FRESH_MS, CARD_MARK_REFRESH_MS, createCardMarks, githubMarksQuery } from "./inbox-card-marks";
import { startInboxServer, type InboxServer } from "./inbox";
import type { RefCards, RefCli, RefCommandResult, RefRunner } from "./ref-cards";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";

type Node = Record<string, unknown>;
const pr = (state: string, title: string, isDraft = false): Node => ({ __typename: "PullRequest", state, isDraft, title });
const issue = (state: string, title: string, stateReason: string | null = null): Node => ({ __typename: "Issue", state, stateReason, title });

/** A scripted gh: answers the batch query from `repos[owner/repo][number]`; records every call. */
function scriptedGh(repos: Record<string, Record<number, Node | null>>, signedIn: string[] = ["github.com"]) {
  const calls: { cli: RefCli; args: string[] }[] = [];
  const run: RefRunner = async (cli, args): Promise<RefCommandResult> => {
    calls.push({ cli, args });
    if (args[0] === "auth") {
      const hosts = Object.fromEntries(signedIn.map((h) => [h, [{ login: "me", active: true, state: "success" }]]));
      return { stdout: JSON.stringify({ hosts }), stderr: "", exitCode: 0 };
    }
    const field = (name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
    const repo = repos[`${field("owner")}/${field("repo")}`];
    if (!repo) return { stdout: "", stderr: "GraphQL: Could not resolve to a Repository with the name 'x'. (repository)", exitCode: 1 };
    const numbers = [...field("query").matchAll(/n(\d+): issueOrPullRequest/g)].map((m) => Number(m[1]));
    const data: Record<string, Node | null> = {};
    for (const n of numbers) data[`n${n}`] = repo[n] ?? null;
    const missing = numbers.some((n) => !repo[n]);
    return { stdout: JSON.stringify({ data: { repository: data }, ...(missing ? { errors: [{ type: "NOT_FOUND" }] } : {}) }), stderr: "", exitCode: missing ? 1 : 0 };
  };
  const graphql = () => calls.filter((c) => c.args[0] === "api");
  return { run, calls, graphql };
}

const gh = (owner: string, repo: string, n: number, kind: "pr" | "issue" = "pr"): InboxCardRef => ({
  kind,
  source: "github",
  ref: `${owner}/${repo}#${n}`,
  url: `https://github.com/${owner}/${repo}/${kind === "pr" ? "pull" : "issues"}/${n}`,
});

describe("the marks reader", () => {
  test("one gh query per repository, whatever the number of links; each state in the forge's words", async () => {
    const forge = scriptedGh({
      "acme/widgets": { 12: pr("MERGED", "vite 8"), 14: pr("OPEN", "Delivery ticks"), 15: pr("OPEN", "WIP", true), 16: pr("CLOSED", "Dropped idea"), 11: issue("OPEN", "Icon"), 9: issue("CLOSED", "Done"), 8: issue("CLOSED", "Won't", "NOT_PLANNED") },
      "acme/site": { 3: pr("OPEN", "Hero") },
    });
    const marks = createCardMarks({ run: forge.run });
    const refs = [gh("acme", "widgets", 12), gh("acme", "widgets", 14), gh("acme", "widgets", 15), gh("acme", "widgets", 16), gh("acme", "widgets", 11, "issue"), gh("acme", "widgets", 9, "issue"), gh("acme", "widgets", 8, "issue"), gh("acme", "site", 3)];
    const out = await marks.marks(refs);
    expect(forge.graphql()).toHaveLength(2);
    for (const call of forge.graphql()) {
      expect(call.args).toContain("--hostname");
      expect(call.args[call.args.indexOf("--hostname") + 1]).toBe("github.com");
      expect(call.args.find((a) => a.startsWith("query="))!.slice(6)).toMatch(/^query CardMarks\(/);
    }
    expect(refs.map((r) => out.get(r.url)!.state)).toEqual(["merged", "open", "draft", "closed", "open", "completed", "not_planned", "open"]);
    expect(out.get(refs[0]!.url)).toEqual({ kind: "pr", ref: "acme/widgets#12", url: refs[0]!.url, state: "merged", title: "vite 8" });
    expect(out.get(refs[4]!.url)!.kind).toBe("issue");
  });

  test("a partial answer keeps the links it has; a refused repository is unknown, quietly", async () => {
    const forge = scriptedGh({ "acme/widgets": { 12: pr("MERGED", "vite 8") } });
    const marks = createCardMarks({ run: forge.run });
    const out = await marks.marks([gh("acme", "widgets", 12), gh("acme", "widgets", 404), gh("acme", "secret", 1)]);
    expect(out.get(gh("acme", "widgets", 12).url)!.state).toBe("merged");
    expect(out.get(gh("acme", "widgets", 404).url)!.state).toBe("unknown");
    expect(out.get(gh("acme", "secret", 1).url)!.state).toBe("unknown");
  });

  test("cached: a second Board read runs nothing; a focus refresh re-reads what is older than 30 s; fresh for 5 min", async () => {
    let clock = 1_000_000;
    const forge = scriptedGh({ "acme/widgets": { 12: pr("OPEN", "vite 8") } });
    const marks = createCardMarks({ run: forge.run, now: () => clock });
    await marks.marks([gh("acme", "widgets", 12)]);
    await marks.marks([gh("acme", "widgets", 12)]);
    expect(forge.graphql()).toHaveLength(1);
    // Requests that overlap share one query.
    clock += CARD_MARK_FRESH_MS;
    await Promise.all([marks.marks([gh("acme", "widgets", 12)]), marks.marks([gh("acme", "widgets", 12)])]);
    expect(forge.graphql()).toHaveLength(2);
    clock += CARD_MARK_REFRESH_MS - 1;
    await marks.marks([gh("acme", "widgets", 12)], { refresh: true });
    expect(forge.graphql()).toHaveLength(2);
    clock += 2;
    await marks.marks([gh("acme", "widgets", 12)], { refresh: true });
    expect(forge.graphql()).toHaveLength(3);
  });

  test("a failure is unknown and held off for a minute; a rate limit holds the host", async () => {
    let clock = 0;
    let answer: RefCommandResult = { stdout: "", stderr: "gh: API rate limit exceeded", exitCode: 1 };
    const calls: string[][] = [];
    const run: RefRunner = async (_cli, args) => {
      calls.push(args);
      return answer;
    };
    const marks = createCardMarks({ run, now: () => clock });
    expect((await marks.marks([gh("acme", "widgets", 12)])).get(gh("acme", "widgets", 12).url)!.state).toBe("unknown");
    expect(calls).toHaveLength(1);
    // Another repository on the same host while it is held: nothing runs.
    await marks.marks([gh("acme", "other", 1)]);
    expect(calls).toHaveLength(1);
    clock += CARD_MARK_FAILURE_MS;
    answer = { stdout: JSON.stringify({ data: { repository: { n12: pr("MERGED", "vite 8") } } }), stderr: "", exitCode: 0 };
    expect((await marks.marks([gh("acme", "widgets", 12)])).get(gh("acme", "widgets", 12).url)!.state).toBe("merged");
  });

  test("a host this computer's gh is not signed in to is never asked; one it is signed in to is", async () => {
    const forge = scriptedGh({ "corp/app": { 7: pr("OPEN", "Enterprise") } }, ["github.com", "github.corp.example"]);
    const marks = createCardMarks({ run: forge.run });
    const evil: InboxCardRef = { kind: "pr", source: "github", ref: "evil/x#1", url: "https://github.evil.example/evil/x/pull/1" };
    const ghe: InboxCardRef = { kind: "pr", source: "github", ref: "corp/app#7", url: "https://github.corp.example/corp/app/pull/7" };
    const out = await marks.marks([evil, ghe]);
    expect(out.get(evil.url)!.state).toBe("unknown");
    expect(out.get(ghe.url)!.state).toBe("open");
    expect(forge.graphql().map((c) => c.args[c.args.indexOf("--hostname") + 1])).toEqual(["github.corp.example"]);
  });

  test("GitLab through the hover cards' lookup; Bitbucket has no reader and is unknown without running anything", async () => {
    const asked: string[] = [];
    const refCards: RefCards = {
      async get(href) {
        asked.push(href);
        return { ok: true, fetchedAt: 0, data: { state: "merged", title: "MR" } as never };
      },
    };
    const forge = scriptedGh({});
    const marks = createCardMarks({ run: forge.run, refCards });
    const mr: InboxCardRef = { kind: "pr", source: "gitlab", ref: "grp/proj!7", url: "https://gitlab.com/grp/proj/-/merge_requests/7" };
    const bb: InboxCardRef = { kind: "pr", source: "bitbucket", ref: "ws/repo#2", url: "https://bitbucket.org/ws/repo/pull-requests/2" };
    const out = await marks.marks([mr, bb]);
    expect(out.get(mr.url)!.state).toBe("merged");
    expect(out.get(bb.url)!.state).toBe("unknown");
    expect(asked).toEqual([mr.url]);
    expect(forge.calls).toEqual([]);
  });

  test("the query asks only whole numbers, and only state and title", () => {
    expect(() => githubMarksQuery([1.5])).toThrow();
    expect(() => githubMarksQuery([0])).toThrow();
    const query = githubMarksQuery([12, 14]);
    expect(query).toMatch(/^query /);
    expect(query).not.toMatch(/body|comments|author|mutation/);
  });

  test("a card marks its latest pull request, else its latest issue", () => {
    const refs = [gh("a", "b", 1), gh("a", "b", 2, "issue"), gh("a", "b", 3), gh("a", "b", 4, "issue")];
    expect(inboxCardMarkRef({ refs, prs: [] })!.ref).toBe("a/b#3");
    expect(inboxCardMarkRef({ refs: refs.filter((r) => r.kind === "issue"), prs: [] })!.ref).toBe("a/b#4");
    expect(inboxCardMarkRef({ refs: [], prs: [] })).toBeNull();
  });
});

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
const savedTailscale = process.env.PLANNOTATOR_INBOX_TAILSCALE;
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  if (savedTailscale === undefined) delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
  else process.env.PLANNOTATOR_INBOX_TAILSCALE = savedTailscale;
});

/** A scripted tailscale that publishes the Inbox (as inbox-pins.test.ts): no real tailscale runs. */
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

async function world(board: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-card-marks-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const forge = scriptedGh({ "acme/widgets": { 12: pr("MERGED", "vite 8"), 14: pr("OPEN", "Delivery ticks"), 11: issue("OPEN", "Icon") } });
  const server = await startInboxServer({ dataDir, binaryPath: null, refRunner: forge.run, phones: false, board });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const project = server.store.ensureProject({ name: "web", root: join(root, "web") });
  const agent = { kind: "agent", host: "codex", session: "s", name: "Codex" } as const;
  const make = (title: string, prs: string[] = [], refs: string[] = []) => server.store.createCard({ project_id: project.id, by: agent, title, prs, refs }).card;
  const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/inbox/cards/marks`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { server, forge, make, post };
}

describe("POST /api/inbox/cards/marks", () => {
  test("the cards on screen, one mark each, from one gh query; a card with no link has none", async () => {
    const w = await world(true);
    const merged = w.make("vite 8", ["acme/widgets#12"]);
    const open = w.make("Ticks", ["acme/widgets#14"]);
    const iss = w.make("Icon", [], ["acme/widgets#11"]);
    const plain = w.make("No links");
    expect(w.forge.graphql()).toHaveLength(0);
    const answer = await w.post({ cards: [merged.id, open.id, iss.id, plain.id] });
    expect(answer.status).toBe(200);
    const { marks } = (await answer.json()) as { marks: Record<string, { state: string; kind: string; ref: string; title: string }> };
    expect(marks[merged.id]).toMatchObject({ kind: "pr", ref: "acme/widgets#12", state: "merged", title: "vite 8" });
    expect(marks[open.id]!.state).toBe("open");
    expect(marks[iss.id]).toMatchObject({ kind: "issue", state: "open" });
    expect(marks[plain.id]).toBeUndefined();
    expect(w.forge.graphql()).toHaveLength(1);
    // A mark never moves a card.
    expect(w.server.store.card(merged.id)!.column).toBe("backlog");
  });

  test("refused while the Board is off, to another site, to a stale tab, and for bad ids; nothing runs", async () => {
    const off = await world(false);
    const card = off.make("vite 8", ["acme/widgets#12"]);
    const refused = await off.post({ cards: [card.id] });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("board_off");
    const on = await world(true);
    const c = on.make("vite 8", ["acme/widgets#12"]);
    expect((await on.post({ cards: [c.id] }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await on.post({ cards: [c.id] }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await on.post({ cards: [c.id], serverSession: "not-this-one" })).status).toBe(409);
    expect((await on.post({ cards: ["nope"] })).status).toBe(422);
    expect((await on.post({ cards: Array.from({ length: 201 }, () => c.id) })).status).toBe(422);
    expect(off.forge.calls).toEqual([]);
    expect(on.forge.graphql()).toHaveLength(0);
  });

  // What regresses: a page opened over the tailnet (another device) makes this computer run gh.
  test("over the tailnet, even the owner is refused 403 local only, and nothing runs", async () => {
    const MAGIC = "macbook-pro.tail0000.ts.net";
    const OWNER = "ramos@example.com";
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-card-marks-tailnet-")));
    roots.push(root);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: true, inboxBoard: true }));
    const forge = scriptedGh({ "acme/widgets": { 12: pr("MERGED", "vite 8") } });
    const server = await startInboxServer({ dataDir, binaryPath: null, refRunner: forge.run, phones: false, board: true, tailscale: scriptedTailscale(MAGIC, OWNER) });
    servers.push(server);
    const project = server.store.ensureProject({ name: "web", root: join(root, "web") });
    const card = server.store.createCard({ project_id: project.id, by: { kind: "agent", host: "codex", session: "s", name: "Codex" }, title: "vite 8", prs: ["acme/widgets#12"], refs: [] }).card;
    const listener = server.tailscale.listenerPort();
    expect(listener).not.toBeNull();
    const body = JSON.stringify({ serverSession: server.serverSession, cards: [card.id] });
    const owner = { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": OWNER, Origin: `https://${MAGIC}:${server.port}`, "Content-Type": "application/json" };
    const over = await fetch(`http://127.0.0.1:${listener}/api/inbox/cards/marks`, { method: "POST", headers: owner, body });
    expect(over.status).toBe(403);
    expect(((await over.json()) as { code: string }).code).toBe("local_only");
    expect(forge.calls).toEqual([]);
    // The same request from this computer's window answers.
    const local = await fetch(`http://127.0.0.1:${server.port}/api/inbox/cards/marks`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(local.status).toBe(200);
    expect(forge.graphql()).toHaveLength(1);
  });
});
