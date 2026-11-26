/**
 * Branch reviews across linked machines (docs/agent-guides/inbox-machines.md, "Reported branches"). An agent on a
 * linked machine reports its branch to that machine's own Inbox, so the report and its thread live there, under that
 * machine's project. A linked machine that takes `branches` (its list's `marks`) is read through its door
 * (`GET reviews/branches`, machine only), kept in memory as last read, and listed in this machine's Reviews with
 * `machine`. Never a timer: a read starts when this machine's Reviews is read, and is never waited for.
 *
 * Each machine's last read is also kept on disk (`inbox/machine-branches.json`, 0600, when `dir` is given), so a
 * restart here while that machine sleeps keeps its rows (the owner, 2026-11-23: what is open never disappears). They
 * go when its link goes, when it says Branch reviews is off there (409), or when its list, read again, no longer takes
 * `branches`; a machine whose list is not read yet since the restart is taken as it was.
 */

import { inboxBranchRemoteUrl, type InboxBranchReportRow } from "@plannotator/core/inbox-branch-reports";
import { inboxPullSafeBranch, isInboxId, type InboxPullRiskJudgment } from "@plannotator/core/inbox-types";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCapped, type PeerLink } from "./inbox-peer-link";

export const MACHINE_BRANCHES_FILE = "machine-branches.json";

const FAR_BRANCHES_MAX_BYTES = 2 * 1024 * 1024;
const FAR_BRANCHES_READ_MS = 15_000;
const FAR_BRANCHES_MAX = 500;
/** A machine read this recently is not read again: the window's follow-up read (on `pending`) takes what came. */
const FAR_BRANCHES_FRESH_MS = 20_000;

type Json = Record<string, unknown>;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const orNull = (value: unknown, max: number): string | null => (text(value, max) ? value : null);
const LEVELS = new Set(["low", "medium", "high"]);

const HEAD = /^[0-9a-f]{7,64}$/i;

/**
 * One far row, picked by its shape and read by the same rules as a report here: a machine's answer is another
 * program's words. Its branch and base are plain branch names, its head a commit id, and its remote the URL rebuilt
 * from its parts (no password, query or fragment), else none.
 */
export function farBranchRow(value: unknown): Omit<InboxBranchReportRow, "machine"> | null {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
  if (!row || !text(row.thread_id, 200) || !isInboxId("msg", row.thread_id) || !text(row.project_id, 200) || !text(row.branch, 250) || !text(row.at, 64)) return null;
  if (row.place !== "here" && row.place !== "cloud") return null;
  if (!inboxPullSafeBranch(row.branch) || (row.base != null && !(text(row.base, 250) && inboxPullSafeBranch(row.base))) || (row.head != null && !(text(row.head, 64) && HEAD.test(row.head)))) return null;
  const remote = text(row.remote_url, 2000) ? inboxBranchRemoteUrl(row.remote_url) : null;
  const risk = row.risk && typeof row.risk === "object" ? (row.risk as Json) : null;
  const judged: InboxPullRiskJudgment | null = risk && LEVELS.has(String(risk.level)) && text(risk.why, 2000) ? { level: risk.level as InboxPullRiskJudgment["level"], why: risk.why } : null;
  const agent = row.agent && typeof row.agent === "object" ? (row.agent as Json) : null;
  return {
    thread_id: row.thread_id,
    project_id: row.project_id,
    branch: row.branch,
    base: orNull(row.base, 250),
    head: orNull(row.head, 64),
    place: row.place,
    remote_url: remote,
    ...(typeof row.remote_known === "boolean" ? { remote_known: row.remote_known } : {}),
    summary: orNull(row.summary, 400),
    at: row.at,
    reports: Number.isSafeInteger(row.reports) ? (row.reports as number) : 1,
    agent: agent ? { host: orNull(agent.host, 100), session: orNull(agent.session, 300), name: orNull(agent.name, 200) } : null,
    reachable: row.reachable === true,
    risk: judged,
    risk_failed: orNull(row.risk_failed, 2000),
  };
}

/** The linked machines' reported branches, as last read. */
/** `linked`: the ids of the machines linked now (the links on disk), so a saved read of one unlinked since is dropped. */
export function createMachineBranches(options: { peers: () => Iterable<PeerLink>; now?: () => number; dir?: string; linked?: () => Iterable<string> }) {
  const now = options.now ?? Date.now;
  const file = options.dir ? join(options.dir, MACHINE_BRANCHES_FILE) : null;
  const lists = new Map<string, Omit<InboxBranchReportRow, "machine">[]>();
  // The last reads from before a restart, each row taken by its shape again.
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; machines?: Record<string, unknown> };
      for (const [id, rows] of Object.entries(saved.v === 1 && saved.machines && typeof saved.machines === "object" ? saved.machines : {})) {
        if (isInboxId("ibx", id) && Array.isArray(rows)) lists.set(id, rows.slice(0, FAR_BRANCHES_MAX).flatMap((value) => farBranchRow(value) ?? []));
      }
    } catch {
      // None yet, or unreadable: the next reads bring them.
    }
  }
  // A machine unlinked while this Inbox was down (`forget` never ran for it): its rows go, on disk too.
  const linked = options.linked ? new Set(options.linked()) : null;
  let unlinked = false;
  for (const id of linked ? [...lists.keys()] : []) if (!linked!.has(id)) unlinked = lists.delete(id) || unlinked;
  /** What the file holds now: a read that changed nothing writes nothing. */
  let written = "";
  const save = () => {
    if (!file) return;
    const text = `${JSON.stringify({ v: 1, machines: Object.fromEntries(lists) })}\n`;
    if (text === written) return;
    try {
      mkdirSync(options.dir!, { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, text, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, file);
      written = text;
    } catch {
      // A read-only folder: the rows stay in memory.
    }
  };
  if (unlinked) save();
  const reading = new Map<string, { done: Promise<void>; abort: AbortController }>();
  const readAt = new Map<string, number>();

  const read = (peer: PeerLink): Promise<void> => {
    const running = reading.get(peer.id);
    if (running) return running.done;
    readAt.set(peer.id, now());
    const abort = new AbortController();
    const run = (async () => {
      try {
        const response = await peer.request("reviews/branches", "", { method: "GET", headers: {}, timeoutMs: FAR_BRANCHES_READ_MS, signal: abort.signal });
        if (!response.ok) {
          response.body?.cancel().catch(() => {});
          // Branch reviews off there: nothing of it listed here.
          if (response.status === 409 && !abort.signal.aborted && lists.delete(peer.id)) save();
          return;
        }
        const body = await readCapped(response, FAR_BRANCHES_MAX_BYTES);
        const answer = body === null ? null : (JSON.parse(body) as { reports?: unknown });
        if (abort.signal.aborted || !answer || !Array.isArray(answer.reports)) return;
        lists.set(peer.id, answer.reports.slice(0, FAR_BRANCHES_MAX).flatMap((value) => farBranchRow(value) ?? []));
        save();
      } catch {
        // Asleep or unreachable: its rows stay as last read.
      }
    })().finally(() => {
      if (reading.get(peer.id)?.abort === abort) reading.delete(peer.id);
    });
    reading.set(peer.id, { done: run, abort });
    return run;
  };

  // A machine whose list is not read yet (asleep since this Inbox started) is taken while its last rows are kept.
  // One whose list no longer takes `branches` (Branch reviews turned off there) leaves nothing behind, on disk either.
  const takers = () => {
    const peers = [...options.peers()];
    let dropped = false;
    for (const peer of peers) if (peer.list && !peer.list.marks.includes("branches") && lists.delete(peer.id)) dropped = true;
    if (dropped) save();
    return peers.filter((peer) => (peer.list ? peer.list.marks.includes("branches") : lists.has(peer.id)));
  };

  return {
    /** A read of each taker starts now (or joins the one under way), never waited for; the answer is what each had when asked. */
    start(name: (machine: string) => string | null): () => { rows: InboxBranchReportRow[]; pending: boolean } {
      const peers = takers();
      for (const peer of peers) if (peer.state === "online" && now() - (readAt.get(peer.id) ?? -Infinity) >= FAR_BRANCHES_FRESH_MS) void read(peer);
      return () => ({
        rows: peers.flatMap((peer) => (lists.get(peer.id) ?? []).map((row) => ({ ...row, machine: { id: peer.id, name: name(peer.id) } }))),
        pending: peers.some((peer) => reading.has(peer.id)),
      });
    },
    async settled(): Promise<void> {
      await Promise.all([...reading.values()].map(({ done }) => done));
    },
    forget(machine: string): void {
      reading.get(machine)?.abort.abort();
      reading.delete(machine);
      if (lists.delete(machine)) save();
      readAt.delete(machine);
    },
  };
}
