/**
 * The PR board across linked machines (docs/agent-guides/inbox-machines.md, "The PR board"). Each machine's board is
 * what its own gh / glab lists: its signed-in hosts and accounts, its projects' repositories. A linked machine that
 * takes `pulls` (its list's `marks`) is read through its door (`GET pulls?everywhere=1` and `GET pulls/risk`), kept in
 * memory as last read, and merged under this machine's own: one row per PR, this machine's first, so a PR both list
 * is this machine's and its gh reads and changes it. A PR only the other machine lists carries `machine`, and its
 * close, reopen and merge go there (the forward's `forge` writes).
 */

import {
  isInboxId,
  type InboxPull,
  type InboxPullCard,
  type InboxPullHost,
  type InboxPullLink,
  type InboxPullRiskJudgment,
  type InboxPullsAnswer,
} from "@plannotator/core/inbox-types";
import { readCapped, type PeerLink } from "./inbox-peer-link";
import { isPullLooked } from "./inbox-pull-looked";

/** A far board's answer is read no further than this. */
const FAR_PULLS_MAX_BYTES = 8 * 1024 * 1024;
/** One far read: its own list may ask the forges. */
const FAR_PULLS_READ_MS = 30_000;

type Json = Record<string, any>;

/** A linked machine's board as last read. */
export interface FarBoard {
  read_at: string;
  pulls: InboxPull[];
  links: Record<string, InboxPullLink>;
  projects: Record<string, string[]>;
  cards: Record<string, InboxPullCard>;
  hosts: InboxPullHost[];
  judgments: Record<string, InboxPullRiskJudgment>;
}

const STATES = new Set(["open", "draft", "merged", "closed"]);
const LEVELS = new Set(["low", "medium", "high"]);
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** A far PR, picked by its shape: its link opens only on the web (`https:` or `http:`). */
function farPull(value: unknown): InboxPull | null {
  const pull = obj(value);
  if (!pull || !text(pull.key, 600) || !text(pull.host, 255) || !text(pull.repo, 400) || !text(pull.url, 2000)) return null;
  if (!Number.isSafeInteger(pull.number) || pull.number <= 0 || !STATES.has(pull.state) || typeof pull.title !== "string") return null;
  if (!/^https?:\/\//i.test(pull.url)) return null;
  const { machine: _ignored, looked, ...rest } = pull;
  return (isPullLooked(looked) ? { ...rest, looked: { sha: looked.sha, at: looked.at } } : rest) as InboxPull;
}

/** A far machine's answers to `GET pulls?everywhere=1` and `GET pulls/risk`, picked by name. Null when the board is not one. */
export function parseFarBoard(list: unknown, risk: unknown, readAt: string): FarBoard | null {
  const answer = obj(list);
  if (!answer || !Array.isArray(answer.pulls)) return null;
  const pulls = answer.pulls.flatMap((value: unknown) => farPull(value) ?? []);
  const keys = new Set(pulls.map((pull) => pull.key));
  const links: FarBoard["links"] = {};
  for (const [key, link] of Object.entries(obj(answer.links) ?? {})) {
    if (keys.has(key) && isInboxId("msg", obj(link)?.thread_id) && isInboxId("prj", obj(link)?.project_id)) links[key] = link as InboxPullLink;
  }
  const cards: FarBoard["cards"] = {};
  for (const [key, card] of Object.entries(obj(answer.cards) ?? {})) {
    if (keys.has(key) && isInboxId("crd", obj(card)?.id) && typeof card.title === "string" && typeof card.column === "string") cards[key] = { id: card.id, title: card.title, column: card.column };
  }
  const projects: FarBoard["projects"] = {};
  for (const [repo, ids] of Object.entries(obj(answer.projects) ?? {})) {
    if (Array.isArray(ids)) projects[repo] = ids.filter((id: unknown): id is string => isInboxId("prj", id));
  }
  const hosts = (Array.isArray(answer.hosts) ? answer.hosts : []).flatMap((value: unknown): InboxPullHost[] => {
    const host = obj(value);
    if (!host || (host.cli !== "gh" && host.cli !== "glab") || !text(host.host, 255)) return [];
    return [{ cli: host.cli, host: host.host, login: typeof host.login === "string" ? host.login : null }];
  });
  const judgments: FarBoard["judgments"] = {};
  for (const [key, judgment] of Object.entries(obj(obj(risk)?.judgments) ?? {})) {
    if (keys.has(key) && LEVELS.has(obj(judgment)?.level) && typeof judgment.why === "string") judgments[key] = judgment as InboxPullRiskJudgment;
  }
  return { read_at: readAt, pulls, links, projects, cards, hosts, judgments };
}

/** One linked machine's part of the merged board: its board as last read (null before the first), and whether a read runs. */
export interface FarBoardEntry {
  machine: string;
  board: FarBoard | null;
  pending: boolean;
  /** The link's name for it, when known. */
  name?: string;
  /** It keeps the PR page's look at its PRs (mark `pulls-looked`). */
  looked?: boolean;
}

/**
 * This machine's board with the linked machines' merged under it. A PR this machine lists stays its own; a PR only a
 * linked machine lists is added once (the first machine to list it), with `machine`. A PR's thread link and card come
 * from the first machine that has one, so a PR this machine lists still shows the agent's thread on another machine.
 * A far host this machine does not ask joins `hosts` as who it is there, never with that machine's read errors.
 */
export function mergePullBoards<T extends Pick<InboxPullsAnswer, "pulls" | "links" | "projects" | "cards" | "hosts">>(
  local: T,
  far: readonly FarBoardEntry[],
): T & Required<Pick<InboxPullsAnswer, "machines" | "far_risk">> {
  const pulls = [...local.pulls];
  const keys = new Set(pulls.map((pull) => pull.key));
  const links = { ...local.links };
  const cards = { ...local.cards };
  const projects: Record<string, string[]> = Object.fromEntries(Object.entries(local.projects).map(([repo, ids]) => [repo, [...ids]]));
  const hosts = [...local.hosts];
  const far_risk: Record<string, InboxPullRiskJudgment> = {};
  const machines: NonNullable<InboxPullsAnswer["machines"]> = {};
  for (const { machine, board, pending, name, looked } of far) {
    machines[machine] = { read_at: board?.read_at ?? null, pending, ...(name ? { name } : {}), ...(looked ? { looked: true as const } : {}) };
    if (!board) continue;
    for (const pull of board.pulls) {
      if (keys.has(pull.key)) continue;
      keys.add(pull.key);
      pulls.push({ ...pull, machine });
      if (board.judgments[pull.key]) far_risk[pull.key] = board.judgments[pull.key]!;
    }
    for (const [key, link] of Object.entries(board.links)) links[key] ??= link;
    for (const [key, card] of Object.entries(board.cards)) cards[key] ??= card;
    for (const [repo, ids] of Object.entries(board.projects)) projects[repo] = [...new Set([...(projects[repo] ?? []), ...ids])];
    for (const host of board.hosts) if (!hosts.some((h) => h.cli === host.cli && h.host === host.host)) hosts.push(host);
  }
  return { ...local, pulls, links, cards, projects, hosts, machines, far_risk };
}

/** The linked machines' boards: read when the merged board is asked for, one read per machine at a time, kept in memory. */
export function createMachinePulls(options: { peers: () => Iterable<PeerLink>; now?: () => Date }) {
  const boards = new Map<string, FarBoard>();
  const reading = new Map<string, { done: Promise<void>; abort: AbortController }>();
  const now = options.now ?? (() => new Date());

  const readJson = async (peer: PeerLink, route: string, search: string, signal: AbortSignal): Promise<unknown> => {
    const response = await peer.request(route, search, { method: "GET", headers: {}, timeoutMs: FAR_PULLS_READ_MS, signal });
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      return null;
    }
    const body = await readCapped(response, FAR_PULLS_MAX_BYTES);
    return body === null ? null : JSON.parse(body);
  };

  /** Read that machine's board now (or join the read under way). Never throws: a failed read keeps the last one. */
  const read = (peer: PeerLink, refresh: boolean): Promise<void> => {
    const running = reading.get(peer.id);
    if (running) return running.done;
    const abort = new AbortController();
    const run = (async () => {
      try {
        const list = await readJson(peer, "pulls", `?everywhere=1${refresh ? "&refresh=1" : ""}`, abort.signal);
        if (abort.signal.aborted) return;
        const risk = list ? await readJson(peer, "pulls/risk", "", abort.signal).catch(() => null) : null;
        const board = parseFarBoard(list, risk, now().toISOString());
        if (board && !abort.signal.aborted) boards.set(peer.id, board);
      } catch {
        // Asleep or unreachable: its rows stay as last read.
      }
    })().finally(() => {
      if (reading.get(peer.id)?.abort === abort) reading.delete(peer.id);
    });
    reading.set(peer.id, { done: run, abort });
    return run;
  };

  const takers = () => [...options.peers()].filter((peer) => peer.list?.marks.includes("pulls"));

  return {
    /**
     * Each linked machine that takes `pulls`: a read of its board starts now while it is online (or joins the one under
     * way), never waited for, so this machine's own board is never held up by another's. The answer is what each had
     * when it is asked (`snapshot`, after this machine's own list): its board as last read (an asleep machine's rows
     * stay), and `pending` while its read goes on, so the window asks again for it.
     */
    start(refresh: boolean): () => FarBoardEntry[] {
      const peers = takers();
      for (const peer of peers) if (peer.state === "online") void read(peer, refresh);
      return () => peers.map((peer) => ({ machine: peer.id, board: boards.get(peer.id) ?? null, pending: reading.has(peer.id), ...(peer.list?.marks.includes("pulls-looked") ? { looked: true } : {}) }));
    },
    /** The reads under way, done (tests). */
    async settled(): Promise<void> {
      await Promise.all([...reading.values()].map(({ done }) => done));
    },
    /** After a close, reopen or merge there: its board again, so the next merged read shows it. */
    reread(peer: PeerLink): Promise<void> {
      return peer.list?.marks.includes("pulls") ? read(peer, false) : Promise.resolve();
    },
    /**
     * A PR's state on that machine's board, read now (after a write whose answer never came): null when the board
     * could not be read now or does not list it.
     */
    async stateThere(peer: PeerLink, key: string): Promise<InboxPull["state"] | null> {
      const before = boards.get(peer.id)?.read_at ?? null;
      await read(peer, false);
      const board = boards.get(peer.id);
      if (!board || board.read_at === before) return null;
      return board.pulls.find((pull) => pull.key === key)?.state ?? null;
    },
    linkedThere(key: string): boolean {
      return [...boards.values()].some((board) => !!board.links[key]);
    },
    /** The link went: nothing of that machine's board stays. */
    forget(machine: string): void {
      reading.get(machine)?.abort.abort();
      reading.delete(machine);
      boards.delete(machine);
    },
  };
}
