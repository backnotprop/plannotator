import { readFileSync } from "node:fs";
import { parseGuideSnapshotJson } from "@plannotator/core/guide-format";
import {
  inboxPullRefOfKey,
  inboxPullRefOfUrl,
  inboxReviewLandingId,
  inboxReviewLandingOf,
  inboxReviewSourceOf,
  isInboxNote,
  type InboxMessage,
  type InboxPull,
  type InboxPullHost,
  type InboxReviewLanding,
  type InboxReviewSource,
  type InboxReviewThread,
} from "@plannotator/core/inbox-types";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { refCliRunner, type RefRunner } from "./ref-cards";

export interface InboxReviewIndexStore {
  readonly dir: string;
  cursor(): number;
  reloadCount(): number;
  threadIds(): string[];
  threadMessageIds(threadId: string): readonly string[];
  message(id: string): InboxMessage | null;
  threadSubject(threadId: string): string | null;
  canonicalProjectId(projectId: string): string;
}

export function inboxReviewThreadOf(
  store: Pick<InboxReviewIndexStore, "threadMessageIds" | "message" | "threadSubject" | "canonicalProjectId">,
  threadId: string,
  sourceOf: (message: InboxMessage) => InboxReviewSource | null = () => null,
): InboxReviewThread | null {
  const root = store.message(threadId);
  if (!root || root.thread_id !== threadId) return null;
  let first: InboxMessage | null = null;
  let latestReview: InboxMessage | null = null;
  let round = 0;
  let verdict: InboxReviewThread["verdict"] = null;
  let answered: InboxReviewThread["answered"] = null;
  let last: InboxMessage = root;
  for (const id of store.threadMessageIds(threadId)) {
    const message = store.message(id);
    if (!message) continue;
    if (isInboxNote(message)) continue;
    last = message;
    if (message.author.kind === "agent" && message.guide?.review) {
      first ??= message;
      latestReview = message;
      round += 1;
      verdict = null;
      answered = null;
      continue;
    }
    if (latestReview?.guide?.walkthrough && message.author.kind === "agent") {
      answered = null;
      continue;
    }
    if (!latestReview || message.author.kind !== "person") continue;
    const mark = message.review_verdict;
    if (mark && mark.of !== latestReview.id) continue;
    answered = { message_id: message.id, at: message.created_at };
    if (mark) verdict = { verdict: mark.verdict, comments: mark.comments, message_id: message.id, at: message.created_at };
  }
  if (!first || !latestReview) return null;
  const guide = latestReview.guide!;
  const author = latestReview.author;
  return {
    thread_id: threadId,
    project_id: store.canonicalProjectId(root.project_id),
    subject: store.threadSubject(threadId),
    first_review_id: first.id,
    latest_review_id: latestReview.id,
    round,
    title: guide.title,
    files: guide.files,
    additions: guide.additions,
    deletions: guide.deletions,
    agent: author.kind === "agent" ? { host: author.host, session: author.session, name: author.name } : null,
    source: guide.source ?? sourceOf(latestReview),
    ...(guide.walkthrough ? { walkthrough: true as const } : {}),
    verdict,
    answered,
    reviewed_at: latestReview.created_at,
    updated_at: last.created_at,
    resolved_at: root.resolved_at,
  };
}

export interface InboxReviewIndex {
  threads(): InboxReviewThread[];
}

export function createInboxReviewIndex(store: InboxReviewIndexStore): InboxReviewIndex {
  let built: { cursor: number; reloads: number; threads: InboxReviewThread[] } | null = null;
  let sources = new Map<string, InboxReviewSource | null>();
  return {
    threads() {
      const cursor = store.cursor();
      const reloads = store.reloadCount();
      if (built && built.cursor === cursor && built.reloads === reloads) return built.threads;
      const kept = new Map<string, InboxReviewSource | null>();
      const sourceOf = (message: InboxMessage): InboxReviewSource | null => {
        const sha = message.guide?.sha256;
        if (!sha) return null;
        let source = sources.has(sha) ? sources.get(sha)! : kept.get(sha);
        if (source === undefined) {
          source = null;
          try {
            const parsed = parseGuideSnapshotJson(readFileSync(inboxBlobPath(store.dir, sha), "utf8"));
            if (parsed.ok) source = inboxReviewSourceOf(parsed.value);
          } catch {
          }
        }
        kept.set(sha, source);
        return source;
      };
      const threads: InboxReviewThread[] = [];
      for (const threadId of store.threadIds()) {
        const thread = inboxReviewThreadOf(store, threadId, sourceOf);
        if (thread) threads.push(thread);
      }
      sources = kept;
      built = { cursor, reloads, threads };
      return threads;
    },
  };
}

export const INBOX_PULL_STATE_AGAIN_MS = 30 * 60_000;
export const INBOX_PULL_STATE_CLOSED_AGAIN_MS = 24 * 60 * 60_000;
export const INBOX_PULL_STATE_READS = 5;

const INBOX_UNNAMED_FORK = "fork";

export interface InboxPullStateAnswer {
  state: "open" | "merged" | "closed";
  at: string | null;
  title: string;
  url: string;
  head: string | null;
  head_sha: string | null;
  head_repo: string | null;
  base: string | null;
  author: string | null;
}

export async function readInboxPullState(run: RefRunner, cli: InboxPullHost["cli"], ref: { host: string; repo: string; number: number }): Promise<InboxPullStateAnswer | null> {
  const endpoint = cli === "gh" ? `repos/${ref.repo}/pulls/${ref.number}` : `projects/${encodeURIComponent(ref.repo)}/merge_requests/${ref.number}`;
  const read = await run(cli, ["api", "--hostname", ref.host, endpoint]).catch(() => null);
  if (!read || read.exitCode !== 0) return null;
  try {
    const pr = JSON.parse(read.stdout) as { state?: unknown; merged_at?: unknown; closed_at?: unknown; title?: unknown; html_url?: unknown; web_url?: unknown; head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } }; sha?: unknown; source_project_id?: unknown; target_project_id?: unknown; source_branch?: unknown; base?: { ref?: unknown }; target_branch?: unknown; user?: { login?: unknown }; author?: { username?: unknown } };
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    const merged = text(pr.merged_at);
    const state = merged || pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : pr.state === "open" || pr.state === "opened" ? "open" : null;
    const url = text(pr.html_url) ?? text(pr.web_url);
    if (!state || !url) return null;
    return { state, at: merged ?? text(pr.closed_at), title: text(pr.title) ?? "", url, head: text(pr.head?.ref) ?? text(pr.source_branch), head_sha: text(pr.head?.sha) ?? text(pr.sha), head_repo: text(pr.head?.repo?.full_name) ?? (pr.source_project_id && pr.source_project_id !== pr.target_project_id ? INBOX_UNNAMED_FORK : null), base: text(pr.base?.ref) ?? text(pr.target_branch), author: text(pr.user?.login) ?? text(pr.author?.username) };
  } catch {
    return null;
  }
}

async function readInboxForgeLogin(run: RefRunner, cli: InboxPullHost["cli"], host: string): Promise<string | null> {
  const read = await run(cli, ["api", "--hostname", host, "user"]).catch(() => null);
  if (!read || read.exitCode !== 0) return null;
  try {
    const user = JSON.parse(read.stdout) as { login?: unknown; username?: unknown };
    const name = user.login ?? user.username;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

export async function readInboxReviewLink(
  run: RefRunner | undefined,
  link: { ref: { key: string; platform: InboxPull["platform"]; host: string; repo: string; number: number } },
  login: string | null,
): Promise<InboxPull | null> {
  const { ref } = link;
  const cli = ref.platform === "gitlab" ? "glab" : "gh";
  const runner = run ?? refCliRunner;
  const state = await readInboxPullState(runner, cli, ref);
  const address = state && URL.canParse(state.url) ? new URL(state.url) : null;
  if (!state || address?.protocol !== "https:" || address.host.toLowerCase() !== ref.host) return null;
  const me = login ?? (await readInboxForgeLogin(runner, cli, ref.host));
  return {
    key: ref.key,
    platform: ref.platform,
    host: ref.host,
    repo: ref.repo,
    number: ref.number,
    url: state.url,
    title: state.title,
    author: state.author,
    mine: !!me && state.author === me,
    requested: false,
    state: state.state,
    base: state.base ?? "",
    head: state.head ?? "",
    ...(state.head_sha ? { head_sha: state.head_sha } : {}),
    head_repo: state.head_repo,
    additions: 0,
    deletions: 0,
    files: 0,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: null,
    updated_at: state.at ?? "",
    merged_at: state.state === "merged" ? state.at : null,
  };
}

export function createInboxPullStates(options: { run?: RefRunner; now?: () => number; onLand: (record: readonly InboxReviewLanding[], forget?: readonly string[]) => void }) {
  const run = options.run ?? refCliRunner;
  const now = options.now ?? Date.now;
  const lastRead = new Map<string, number>();
  let reading: Promise<void> | null = null;
  return {
    look(input: {
      threads: readonly InboxReviewThread[];
      pulls: readonly InboxPull[];
      hosts: readonly InboxPullHost[];
      owners: ReadonlyMap<string, { thread_id: string }>;
      landed: readonly InboxReviewLanding[];
    }): Promise<void> {
      if (reading) return reading;
      const byThread = new Map(input.threads.map((thread) => [thread.thread_id, thread]));
      const listed = new Set(input.pulls.map((pull) => pull.key));
      const cliOf = new Map(input.hosts.filter((host) => !host.error).map((host) => [host.host, host.cli]));
      const wanted = new Map<string, Set<string>>();
      const want = (key: string, threadId: string) => wanted.set(key, (wanted.get(key) ?? new Set()).add(threadId));
      for (const [key, owner] of input.owners) if (byThread.has(owner.thread_id)) want(key, owner.thread_id);
      for (const thread of input.threads) {
        const key = thread.source?.pr ? inboxPullRefOfUrl(thread.source.pr.url)?.key : null;
        if (key) want(key, thread.thread_id);
      }
      const merged = new Set(input.landed.filter((landing) => landing.state === "merged").map(inboxReviewLandingId));
      const recorded = new Set(input.landed.map(inboxReviewLandingId));
      const due: { key: string; threads: string[]; cli: InboxPullHost["cli"]; ref: NonNullable<ReturnType<typeof inboxPullRefOfKey>> }[] = [];
      const pick = (again: (key: string, threads: string[]) => number | null) => {
        for (const [key, threadIds] of wanted) {
          if (due.length >= INBOX_PULL_STATE_READS) return;
          const threads = [...threadIds];
          const wait = listed.has(key) || due.some((d) => d.key === key) ? null : again(key, threads);
          if (wait === null || now() - (lastRead.get(key) ?? -Infinity) < wait) continue;
          const ref = inboxPullRefOfKey(key);
          const cli = ref ? cliOf.get(ref.host) : undefined;
          if (ref && cli) due.push({ key, threads, cli, ref });
        }
      };
      const ids = (key: string, threads: readonly string[]) => threads.map((thread_id) => inboxReviewLandingId({ key, thread_id }));
      pick((key, threads) => (ids(key, threads).some((id) => !recorded.has(id)) ? INBOX_PULL_STATE_AGAIN_MS : null));
      pick((key, threads) => (ids(key, threads).every((id) => recorded.has(id) && !merged.has(id)) ? INBOX_PULL_STATE_CLOSED_AGAIN_MS : null));
      if (due.length === 0) return Promise.resolve();
      reading = (async () => {
        for (const { key, threads, cli, ref } of due) {
          lastRead.set(key, now());
          const state = await readInboxPullState(run, cli, ref);
          if (!state) continue;
          if (state.state === "open") {
            if (input.landed.some((landing) => landing.key === key)) options.onLand([], [key]);
            continue;
          }
          const platform = cli === "gh" ? ("github" as const) : ("gitlab" as const);
          const fresh = threads.filter((threadId) => !recorded.has(inboxReviewLandingId({ key, thread_id: threadId })));
          options.onLand(fresh.map((threadId) => inboxReviewLandingOf({ key, url: state.url, number: ref.number, title: state.title, platform, state: state.state as "merged" | "closed", at: state.at, head: state.head }, threadId, byThread.get(threadId) ?? null)));
        }
      })()
        .catch((cause) => console.error(`inbox: reading a pull request's state failed: ${cause instanceof Error ? cause.message : String(cause)}`))
        .finally(() => {
          reading = null;
        });
      return reading;
    },
  };
}
