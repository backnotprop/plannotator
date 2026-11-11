/**
 * Test-only: every read the server makes of the store as one plain value, so two stores compare whole.
 * Left out on purpose: `threadVersion` and `reloadCount` (a store that deleted something has counted a re-read a fresh one has not).
 */
import type { InboxStore } from "../store";

export interface EveryReadOptions {
  sessions: readonly string[];
  /** Compare byte counts too; false when the logs differ (they store the same records in different bytes). */
  bytes: boolean;
}

function plain(value: unknown): unknown {
  if (value instanceof Map) return [...value.entries()].map(([k, v]) => [plain(k), plain(v)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (value instanceof Set) return [...value].map(plain).sort();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (typeof v !== "function") out[k] = plain(v);
    return out;
  }
  return value;
}

const byThread = <T extends { thread_id: string }>(rows: T[]) => [...rows].sort((a, b) => a.thread_id.localeCompare(b.thread_id));

function withoutBytes(usage: ReturnType<InboxStore["diskUsage"]>) {
  return {
    projects: usage.projects
      .map(({ bytes: _b, threads, ...rest }) => ({ ...rest, threads: threads.map(({ bytes: _t, ...thread }) => thread).sort((a, b) => a.thread_id.localeCompare(b.thread_id)) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function everyRead(store: InboxStore, options: EveryReadOptions): Record<string, unknown> {
  const threads = store.threadIds();
  const messageIds = threads.flatMap((id) => store.threadMessageIds(id));
  const projects = store.allProjects();
  const cards = store.listCards();
  const out: Record<string, unknown> = {
    cursor: store.cursor(),
    changes: store.changesSince(0),
    projects: { all: projects, listed: store.listProjects(), groups: projects.map((p) => [p.id, store.canonicalProjectId(p.id), store.projectGroup(p.id)]) },
    list: {
      rows: store.listRows(),
      perProject: projects.map((p) => store.listRows({ projectId: p.id })),
      sections: store.listSections(),
      // Unordered: compared by thread.
      unsent: byThread(store.unsentRows()),
      decisions: store.openDecisions(),
    },
    threads,
    thread: Object.fromEntries(
      threads.map((id) => [
        id,
        {
          window: store.windowThread(id),
          full: store.thread(id),
          agent: options.sessions.map((s) => store.agentThread(id, s)),
          summary: store.threadSummary(id),
          row: store.listRow(id),
          subject: store.threadSubject(id),
          shortName: store.threadShortName(id),
          namers: store.threadNamers(id),
          archiveSeq: store.archiveSeq(id),
          agentAfterArchive: store.agentAfterArchive(id),
          steps: store.threadSteps(id),
          pulls: store.threadPulls(id),
          pullEvents: store.threadPullEvents(id),
          attachments: store.threadAttachments(id),
          pendingAnnotations: store.pendingAnnotations(id),
          earlierAnnotations: store.earlierAnnotations(id),
          replyDraft: store.replyDraft(id),
          decisionExport: store.decisionExportInput(id),
        },
      ]),
    ),
    message: Object.fromEntries(
      messageIds.map((id) => [
        id,
        {
          wire: store.messageWire(id),
          cursor: store.messageCursor(id),
          questions: store.questionsOf(id).map((q) => ({ q, record: store.questionRecord(`${id}/${q.key}`), lineSeq: store.questionLineSeq(`${id}/${q.key}`) })),
        },
      ]),
    ),
    questionRecords: [...store.allQuestionRecords()].sort((a, b) => a.id.localeCompare(b.id)),
    agents: {
      latest: store.latestAgentMessages(),
      launched: store.launchedRoots(),
      tidy: store.tidyNotes(),
      pending: options.sessions.map((s) => store.pendingReplies(s)),
      pendingTags: options.sessions.map((s) => store.pendingReplies(s, { tags: true })),
    },
    board: {
      cards: cards.map((c) => ({ wire: store.cardWire(c), history: store.cardHistory(c.id) })),
      initiatives: store.initiatives(),
      initiativeThreads: store.initiativeThreads(),
      steps: store.allSteps(),
      pulls: store.allThreadPulls(),
    },
    pins: store.pins(),
    snoozes: store.snoozes(),
    artifactPins: store.artifactPins(),
    blobs: store.usedBlobs(),
    decisionData: store.decisionDataInput(),
    storage: options.bytes ? store.diskUsage() : withoutBytes(store.diskUsage()),
  };
  return plain(out) as Record<string, unknown>;
}
