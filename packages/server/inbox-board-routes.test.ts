/**
 * The Board page's server routes (approval "inbox-board", step 2) on a real
 * Inbox, with a scripted gh (never the real one): an opened card's links read
 * through the hover cards' resolver only when asked, with their live state,
 * refused to another site; a card's history; and the first-visit dialog
 * claimed once per machine. What regresses: a link fetched before the card is
 * opened, a host outside the hover cards' rules being asked, the dialog
 * showing on every visit (or to two tabs), or a read-only config showing it
 * forever.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "./inbox";
import type { RefCli, RefCommandResult, RefRunner } from "./ref-cards";

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

async function world() {
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
  const server = await startInboxServer({ dataDir, binaryPath: null, refRunner: run, phones: false, board: true });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const project = server.store.ensureProject({ name: "web", root: join(root, "web") });
  const post = (path: string, body: Record<string, unknown> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { dataDir, server, base, project, calls, post };
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

  test("a card and its history, newest first", async () => {
    const { server, base, project } = await world();
    const { card } = server.store.createCard({ project_id: project.id, by: { kind: "person" }, title: "Roadmap" });
    server.store.updateCard(card.id, { by: { kind: "person" }, column: "designing" });
    const answer = (await (await fetch(`${base}/api/inbox/cards/${card.id}`)).json()) as { card: { id: string }; history: { kind: string }[] };
    expect(answer.card.id).toBe(card.id);
    expect(answer.history.map((entry) => entry.kind)).toEqual(["moved", "created"]);
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
