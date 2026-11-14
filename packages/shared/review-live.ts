import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REVIEW_LIVE_PREFIX = "/api/live/";

export interface ReviewLiveTarget {
  host: string;
  session: string;
}

export interface ReviewLiveContext {
  dataDir: string;
  projectPath: () => string | null;
  review: () => { key: string; title: string } | null;
  launchedBy: ReviewLiveTarget | null;
  fetch?: typeof fetch;
}

export interface ReviewLiveRequest {
  method: string;
  pathname: string;
  readJson: () => Promise<Record<string, unknown>>;
  signal?: AbortSignal;
}

export type ReviewLiveAnswer = { status: number; json: unknown } | { status: number; stream: ReadableStream<Uint8Array> };

interface InboxAddress {
  base: string;
  url: string;
  serverSession: string;
}

export function reviewLiveTargetOf(tag: string | undefined | null): ReviewLiveTarget | null {
  if (!tag) return null;
  const at = tag.indexOf(":");
  if (at <= 0 || at === tag.length - 1) return null;
  return { host: tag.slice(0, at), session: tag.slice(at + 1) };
}

function inboxAddress(dataDir: string): InboxAddress | null {
  try {
    const entry = JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8")) as { port?: unknown; serverSession?: unknown; url?: unknown };
    if (typeof entry.port !== "number" || typeof entry.serverSession !== "string") return null;
    const base = `http://127.0.0.1:${entry.port}`;
    return { base, url: typeof entry.url === "string" && /^https?:\/\//.test(entry.url) ? entry.url.replace(/\/+$/, "") : base, serverSession: entry.serverSession };
  } catch {
    return null;
  }
}

const NO_INBOX = { status: 503, json: { error: "The Plannotator Inbox is not running, so no agent can be reached from this review.", code: "inbox_off" } };

const INBOX_LIVE_PATHS = /^\/api\/live\/(state|agents|send|events|reply\/[A-Za-z0-9_]+|resolve\/[A-Za-z0-9_]+|send-now\/[A-Za-z0-9_]+)$/;

export function isReviewLivePath(pathname: string): boolean {
  return INBOX_LIVE_PATHS.test(pathname);
}

export async function handleReviewLiveRequest(request: ReviewLiveRequest, context: ReviewLiveContext): Promise<ReviewLiveAnswer | null> {
  const match = INBOX_LIVE_PATHS.exec(request.pathname);
  if (!match) return null;
  const route = match[1]!;
  const doFetch = context.fetch ?? fetch;
  const review = context.review();
  const projectPath = context.projectPath();
  const inbox = inboxAddress(context.dataDir);
  const relay = async (path: string, init?: RequestInit): Promise<ReviewLiveAnswer> => {
    if (!inbox) return NO_INBOX;
    try {
      const response = await doFetch(`${inbox.base}${path}`, { ...init, signal: request.signal });
      return { status: response.status, json: await response.json().catch(() => ({ error: "The Inbox answered something unreadable." })) };
    } catch {
      return NO_INBOX;
    }
  };
  const post = async (path: string, body: Record<string, unknown>) =>
    relay(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, serverSession: inbox?.serverSession }) });

  if (route === "state") {
    if (request.method !== "GET") return { status: 405, json: { error: "Use GET." } };
    const base = { review, launched_by: context.launchedBy };
    if (!inbox) return { status: 200, json: { ...base, inbox: false, thread: null, messages: [] } };
    if (!review || !projectPath) return { status: 200, json: { ...base, inbox: true, thread: null, messages: [] } };
    const answer = await relay(`/api/inbox/review-threads?${new URLSearchParams({ project_path: projectPath, key: review.key })}`);
    if (answer.status === 503) return { status: 200, json: { ...base, inbox: false, thread: null, messages: [] } };
    if (!("json" in answer) || answer.status !== 200) return answer;
    const found = answer.json as { thread?: { id?: string } | null };
    const threadUrl = found.thread?.id ? `${inbox.url}/#thread=${found.thread.id}` : null;
    return { status: 200, json: { ...base, inbox: true, ...(answer.json as Record<string, unknown>), thread_url: threadUrl } };
  }
  if (route === "agents") {
    if (request.method !== "GET") return { status: 405, json: { error: "Use GET." } };
    const answer = await relay("/api/inbox/sessions");
    if (!("json" in answer) || answer.status !== 200) return answer;
    const projects = ((answer.json as { projects?: { project: { name: string; root: string }; sessions: { host: string; session: string; label?: string; busy?: boolean }[] }[] }).projects ?? []);
    const agents = projects.flatMap((group) =>
      group.sessions.map((s) => ({ host: s.host, session: s.session, label: s.label ?? null, busy: s.busy === true, project: group.project.name, here: projectPath !== null && group.project.root === projectPath })),
    );
    return { status: 200, json: { agents, launched_by: context.launchedBy } };
  }
  if (route === "events") {
    if (request.method !== "GET") return { status: 405, json: { error: "Use GET." } };
    if (!inbox) return NO_INBOX;
    try {
      const response = await doFetch(`${inbox.base}/api/inbox/events`, { signal: request.signal, headers: { Accept: "text/event-stream" } });
      if (!response.ok || !response.body) return { status: response.status || 502, json: { error: "The Inbox's stream is not open." } };
      return { status: 200, stream: response.body };
    } catch {
      return NO_INBOX;
    }
  }
  if (request.method !== "POST") return { status: 405, json: { error: "Use POST." } };
  const body = await request.readJson();
  if (route === "send") {
    if (!review || !projectPath) return { status: 409, json: { error: "This review has no branch or pull request to keep its threads on.", code: "review_unkeyed" } };
    return post("/api/inbox/review-threads/send", { ...body, project_path: projectPath, review, ...(body.to === undefined && context.launchedBy ? { to: context.launchedBy } : {}) });
  }
  const [kind, id] = route.split("/") as [string, string];
  if (kind === "reply") return post(`/api/inbox/messages/${id}/reply`, { questions: [], ...body });
  if (kind === "resolve") return post(`/api/inbox/review-threads/comments/${id}/resolve`, body);
  return post(`/api/inbox/messages/${id}/send-now`, body);
}
