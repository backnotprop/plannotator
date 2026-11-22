/**
 * The Board's cards (approval "inbox-board"): the PR reference a card links,
 * read from what an agent writes. The rules on columns and who may move a
 * card live in the store (store.ts, "the Board's cards"), so the MCP tool, the
 * CLI and the window's routes share them.
 */

import type { InboxCardPr } from "@plannotator/core/inbox-types";
import { parsePRUrl } from "../pr-types";

/** `owner/repo#123`, the shorthand for a GitHub PR. */
const SHORTHAND = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d{1,9})$/;

/**
 * A PR or merge request as a card keeps it, or null when `value` names
 * none: `owner/repo#123` (GitHub), or a GitHub, GitHub Enterprise, GitLab or
 * Bitbucket Cloud PR URL (`parsePRUrl`, the review's own parser). A URL is
 * kept as its canonical form, without a trailing `/files` or a query.
 * A Forgejo / Gitea PR URL is none here: the Board has no Forgejo source yet,
 * so it stays a plain web link to its own address, as before Forgejo reviews
 * existed. Read as a PR, it was given GitHub's `/pull/N` link or GitHub's source.
 */
export function parseInboxCardPr(value: unknown): InboxCardPr | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 2048) return null;
  const short = SHORTHAND.exec(text);
  if (short) {
    const [, owner, repo, number] = short;
    return { ref: `${owner}/${repo}#${Number(number)}`, url: `https://github.com/${owner}/${repo}/pull/${Number(number)}` };
  }
  const pr = parsePRUrl(text);
  if (!pr || pr.platform === "forgejo") return null;
  if (pr.platform === "gitlab") return { ref: `${pr.projectPath}!${pr.iid}`, url: `https://${pr.host}/${pr.projectPath}/-/merge_requests/${pr.iid}` };
  if (pr.platform === "bitbucket") return { ref: `${pr.workspace}/${pr.repo}#${pr.number}`, url: `https://bitbucket.org/${pr.workspace}/${pr.repo}/pull-requests/${pr.number}` };
  const ref = pr.host === "github.com" ? `${pr.owner}/${pr.repo}#${pr.number}` : `${pr.host}/${pr.owner}/${pr.repo}#${pr.number}`;
  return { ref, url: `https://${pr.host}/${pr.owner}/${pr.repo}/pull/${pr.number}` };
}

/** What a refused PR reference is told. */
export const INBOX_CARD_PR_HINT = 'pr: "owner/repo#123", or the PR\'s URL (GitHub, GitLab, Bitbucket).';
