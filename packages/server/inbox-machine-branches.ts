/**
 * Branch reviews across linked machines (docs/agent-guides/inbox-machines.md, "Reported branches"). An agent on a
 * linked machine reports its branch to that machine's own Inbox, so the report and its thread live there, under that
 * machine's project. A linked machine that takes `branches` (its list's `marks`) is read through its door
 * (`GET reviews/branches`, machine only), kept in memory as last read, and listed in this machine's Reviews with
 * `machine`. Never a timer: a read starts when this machine's Reviews is read, and is never waited for.
 */

import { inboxBranchRemoteUrl, type InboxBranchReportRow } from "@plannotator/core/inbox-branch-reports";
import { inboxPullSafeBranch, isInboxId, type InboxPullRiskJudgment } from "@plannotator/core/inbox-types";
import { readCapped, type PeerLink } from "./inbox-peer-link";

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
export function createMachineBranches(options: { peers: () => Iterable<PeerLink>; now?: () => number }) {
  const now = options.now ?? Date.now;
  const lists = new Map<string, Omit<InboxBranchReportRow, "machine">[]>();
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
          if (response.status === 409 && !abort.signal.aborted) lists.delete(peer.id);
          return;
        }
        const body = await readCapped(response, FAR_BRANCHES_MAX_BYTES);
        const answer = body === null ? null : (JSON.parse(body) as { reports?: unknown });
        if (abort.signal.aborted || !answer || !Array.isArray(answer.reports)) return;
        lists.set(peer.id, answer.reports.slice(0, FAR_BRANCHES_MAX).flatMap((value) => farBranchRow(value) ?? []));
      } catch {
        // Asleep or unreachable: its rows stay as last read.
      }
    })().finally(() => {
      if (reading.get(peer.id)?.abort === abort) reading.delete(peer.id);
    });
    reading.set(peer.id, { done: run, abort });
    return run;
  };

  const takers = () => [...options.peers()].filter((peer) => peer.list?.marks.includes("branches"));

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
      lists.delete(machine);
      readAt.delete(machine);
    },
  };
}
