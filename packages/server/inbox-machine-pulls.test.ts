/**
 * The PR board across linked machines (inbox-machine-pulls.ts), the module alone: what a linked machine's board may
 * put on this one, one row per PR with this machine's first, and when a far board is read. What regresses: a PR both
 * machines list shown twice or sent to the far machine; a far PR losing its machine (its close would run here); a far
 * link that is not a web link reaching an href; an asleep machine's rows dropped or asked for; an older machine (no
 * `pulls` mark) asked at all. No Inbox, no gh: the links are stand-ins.
 */
import { describe, expect, test } from "bun:test";
import type { InboxPull, InboxPullsAnswer } from "@plannotator/core/inbox-types";
import { createMachinePulls, mergePullBoards, parseFarBoard, type FarBoardEntry } from "./inbox-machine-pulls";
import type { PeerLink } from "./inbox-peer-link";

const A_THREAD = "msg_01K00000000000000000000001";
const B_THREAD = "msg_01K00000000000000000000002";
const B_PROJECT = "prj_01K00000000000000000000002";
const B = "ibx_01K0000000000000000000000B";
const C = "ibx_01K0000000000000000000000C";

const pull = (repo: string, number: number, over: Partial<InboxPull> = {}): InboxPull => ({
  key: `github.com/${repo}#${number}`,
  platform: "github",
  host: "github.com",
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  title: `PR ${number}`,
  author: "dana",
  mine: true,
  requested: false,
  state: "open",
  base: "main",
  head: `b${number}`,
  head_repo: repo,
  additions: 1,
  deletions: 1,
  files: 1,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: null,
  updated_at: "2026-11-14T10:00:00Z",
  merged_at: null,
  ...over,
});

type Local = Pick<InboxPullsAnswer, "pulls" | "links" | "projects" | "cards" | "hosts">;
const local = (pulls: InboxPull[]): Local => ({ pulls, links: {}, projects: { "github.com/northwind/web": ["prj_01K00000000000000000000001"] }, cards: {}, hosts: [{ cli: "gh", host: "github.com", login: "dana" }] });

describe("parseFarBoard", () => {
  test("keeps the far machine's PRs by shape; a link that is not https or http never comes through", () => {
    const board = parseFarBoard(
      {
        pulls: [pull("northwind/api", 7), { ...pull("northwind/api", 8), url: "javascript:alert(1)" }, { key: "x" }, { ...pull("northwind/api", 9), machine: C }],
        links: { "github.com/northwind/api#7": { via: "url", thread_id: B_THREAD, project_id: B_PROJECT, thread_subject: "API", agent: null, last: null, guide: null }, "github.com/northwind/api#8": { thread_id: B_THREAD, project_id: B_PROJECT } },
        projects: { "github.com/northwind/api": [B_PROJECT, "not-a-project"] },
        cards: {},
        hosts: [{ cli: "gh", host: "ghe.example.com", login: "dana-work", error: "unavailable" }, { cli: "svn", host: "x" }],
      },
      { judgments: { "github.com/northwind/api#7": { level: "high", why: "Touches auth." }, "github.com/northwind/api#9": { level: "nope", why: "" } } },
      "2026-11-14T10:00:00.000Z",
    )!;
    expect(board.pulls.map((p) => p.number)).toEqual([7, 9]);
    // A far answer cannot name a third machine: its PRs are its own.
    expect(board.pulls.find((p) => p.number === 9)!.machine).toBeUndefined();
    expect(Object.keys(board.links)).toEqual(["github.com/northwind/api#7"]);
    expect(board.projects["github.com/northwind/api"]).toEqual([B_PROJECT]);
    // Who it is on a host, never that machine's read errors.
    expect(board.hosts).toEqual([{ cli: "gh", host: "ghe.example.com", login: "dana-work" }]);
    expect(Object.keys(board.judgments)).toEqual(["github.com/northwind/api#7"]);
  });

  test("an answer that is not a board (Code review off there, an error) is none", () => {
    expect(parseFarBoard({ error: "Code review is off.", code: "code_review_off" }, null, "t")).toBeNull();
    expect(parseFarBoard(null, null, "t")).toBeNull();
  });
});

describe("mergePullBoards", () => {
  const far = (machine: string, pulls: InboxPull[], over: Partial<NonNullable<FarBoardEntry["board"]>> = {}): FarBoardEntry => ({
    machine,
    pending: false,
    board: { read_at: "2026-11-14T10:00:00.000Z", pulls, links: {}, projects: {}, cards: {}, hosts: [], judgments: {}, ...over },
  });

  test("a PR both machines list is one row, this machine's; a PR only the linked machine lists is added once with its machine", () => {
    const shared = pull("northwind/web", 1);
    const merged = mergePullBoards(local([shared]), [far(B, [{ ...shared, title: "B's copy" }, pull("northwind/api", 7)]), far(C, [pull("northwind/api", 7)])]);
    expect(merged.pulls.map((p) => [p.key, p.machine ?? null])).toEqual([
      ["github.com/northwind/web#1", null],
      ["github.com/northwind/api#7", B],
    ]);
    expect(merged.pulls[0]!.title).toBe("PR 1");
  });

  test("a PR this machine lists shows the agent's thread on the other machine; this machine's own link wins", () => {
    const link = (thread: string) => ({ via: "url" as const, thread_id: thread, thread_subject: null, project_id: B_PROJECT, agent: null, last: null, guide: null });
    const base = local([pull("northwind/web", 1), pull("northwind/web", 2)]);
    base.links["github.com/northwind/web#2"] = link(A_THREAD);
    const merged = mergePullBoards(base, [far(B, [], { links: { "github.com/northwind/web#1": link(B_THREAD), "github.com/northwind/web#2": link(B_THREAD) } })]);
    expect(merged.links["github.com/northwind/web#1"]!.thread_id).toBe(B_THREAD);
    expect(merged.links["github.com/northwind/web#2"]!.thread_id).toBe(A_THREAD);
  });

  test("the other machine's projects make its repositories projects here too; its risk rides its own rows only; its hosts join once", () => {
    const merged = mergePullBoards(local([pull("northwind/web", 1)]), [
      far(B, [pull("northwind/web", 1), pull("northwind/api", 7)], {
        projects: { "github.com/northwind/api": [B_PROJECT], "github.com/northwind/web": [B_PROJECT] },
        hosts: [{ cli: "gh", host: "github.com", login: "dana" }, { cli: "gh", host: "ghe.example.com", login: "dana-work" }],
        judgments: { "github.com/northwind/web#1": { level: "low", why: "Docs." }, "github.com/northwind/api#7": { level: "high", why: "Auth." } },
      }),
    ]);
    expect(merged.projects["github.com/northwind/api"]).toEqual([B_PROJECT]);
    expect(merged.projects["github.com/northwind/web"]).toEqual(["prj_01K00000000000000000000001", B_PROJECT]);
    expect(Object.keys(merged.far_risk)).toEqual(["github.com/northwind/api#7"]);
    expect(merged.hosts.map((h) => h.host)).toEqual(["github.com", "ghe.example.com"]);
  });

  test("an asleep machine's board as last read stays, and says when; one never read says so and adds nothing", () => {
    const merged = mergePullBoards(local([]), [far(B, [pull("northwind/api", 7)]), { machine: C, board: null, pending: true }]);
    expect(merged.pulls.map((p) => p.machine)).toEqual([B]);
    expect(merged.machines).toEqual({ [B]: { read_at: "2026-11-14T10:00:00.000Z", pending: false }, [C]: { read_at: null, pending: true } });
  });
});

describe("createMachinePulls", () => {
  /** A stand-in link: its state, its marks, and a door that answers its board (or hangs, or fails). */
  function peer(id: string, options: { marks?: string[]; state?: PeerLink["state"]; board?: unknown; hold?: Promise<void> } = {}) {
    const asked: string[] = [];
    const link = {
      id,
      state: options.state ?? "online",
      list: { marks: options.marks ?? ["star", "pulls"] },
      async request(route: string, search: string) {
        asked.push(`${route}${search}`);
        await options.hold;
        if (route === "pulls") return Response.json(options.board ?? { pulls: [pull("northwind/api", 7)], links: {}, projects: {}, cards: {}, hosts: [] });
        return Response.json({ judgments: {} });
      },
    };
    return { link: link as unknown as PeerLink, asked, set: (state: PeerLink["state"]) => ((link as { state: string }).state = state) };
  }

  /** What the merged board gets once the reads it started are done. */
  const readAll = async (pulls: ReturnType<typeof createMachinePulls>, refresh: boolean) => {
    const snapshot = pulls.start(refresh);
    await pulls.settled();
    return snapshot();
  };

  test("an online machine's board is read through its door, a refresh asked there too; an older machine (no `pulls`) is never asked", async () => {
    const b = peer(B);
    const old = peer(C, { marks: ["star", "cards"] });
    const pulls = createMachinePulls({ peers: () => [b.link, old.link] });
    const first = await readAll(pulls, false);
    expect(first.map((e) => [e.machine, e.board?.pulls.length ?? null, e.pending])).toEqual([[B, 1, false]]);
    expect(b.asked).toEqual(["pulls?everywhere=1", "pulls/risk"]);
    await readAll(pulls, true);
    expect(b.asked.at(-2)).toBe("pulls?everywhere=1&refresh=1");
    expect(old.asked).toEqual([]);
  });

  test("a PR another machine's board links to a thread counts as having one there, from the board as last read", async () => {
    const linked = { via: "owner", thread_id: B_THREAD, project_id: B_PROJECT, thread_subject: null, agent: null, last: null, guide: null };
    const b = peer(B, { board: { pulls: [pull("northwind/api", 7), pull("northwind/api", 8)], links: { "github.com/northwind/api#7": linked }, projects: {}, cards: {}, hosts: [] } });
    const pulls = createMachinePulls({ peers: () => [b.link] });
    expect(pulls.linkedThere("github.com/northwind/api#7")).toBe(false);
    await readAll(pulls, false);
    expect([pulls.linkedThere("github.com/northwind/api#7"), pulls.linkedThere("github.com/northwind/api#8")]).toEqual([true, false]);
  });

  test("asleep: nothing is asked and its rows stay as last read; back, it is read again", async () => {
    const b = peer(B);
    const pulls = createMachinePulls({ peers: () => [b.link] });
    await readAll(pulls, false);
    b.set("offline");
    const asked = b.asked.length;
    const away = await readAll(pulls, false);
    expect(b.asked.length).toBe(asked);
    expect(away[0]!.board!.pulls.map((p) => p.number)).toEqual([7]);
    expect(away[0]!.pending).toBe(false);
    b.set("online");
    await readAll(pulls, false);
    expect(b.asked.length).toBe(asked + 2);
  });

  test("a machine online but not answering never holds this board up: it is pending, asked once, and joins when it answers", async () => {
    let release = () => {};
    const b = peer(B, { hold: new Promise<void>((done) => (release = done)) });
    const pulls = createMachinePulls({ peers: () => [b.link] });
    const at = performance.now();
    const first = pulls.start(false)();
    expect(performance.now() - at).toBeLessThan(1_000);
    expect(first).toEqual([{ machine: B, board: null, pending: true }]);
    expect(pulls.start(false)()).toEqual([{ machine: B, board: null, pending: true }]);
    expect(b.asked).toEqual(["pulls?everywhere=1"]);
    release();
    const after = await readAll(pulls, false);
    expect(after[0]!.board!.pulls).toHaveLength(1);
  });

  test("after a write whose answer never came: the PR's state as that machine's board says now; unreadable now, none", async () => {
    let state: InboxPull["state"] = "open";
    let down = false;
    const link = {
      id: B,
      state: "online",
      list: { marks: ["pulls"] },
      async request(route: string) {
        if (down) throw new Error("connection refused");
        if (route === "pulls") return Response.json({ pulls: [pull("northwind/api", 7, { state })], links: {}, projects: {}, cards: {}, hosts: [] });
        return Response.json({ judgments: {} });
      },
    } as unknown as PeerLink;
    let clock = 0;
    const pulls = createMachinePulls({ peers: () => [link], now: () => new Date(Date.UTC(2026, 10, 14, 10, 0, clock++)) });
    await readAll(pulls, false);
    state = "merged";
    expect(await pulls.stateThere(link, "github.com/northwind/api#7")).toBe("merged");
    down = true;
    expect(await pulls.stateThere(link, "github.com/northwind/api#7")).toBeNull();
  });

  test("a read started before unlink cannot replace the board of the newly linked machine", async () => {
    let release = () => {};
    const old = peer(B, { hold: new Promise<void>((done) => (release = done)) });
    const relinked = peer(B, { board: { pulls: [pull("northwind/api", 8)] } });
    let linked = [old.link];
    const pulls = createMachinePulls({ peers: () => linked });
    pulls.start(false);
    const stale = pulls.settled();
    pulls.forget(B);
    linked = [relinked.link];
    const snapshot = pulls.start(false);

    release();
    await stale;
    await pulls.settled();
    expect(snapshot()[0]!.board!.pulls.map((pr) => pr.number)).toEqual([8]);
  });

  test("unlinked: nothing of its board stays", async () => {
    const b = peer(B);
    let linked = [b.link];
    const pulls = createMachinePulls({ peers: () => linked });
    await readAll(pulls, false);
    pulls.forget(B);
    linked = [];
    expect(await readAll(pulls, false)).toEqual([]);
  });
});
