/**
 * The Board's references (owner's answer, 2026-10-26): what a card links
 * outside the Inbox, read from what an agent or the person writes. A general
 * model with pluggable sources, not PR-only: each source is one adapter, a
 * parser here and a resolver on the server (packages/server/inbox-card-refs.ts),
 * so adding Linear, Figma or Vercel is one parser plus one resolver and
 * nothing else changes (Jira and YouTrack are a parser only: a link, with no
 * resolver). Any other http(s) URL is a plain web link (`webParser`, last).
 * This registry is the one place that lists the parsers; the store and the
 * routes ask it, never a source by name.
 *
 * Parsers run in order and the first that reads the input wins. Fixed hosts
 * come before any structural match (Jira's `*.atlassian.net` and `/browse/`,
 * then YouTrack's `/issue/`), so a suffix match never shadows an exact host,
 * and the web link, which reads any http(s) URL, comes last. Hosts are read as
 * written (`parseForgeRefUrl`'s rule): a host that only starts like a forge
 * (`github.com-evil.example`) is no forge.
 */

import { inboxCardLinkLabel, type InboxCardRef } from "@plannotator/core/inbox-types";
import { forgeRefLabel, parseForgeRefUrl } from "@plannotator/core/forge-ref-card";
import { parseInboxCardPr } from "./cards";

/** What kind the caller expects: `pr` (the card action's `pr`) or any (`ref`). */
export type InboxCardRefHint = "pr" | "any";

/** One source's parser: the reference a piece of text names, or null. */
export interface InboxCardRefParser {
  source: string;
  parse(text: string, hint: InboxCardRefHint): InboxCardRef | null;
}

/** `owner/repo#123`: a GitHub issue or PR (GitHub answers both by number). */
const SHORTHAND = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([1-9]\d{0,8})$/;

/** GitHub and GitLab issue, PR and merge-request links, and GitHub's `owner/repo#N`. */
const forgeParser: InboxCardRefParser = {
  source: "forge",
  parse(text, hint) {
    const short = SHORTHAND.exec(text);
    if (short) {
      const [, owner, repo, num] = short;
      const n = Number(num);
      const kind = hint === "pr" ? "pr" : "issue";
      return { kind, source: "github", ref: `${owner}/${repo}#${n}`, url: `https://github.com/${owner}/${repo}/${kind === "pr" ? "pull" : "issues"}/${n}` };
    }
    const ref = parseForgeRefUrl(text);
    if (!ref) return null;
    const kind = ref.kind === "pull" ? "pr" : "issue";
    if (hint === "pr" && kind !== "pr") return null;
    const repo = `${ref.owner}/${ref.repo}`;
    const where = ref.host === "github.com" || ref.host === "gitlab.com" ? repo : `${ref.host}/${repo}`;
    const path =
      ref.platform === "gitlab"
        ? `${repo}/-/${kind === "pr" ? "merge_requests" : "issues"}/${ref.number}`
        : `${repo}/${kind === "pr" ? "pull" : "issues"}/${ref.number}`;
    return { kind, source: ref.platform, ref: `${where}${forgeRefLabel(ref)}`, url: `https://${ref.host}/${path}` };
  },
};

/** Bitbucket Cloud and the other PR URLs the review reads (`parsePRUrl`). */
const prUrlParser: InboxCardRefParser = {
  source: "pr-url",
  parse(text) {
    const pr = parseInboxCardPr(text);
    if (!pr) return null;
    const source = pr.url.startsWith("https://bitbucket.org/") ? "bitbucket" : pr.url.includes("/-/merge_requests/") ? "gitlab" : "github";
    return { kind: "pr", source, ref: pr.ref, url: pr.url };
  },
};

/** A Jira issue key: the project key (a capital letter, then capitals, digits or `_`), a dash, the number. */
const JIRA_KEY = /^([A-Z][A-Z0-9_]{1,49})-([1-9]\d{0,9})$/;
/** A Jira Cloud site: one name under atlassian.net. */
const JIRA_CLOUD_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;
/** Hosts that are never a self-hosted Jira or YouTrack, though a path on them may look like one. */
const NOT_TRACKER_HOSTS = new Set(["github.com", "www.github.com", "gitlab.com", "www.gitlab.com", "bitbucket.org", "www.bitbucket.org"]);

/**
 * Jira issues, link only (user feedback #9): no sign-in, no state, no fetch;
 * the server has no resolver for `jira`, so the opened card shows the key.
 * Read last, as the structural match it is:
 * - Jira Cloud, `https://<site>.atlassian.net/browse/KEY-123`, or a board or
 *   list link with `?selectedIssue=KEY-123` under `/jira/`;
 * - a self-hosted Jira, any other host, only when the path is exactly
 *   `/browse/KEY-123` with the key in capitals, so an ordinary link is
 *   never read as an issue.
 * The ref is the key (`DEMO-123`); the URL is the canonical
 * `<origin>/browse/KEY-123`, its query and fragment dropped.
 */
const jiraParser: InboxCardRefParser = {
  source: "jira",
  parse(text, hint) {
    if (hint === "pr") return null;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    const host = url.hostname;
    const cloud = JIRA_CLOUD_HOST.test(host);
    // Jira Cloud is https on its default port only; a self-hosted Jira keeps the port it was given.
    if (cloud && (url.protocol !== "https:" || url.port)) return null;
    let key: string | null = null;
    const browse = /^\/browse\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (browse) {
      // Jira Cloud reads a key in any case; a self-hosted link must be written as Jira writes it.
      key = cloud ? browse[1]!.toUpperCase() : browse[1]!;
    } else if (cloud && url.pathname.startsWith("/jira/")) {
      key = url.searchParams.get("selectedIssue")?.toUpperCase() ?? null;
    }
    if (!key || !JIRA_KEY.test(key)) return null;
    if (!cloud && NOT_TRACKER_HOSTS.has(host)) return null;
    return { kind: "issue", source: "jira", ref: key, url: `${url.protocol}//${url.host}/browse/${key}` };
  },
};

/**
 * A YouTrack issue ID: the project ID (a letter, then letters, digits or `_`;
 * one letter is a real ID, JetBrains' `R`), a dash, the number.
 */
const YOUTRACK_KEY = /^([A-Z][A-Z0-9_]{0,49})-([1-9]\d{0,9})$/;
/** A YouTrack Cloud site since 2021: one name under youtrack.cloud. */
const YOUTRACK_CLOUD_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.youtrack\.cloud$/;
/** A YouTrack Cloud site from before November 2021, served under `/youtrack`: one name under myjetbrains.com. */
const YOUTRACK_LEGACY_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myjetbrains\.com$/;
/** `[/youtrack]/issue/KEY-123`, then at most the summary slug YouTrack adds (`/Crash-on-save`). */
const YOUTRACK_PATH = /^(\/youtrack)?\/issue\/([A-Za-z0-9_]+-[0-9]+)(?:\/[^/]+)?$/;

/**
 * YouTrack issues, link only (user feedback #10), as Jira: no sign-in, no
 * state, no fetch; the server has no resolver for `youtrack`. Read after
 * Jira, as the structural match it is:
 * - YouTrack Cloud, `https://<name>.youtrack.cloud/issue/KEY-123[/slug]`;
 * - an older Cloud site, `https://<name>.myjetbrains.com/youtrack/issue/KEY-123[/slug]`;
 * - a self-hosted YouTrack, any other host, only when the path is exactly
 *   `/issue/KEY-123` or `/youtrack/issue/KEY-123` (optionally the slug) with
 *   the key in capitals, never on a forge's host.
 * Cloud reads a key in any case, as YouTrack does, and stores it in capitals.
 * The ref is the key (`PROJ-123`); the URL is the canonical
 * `<origin>[/youtrack]/issue/KEY-123`, its slug, query and fragment dropped.
 */
const youtrackParser: InboxCardRefParser = {
  source: "youtrack",
  parse(text, hint) {
    if (hint === "pr") return null;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    const host = url.hostname;
    const match = YOUTRACK_PATH.exec(url.pathname);
    if (!match) return null;
    const base = match[1] ?? "";
    const cloud = YOUTRACK_CLOUD_HOST.test(host) || YOUTRACK_LEGACY_HOST.test(host);
    // An older Cloud site serves YouTrack under /youtrack only; the rest of myjetbrains.com is not YouTrack.
    if (YOUTRACK_LEGACY_HOST.test(host) && base !== "/youtrack") return null;
    // YouTrack Cloud is https on its default port only; a self-hosted YouTrack keeps the port it was given.
    if (cloud && (url.protocol !== "https:" || url.port)) return null;
    const key = cloud ? match[2]!.toUpperCase() : match[2]!;
    if (!YOUTRACK_KEY.test(key)) return null;
    if (!cloud && NOT_TRACKER_HOSTS.has(host)) return null;
    return { kind: "issue", source: "youtrack", ref: key, url: `${url.protocol}//${url.host}${base}/issue/${key}` };
  },
};

/** The longest web link kept, as the browser writes it (escapes and an IDN's `xn--` host count). */
const WEB_URL_MAX = 2048;

/**
 * Any other web link (user feedback #10: "let me put any link in the links
 * section"): an http(s) URL no source above reads, written with its scheme.
 * A link only, never fetched. Refused: another scheme (`javascript:`,
 * `data:`, `file:`), a user or password in the URL (it can disguise the host:
 * `https://github.com@evil.example`), whitespace or a control character in
 * the text (not one URL), and a URL over 2048 characters once written out.
 * The URL is stored as the browser writes it (host in lowercase and `xn--`
 * form, the default port dropped), so the same page pasted twice is one
 * link; the ref is its short label (`inboxCardLinkLabel`).
 */
const webParser: InboxCardRefParser = {
  source: "web",
  parse(text, hint) {
    if (hint === "pr") return null;
    if (!/^https?:\/\//i.test(text) || /[\s\p{C}]/u.test(text)) return null;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || !url.hostname) return null;
    const href = url.href;
    if (href.length > WEB_URL_MAX) return null;
    return { kind: "link", source: "web", ref: inboxCardLinkLabel(href), url: href };
  },
};

/**
 * Every source's parser, in match order: fixed hosts first, then Jira's and
 * YouTrack's structural matches, then any other web link.
 */
export const INBOX_CARD_REF_PARSERS: readonly InboxCardRefParser[] = [forgeParser, prUrlParser, jiraParser, youtrackParser, webParser];

/** The reference `value` names, or null (not a string, too long, or no source reads it). */
export function parseInboxCardRef(value: unknown, hint: InboxCardRefHint = "any"): InboxCardRef | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 2048) return null;
  for (const parser of INBOX_CARD_REF_PARSERS) {
    const ref = parser.parse(text, hint);
    if (ref) return ref;
  }
  return null;
}

/** What a refused reference is told. */
export const INBOX_CARD_REF_HINT =
  'ref: an issue or PR as "owner/repo#123", or any http(s) link written with its scheme (https://…). GitHub and GitLab issues and PRs show their live state; Jira and YouTrack issue links show their key; any other link shows as a plain link.';
