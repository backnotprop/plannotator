/**
 * Linear hover cards on the Inbox server (core `linear-ref-card.ts`).
 * `createRefCards` reads
 * forge links; `withLinearCards` puts Linear in front of it, so the Inbox's
 * `GET /api/inbox/ref?url=` answers a Linear issue link too (one hook line in
 * inbox.ts), and `linearRefsRoute` serves `GET /api/inbox/linear-refs`
 * (`{ serverSession, workspace, teams }`: which bare identifiers the window
 * links; one more hook in inbox.ts).
 *
 * The fetch: one read-only GraphQL `query` POSTed to api.linear.app with the
 * API key as is (never logged, never sent anywhere else). The key is the one
 * pasted in Settings → Accounts (inbox-linear-key.ts), else `LINEAR_API_KEY`
 * in the env, read per fetch. No
 * key: the card says to set one (`signed_out`), and no teams link. Per issue:
 * fresh 60 s, a failure 30 s, a stale answer served while one refresh runs (up
 * to 15 min), one request shared by hovers, at most 500 kept; a rate-limit
 * answer pauses Linear for 60 s. Avatars are inlined as data URIs (the window's
 * CSP takes no remote image).
 */

import {
  FORGE_REF_BODY_MAX,
  FORGE_REF_COMMENT_MAX,
  type ForgeRefCardData,
  type ForgeRefCardError,
  type ForgeRefCardResult,
  type ForgeRefLinked,
  type ForgeRefPerson,
} from "@plannotator/core/forge-ref-card";
import { LINEAR_TEAM_KEY, parseLinearRefUrl, type LinearCardData, type LinearCardFields, type LinearIssueRefs, type LinearRef } from "@plannotator/core/linear-ref-card";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import {
  fetchAvatarDataUri,
  REF_AUTH_HOSTS_MS,
  REF_CACHE_MAX,
  REF_FAILURE_MS,
  REF_FRESH_MS,
  REF_RATE_LIMIT_MS,
  REF_STALE_MAX_MS,
  REF_TIMEOUT_MS,
  type RefCards,
} from "@plannotator/shared/ref-cards";

export const LINEAR_API_URL = "https://api.linear.app/graphql";
const LN_PERSON = "displayName name avatarUrl";
export const LINEAR_REF_QUERY = `query($id: String!) {
  issue(id: $id) {
    identifier number title url description priorityLabel priority estimate createdAt updatedAt completedAt canceledAt
    state { name type color } team { key name } project { name }
    creator { ${LN_PERSON} } assignee { ${LN_PERSON} } labels(first: 8) { nodes { name color } }
    comments(first: 1) { nodes { body createdAt user { ${LN_PERSON} } } }
    allComments: comments(first: 100) { nodes { id } }
    attachments(first: 10) { nodes { url title sourceType metadata } }
  }
}`;
export const LINEAR_TEAMS_QUERY = `query { organization { urlKey } teams(first: 100) { nodes { key } } }`;

for (const q of [LINEAR_REF_QUERY, LINEAR_TEAMS_QUERY]) {
  if (!/^query\b/.test(q)) throw new Error("linear cards: every query must be a query");
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const nodes = (v: unknown): Json[] => (Array.isArray(obj(v).nodes) ? (obj(v).nodes as unknown[]).map(obj) : []);
const hex = (v: unknown) => {
  const s = str(v).replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : "888888";
};
function cut(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max).trimEnd()}…`, cut: true } : { text, cut: false };
}

/** The Linear API key: `LINEAR_API_KEY` in the env. Never logged. */
export function linearApiKey(env: Record<string, string | undefined> = process.env): string | null {
  return env.LINEAR_API_KEY?.trim() || null;
}

const linearAvatar = (url: string) => (/^https:\/\/(public|static)\.linear\.app\//.test(url) ? url : null);
const STATE_TYPES = new Set(["triage", "backlog", "unstarted", "started", "completed", "canceled"]);

/** A Linear person: the display name stands in for the login (Linear has no handle in links). */
function personOf(v: unknown): ForgeRefPerson | null {
  const p = obj(v);
  const name = str(p.displayName) || str(p.name);
  return name ? { login: name, avatarUrl: linearAvatar(str(p.avatarUrl)) } : null;
}

/**
 * A Linear answer (the parsed JSON body) as card data; `not_found` when the
 * identifier names nothing; null when the answer is not one. GitHub pull
 * requests attached to the issue come back as `linked`.
 */
export function parseLinearRefAnswer(body: unknown): LinearCardData | "not_found" | null {
  const root = obj(body);
  const errors = Array.isArray(root.errors) ? root.errors.map(obj) : [];
  if (errors.some((e) => /Entity not found/i.test(str(e.message)))) return "not_found";
  if (!root.data || errors.length) return null;
  const data = obj(root.data);
  if (data.issue === null) return "not_found";
  const item = obj(data.issue);
  if (!str(item.identifier)) return null;
  const state = obj(item.state);
  const stateType = str(state.type);
  const team = obj(item.team);
  const description = cut(str(item.description), FORGE_REF_BODY_MAX);
  // Linear lists a connection newest first with `first` (oldest first with `last`): `comments(first: 1)` is the latest.
  const last = nodes(item.comments).at(0);
  const assignee = personOf(item.assignee);
  const linked: ForgeRefLinked[] = nodes(item.attachments).flatMap((a) => {
    const meta = obj(a.metadata);
    if (a.sourceType !== "github" || !num(meta.number)) return [];
    const status = str(meta.status);
    return [{ number: num(meta.number), title: str(meta.title) || str(a.title), url: str(a.url), state: status === "merged" ? "merged" : status === "closed" ? "closed" : "open" }];
  });
  return {
    platform: "linear",
    kind: "issue",
    repo: str(team.key),
    number: num(item.number),
    url: str(item.url),
    title: str(item.title),
    state: stateType === "completed" ? "completed" : stateType === "canceled" ? "not_planned" : "open",
    author: personOf(item.creator),
    createdAt: str(item.createdAt),
    updatedAt: str(item.updatedAt),
    closedAt: str(item.completedAt) || str(item.canceledAt) || null,
    labels: nodes(item.labels).map((l) => ({ name: str(l.name), color: hex(l.color) })),
    assignees: assignee ? [assignee] : [],
    // Linear connections have no total: counted up to 100.
    comments: nodes(item.allComments).length,
    body: description.text,
    bodyCut: description.cut,
    lastComment: last ? { author: personOf(last.user), at: str(last.createdAt), body: cut(str(last.body), FORGE_REF_COMMENT_MAX).text } : null,
    linked: linked.slice(0, 3),
    linear: {
      identifier: str(item.identifier),
      team: str(team.name),
      stateName: str(state.name),
      stateType: STATE_TYPES.has(stateType) ? (stateType as LinearCardFields["stateType"]) : null,
      stateColor: hex(state.color),
      priority: num(item.priority) > 0 ? str(item.priorityLabel) || null : null,
      project: str(obj(item.project).name) || null,
      estimate: typeof item.estimate === "number" ? item.estimate : null,
    },
  } as LinearCardData;
}

/** The workspace and team keys bare identifiers link with, or null when the answer is not one. */
export function parseLinearTeamsAnswer(body: unknown): LinearIssueRefs | null {
  const data = obj(obj(body).data);
  const workspace = str(obj(data.organization).urlKey);
  const teams = nodes(data.teams)
    .map((t) => str(t.key))
    .filter((k) => LINEAR_TEAM_KEY.test(k));
  return workspace && /^[A-Za-z0-9_.-]{1,100}$/.test(workspace) ? { workspace, teams } : null;
}

/** What a failed Linear answer means (HTTP status and parsed body). */
export function linearErrorOf(status: number, body: unknown): ForgeRefCardError {
  const errors = Array.isArray(obj(body).errors) ? (obj(body).errors as unknown[]).map(obj) : [];
  const codes = errors.map((e) => str(obj(e.extensions).code));
  if (status === 429 || codes.includes("RATELIMITED")) return "rate_limited";
  if (status === 401 || status === 403 || codes.includes("AUTHENTICATION_ERROR") || codes.includes("FORBIDDEN")) return "signed_out";
  return "unavailable";
}

export interface LinearCards {
  /** The card for a Linear issue link, or null when the link is not one. */
  get(href: string): Promise<ForgeRefCardResult | null>;
  /** The workspace and team keys bare identifiers link with; null with no key or on a failure. */
  issueRefs(): Promise<LinearIssueRefs | null>;
  /** Drop every answer and the teams: the key changed, so what the old one saw (or could not) is stale. */
  forget(): void;
}

export function createLinearCards(options: {
  apiKey?: () => string | null | Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => number;
  avatar?: (url: string) => Promise<string | null>;
} = {}): LinearCards {
  const apiKey = options.apiKey ?? (() => linearApiKey());
  const now = options.now ?? Date.now;
  const avatarOf = options.avatar ?? ((url: string) => fetchAvatarDataUri(url, options.fetch));
  const cache = new Map<string, { result: ForgeRefCardResult; at: number }>();
  const pending = new Map<string, Promise<ForgeRefCardResult>>();
  const avatars = new Map<string, Promise<string | null>>();
  let pausedUntil = 0;

  /** One read-only query with the key; "no_key" without one; null when it failed. */
  const ask = async (query: string, variables: Record<string, string>): Promise<{ res: Response; body: unknown } | "no_key" | null> => {
    const key = (await apiKey())?.trim();
    if (!key) return "no_key";
    try {
      const res = await (options.fetch ?? fetch)(LINEAR_API_URL, {
        method: "POST",
        // A personal API key goes in as is, with no Bearer prefix.
        headers: { "content-type": "application/json", authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REF_TIMEOUT_MS),
        redirect: "error",
      });
      return { res, body: await res.json().catch(() => null) };
    } catch {
      return null;
    }
  };

  const fail = (error: ForgeRefCardError): ForgeRefCardResult => ({ ok: false, error, fetchedAt: now() });

  const inline = async (person: ForgeRefPerson | null) => {
    if (!person?.avatarUrl) return;
    const url = person.avatarUrl;
    if (!avatars.has(url)) {
      if (avatars.size >= REF_CACHE_MAX) avatars.delete(avatars.keys().next().value!);
      avatars.set(url, avatarOf(url).catch(() => null));
    }
    person.avatarUrl = await avatars.get(url)!;
  };

  const fetchOnce = async (ref: LinearRef): Promise<ForgeRefCardResult> => {
    if (now() < pausedUntil) return fail("rate_limited");
    const answer = await ask(LINEAR_REF_QUERY, { id: `${ref.repo}-${ref.number}` });
    if (answer === "no_key") return fail("signed_out");
    if (!answer) return fail("unavailable");
    const data = parseLinearRefAnswer(answer.body);
    if (data === "not_found") return fail("not_found");
    if (!data || !answer.res.ok) {
      const error = linearErrorOf(answer.res.status, answer.body);
      if (error === "rate_limited") pausedUntil = now() + REF_RATE_LIMIT_MS;
      return fail(error);
    }
    await Promise.all([data.author, ...data.assignees, data.lastComment?.author ?? null].map(inline));
    return { ok: true, data: data as unknown as ForgeRefCardData, fetchedAt: now() };
  };

  const refresh = (key: string, ref: LinearRef): Promise<ForgeRefCardResult> => {
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const job = fetchOnce(ref)
      .then((result) => {
        const kept = cache.get(key);
        // A failed refresh keeps a good answer (held off for REF_FAILURE_MS by its age below).
        if (!result.ok && kept?.result.ok) {
          kept.at = now() - REF_FRESH_MS + REF_FAILURE_MS;
          return kept.result;
        }
        cache.delete(key);
        if (cache.size >= REF_CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(key, { result, at: now() });
        return result;
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  };

  let teams: { at: number; ttl: number; refs: Promise<LinearIssueRefs | null> } | null = null;

  return {
    async get(href) {
      const ref = parseLinearRefUrl(href);
      if (!ref) return null;
      // One identifier names one issue, whichever workspace key the link carries.
      const key = `${ref.repo}-${ref.number}`;
      const kept = cache.get(key);
      if (kept) {
        const age = now() - kept.at;
        const fresh = kept.result.ok ? REF_FRESH_MS : REF_FAILURE_MS;
        if (age < fresh) return kept.result;
        if (kept.result.ok && age < REF_STALE_MAX_MS) {
          void refresh(key, ref);
          return kept.result;
        }
      }
      return refresh(key, ref);
    },
    issueRefs() {
      if (teams && now() - teams.at < teams.ttl) return teams.refs;
      const refs = ask(LINEAR_TEAMS_QUERY, {}).then((a) => (a && a !== "no_key" && a.res.ok ? parseLinearTeamsAnswer(a.body) : null));
      const entry = { at: now(), ttl: REF_AUTH_HOSTS_MS, refs };
      teams = entry;
      void refs.then((r) => {
        if (!r) entry.ttl = REF_FAILURE_MS;
      });
      return refs;
    },
    forget() {
      cache.clear();
      teams = null;
      pausedUntil = 0;
    },
  };
}

/** The forge hover cards with Linear in front: a Linear issue link answers from `linear`, any other from `cards`. */
export function withLinearCards<T extends RefCards>(cards: T, linear: LinearCards | null): T {
  if (!linear) return cards;
  return { ...cards, get: async (href: string) => (await linear.get(href)) ?? cards.get(href) };
}

/**
 * `GET /api/inbox/linear-refs`: `{ serverSession, workspace, teams }`, `{ workspace: null, teams: [] }` without a
 * key. The window's read guard (another site's request `403 cross_origin`); not on the device door (not in its
 * allowlist). Null for any other path.
 */
export async function linearRefsRoute(
  req: Request,
  path: string,
  linear: LinearCards | null,
  serverSession: string,
  json: (body: unknown, status?: number) => Response,
): Promise<Response | null> {
  if (path !== "/api/inbox/linear-refs") return null;
  if (req.method !== "GET") return json({ error: "Use GET." }, 405);
  if (!isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
    return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
  }
  const refs = linear ? await linear.issueRefs() : null;
  return json({ serverSession, workspace: refs?.workspace ?? null, teams: refs?.teams ?? [] });
}
