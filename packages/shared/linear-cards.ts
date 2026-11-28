/**
 * Linear hover cards, both runtimes (core `linear-ref-card.ts`): the read
 * behind a Linear issue link's card. The Inbox serves it at
 * `GET /api/inbox/ref?url=` (packages/server/inbox-linear-cards.ts adds its
 * `GET /api/inbox/linear-refs`); the plan, annotate and review servers serve
 * it at `GET /api/ref` (`withSessionLinearCards`: the Bun servers through
 * packages/server/ref-cards.ts, Pi through apps/pi-extension/server/ref-cards.ts,
 * vendored to generated/linear-cards.ts).
 *
 * The fetch: one read-only GraphQL `query` POSTed to api.linear.app with the
 * API key as is (never logged, never sent anywhere else, never in an answer),
 * read per fetch, redirects refused. The key: the one saved in the Inbox's
 * Settings → Accounts → Linear (`<data dir>/inbox/linear-key`), else
 * `LINEAR_API_KEY` (`readLinearApiKey`). No key, or one Linear refuses: the
 * card answers `signed_out`, nothing is sent, and no teams link. Per issue:
 * fresh 60 s, a failure 30 s, a stale answer served while one refresh runs (up
 * to 15 min), one request shared by hovers, at most 500 kept; a rate-limit
 * answer pauses Linear for 60 s. Avatars are inlined as data URIs (the window's
 * CSP takes no remote image).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
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
} from "./ref-cards";

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
  // Only an https link on linear.app (the card's Open in Linear); anything else is dropped.
  const url = parseLinearRefUrl(str(item.url)) ? str(item.url) : "";
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
    url,
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

/**
 * Whether Linear took the key, from the teams read: `none` without a key, `refused` on a 401 or an authentication
 * error, `accepted` on any other answer Linear gave, `unknown` before one (or when Linear could not be reached).
 */
export type LinearKeyVerdict = "accepted" | "refused" | "unknown" | "none";

/** Linear refused the key itself: a 401 or an authentication error (a 403 or FORBIDDEN is one thing the key may not read). */
function keyRefused(status: number, body: unknown): boolean {
  const errors = Array.isArray(obj(body).errors) ? (obj(body).errors as unknown[]).map(obj) : [];
  return status === 401 || errors.some((e) => str(obj(e.extensions).code) === "AUTHENTICATION_ERROR");
}

export interface LinearCards {
  /** The card for a Linear issue link, or null when the link is not one. */
  get(href: string): Promise<ForgeRefCardResult | null>;
  /** The workspace and team keys bare identifiers link with; null with no key or on a failure. */
  issueRefs(): Promise<LinearIssueRefs | null>;
  /** The key's verdict after the teams read (cached with it). */
  keyVerdict(): Promise<LinearKeyVerdict>;
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
  /** `at`: when the answer was cached (or held off after a failed refresh); `goodAt`: its last good fetch. */
  const cache = new Map<string, { result: ForgeRefCardResult; at: number; goodAt: number }>();
  const pending = new Map<string, Promise<ForgeRefCardResult>>();
  const avatars = new Map<string, Promise<string | null>>();
  let pausedUntil = 0;
  /** Bumped by `forget()` (the key changed): an answer asked for under an older key is never kept or shown. */
  let generation = 0;
  let verdict: LinearKeyVerdict = "unknown";

  /**
   * One read-only query with the key; "no_key" without one; null when it failed. `judge`: the teams read, whose answer
   * sets the verdict (an issue's answer never does: a key may read the teams and still be refused one team's issue).
   */
  const ask = async (query: string, variables: Record<string, string>, judgeKey = false): Promise<{ res: Response; body: unknown } | "no_key" | null> => {
    const asked = generation;
    const key = (await apiKey())?.trim();
    if (!key) {
      if (judgeKey && asked === generation) verdict = "none";
      return "no_key";
    }
    const judge = (answer: { res: Response; body: unknown }) => {
      if (!judgeKey || asked !== generation) return answer;
      if (keyRefused(answer.res.status, answer.body)) verdict = "refused";
      else if (answer.res.ok) verdict = "accepted";
      return answer;
    };
    try {
      const res = await (options.fetch ?? fetch)(LINEAR_API_URL, {
        method: "POST",
        // A personal API key goes in as is, with no Bearer prefix.
        headers: { "content-type": "application/json", authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REF_TIMEOUT_MS),
        redirect: "error",
      });
      return judge({ res, body: await res.json().catch(() => null) });
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
    // The key's workspace must be the link's: another workspace's ENG-1 is not this one's.
    if (parseLinearRefUrl(data.url)?.owner !== ref.owner) return fail("not_found");
    await Promise.all([data.author, ...data.assignees, data.lastComment?.author ?? null].map(inline));
    return { ok: true, data: data as unknown as ForgeRefCardData, fetchedAt: now() };
  };

  const refresh = (key: string, ref: LinearRef): Promise<ForgeRefCardResult> => {
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const asked = generation;
    const job: Promise<ForgeRefCardResult> = fetchOnce(ref)
      .then((result) => {
        // The key changed while this was asked: ask again under the new one.
        if (asked !== generation) return refresh(key, ref);
        const kept = cache.get(key);
        // A failed refresh keeps a good answer (held off for REF_FAILURE_MS by its age below), never past the stale
        // limit from its last good fetch, and never when Linear refused the key.
        if (!result.ok && result.error !== "signed_out" && kept?.result.ok && now() - kept.goodAt < REF_STALE_MAX_MS) {
          kept.at = now() - REF_FRESH_MS + REF_FAILURE_MS;
          return kept.result;
        }
        cache.delete(key);
        if (cache.size >= REF_CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(key, { result, at: now(), goodAt: result.ok ? now() : 0 });
        return result;
      })
      .finally(() => {
        if (pending.get(key) === job) pending.delete(key);
      });
    pending.set(key, job);
    return job;
  };

  let teams: { at: number; ttl: number; refs: Promise<LinearIssueRefs | null> } | null = null;

  const issueRefs = (): Promise<LinearIssueRefs | null> => {
    if (teams && now() - teams.at < teams.ttl) return teams.refs;
    const refs = ask(LINEAR_TEAMS_QUERY, {}, true).then((a) => (a && a !== "no_key" && a.res.ok ? parseLinearTeamsAnswer(a.body) : null));
    const entry = { at: now(), ttl: REF_AUTH_HOSTS_MS, refs };
    teams = entry;
    void refs.then((r) => {
      if (!r) entry.ttl = REF_FAILURE_MS;
    });
    return refs;
  };

  return {
    async get(href) {
      const ref = parseLinearRefUrl(href);
      if (!ref) return null;
      // Per workspace: a link to another workspace's ENG-1 is never this one's card.
      const key = `${ref.owner}/${ref.repo}-${ref.number}`;
      const kept = cache.get(key);
      if (kept) {
        const age = now() - kept.at;
        const fresh = kept.result.ok ? REF_FRESH_MS : REF_FAILURE_MS;
        if (age < fresh) return kept.result;
        if (kept.result.ok && now() - kept.goodAt < REF_STALE_MAX_MS) {
          void refresh(key, ref);
          return kept.result;
        }
      }
      return refresh(key, ref);
    },
    issueRefs,
    async keyVerdict() {
      await issueRefs();
      return verdict;
    },
    forget() {
      generation++;
      verdict = "unknown";
      cache.clear();
      pending.clear();
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

/** Where the Inbox's Settings → Accounts → Linear saves the key, under the data dir. */
export const LINEAR_KEY_FILE = join("inbox", "linear-key");

/** The key saved in Settings → Accounts → Linear under `dataDir`, or null. */
export function savedLinearApiKey(dataDir: string): string | null {
  try {
    return readFileSync(join(dataDir, LINEAR_KEY_FILE), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** The key Linear is read with, on every server: the one saved in Settings → Accounts (under `dataDir`), else `LINEAR_API_KEY`. */
export function readLinearApiKey(dataDir: string, env: Record<string, string | undefined> = process.env): string | null {
  return savedLinearApiKey(dataDir) ?? linearApiKey(env);
}

/**
 * A plan, annotate or review server's cards (Bun and Pi): Linear issue links answered from Linear with the key
 * `readLinearApiKey(dataDir)` finds, read per fetch (a key saved or removed later counts at once); any other link
 * from `cards`. Without a key a Linear link answers `signed_out` and nothing is sent, so the page (which shows only
 * cards with data) keeps it a plain link.
 */
export function withSessionLinearCards<T extends RefCards>(cards: T, dataDir: string, env: Record<string, string | undefined> = process.env): T {
  return withLinearCards(cards, createLinearCards({ apiKey: () => readLinearApiKey(dataDir, env) }));
}
