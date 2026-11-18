/**
 * A thread started from a PR's page (Start a thread) is that PR's own thread on the server's word too: the link scan
 * (`linkInboxPulls`) finds it by its first message, the person's words with the PR's details and the thread's step
 * after them (`splitPullThreadDetails`). What regresses: a thread the window could not keep as the PR's owner (a failed
 * tie, then a reload or another window) not linking the PR, so the page offers Start a thread again and a second
 * thread starts; a PR merely named in the person's words, or in another hand-off, linking as the PR's own thread; a
 * hand-off's owner losing to it; the first such thread not winning over a later one.
 */
import { expect, test } from "bun:test";
import { PULL_DETAILS_START, PULL_THREAD_STEP, type InboxPull } from "@plannotator/core/inbox-types";
import { linkInboxPulls } from "./inbox-pulls";

const REPO = "northwind/web-app";
const pr = (n: number): InboxPull =>
  ({
    key: `github.com/${REPO}#${n}`,
    platform: "github",
    host: "github.com",
    repo: REPO,
    number: n,
    url: `https://github.com/${REPO}/pull/${n}`,
    title: `PR ${n}`,
    author: "tomas",
    mine: false,
    requested: true,
    state: "open",
    base: "main",
    head: `fix/${n}`,
    head_repo: REPO,
    additions: 1,
    deletions: 0,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: "success",
    updated_at: "2026-11-03T09:00:00.000Z",
    merged_at: null,
  }) as InboxPull;
const details = (n: number, step = PULL_THREAD_STEP) =>
  `${PULL_DETAILS_START}pull request. Don't change any code unless I explicitly tell you to.\n\nPull request\n- Title: PR ${n}\n- Link: https://github.com/${REPO}/pull/${n}\n\nWhat to do\n${step} Bring up what you notice.`;

function storeOf(roots: { id: string; body: string; at: string; kind?: "person" | "agent" }[]) {
  const messages = new Map(roots.map((r) => [r.id, { id: r.id, thread_id: r.id, project_id: "prj_web", created_at: r.at, author: r.kind === "agent" ? { kind: "agent", host: "claude-code", session: "ses_a", name: null } : { kind: "person" }, body: r.body, to: { host: "claude-code", session: "ses_a" } }]));
  return {
    threadsOf: () => roots.map((r) => ({ thread_id: r.id, last_at: r.at })),
    threadMessageIds: (thread: string) => [thread],
    message: (id: string) => (messages.get(id) as never) ?? null,
    threadSubject: () => "Review #880",
    threadProject: (id: string) => (messages.has(id) ? "prj_web" : null),
  };
}
const projects = new Map([[`github.com/${REPO}`, ["prj_web"]]]);

test("a started thread's first message makes it the PR's own thread (the page mark, ask thread); the first one wins", () => {
  const store = storeOf([
    { id: "thr_late", body: `Second try.\n\n${details(880)}`, at: "2026-11-03T10:05:00.000Z" },
    { id: "thr_first", body: `Tell me about it.\n\n${details(880)}`, at: "2026-11-03T10:00:00.000Z" },
  ]);
  const link = linkInboxPulls([pr(880)], store, projects)[pr(880).key];
  expect(link).toMatchObject({ via: "owner", ask: "thread", page: true, thread_id: "thr_first" });
});

test("only the details count: a PR named in the person's words, an agent's message, or New review's hand-off is no started thread", () => {
  const store = storeOf([
    { id: "thr_words", body: `Compare with https://github.com/${REPO}/pull/881 please.\n\n${details(880)}`, at: "2026-11-03T10:00:00.000Z" },
    { id: "thr_agent", body: `Hi.\n\n${details(882)}`, at: "2026-11-03T10:00:00.000Z", kind: "agent" },
    { id: "thr_review", body: `Look.\n\n${details(883, "1. Send me a guided review.")}`, at: "2026-11-03T10:00:00.000Z" },
  ]);
  const links = linkInboxPulls([pr(880), pr(881), pr(882), pr(883)], store, projects);
  expect(links[pr(880).key]?.thread_id).toBe("thr_words");
  expect(links[pr(881).key]).toBeUndefined();
  expect(links[pr(882).key]?.via).not.toBe("owner");
  expect(links[pr(883).key]).toBeUndefined();
});

test("a hand-off's owner stays the PR's thread", () => {
  const store = storeOf([
    { id: "thr_started", body: `Tell me.\n\n${details(880)}`, at: "2026-11-03T10:00:00.000Z" },
    { id: "thr_handed", body: "Ready.", at: "2026-11-03T09:00:00.000Z" },
  ]);
  const link = linkInboxPulls([pr(880)], store, projects, new Map([[pr(880).key, { thread_id: "thr_handed", ask: "guide" as const }]]))[pr(880).key];
  expect(link).toMatchObject({ via: "owner", thread_id: "thr_handed", ask: "guide" });
});
