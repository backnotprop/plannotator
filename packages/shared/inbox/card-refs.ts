/**
 * The Board's references (owner's answer, 2026-10-26): what a card links
 * outside the Inbox, read from what an agent or the person writes. A general
 * model with pluggable sources, not PR-only: each source is one adapter, a
 * parser here and a resolver on the server (packages/server/inbox-card-refs.ts),
 * so adding Linear, Jira, Figma or Vercel is one parser plus one resolver
 * and nothing else changes. This registry is the one place that lists the
 * parsers; the store and the routes ask it, never a source by name.
 *
 * Parsers run in order and the first that reads the input wins. Fixed hosts
 * come before any structural match (a future `*.atlassian.net` adapter goes
 * last), so a suffix match never shadows an exact host. Hosts are read as
 * written (`parseForgeRefUrl`'s rule): a host that only starts like a forge
 * (`github.com-evil.example`) is no forge.
 */

import type { InboxCardRef } from "@plannotator/core/inbox-types";
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

/** Every source's parser, in match order: fixed hosts first. */
export const INBOX_CARD_REF_PARSERS: readonly InboxCardRefParser[] = [forgeParser, prUrlParser];

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
export const INBOX_CARD_REF_HINT = 'ref: an issue or PR as "owner/repo#123", or its URL (GitHub, GitLab; a Bitbucket PR).';
