import type { InboxCardPr } from "@plannotator/core/inbox-types";
import { parsePRUrl } from "../pr-types";

const SHORTHAND = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d{1,9})$/;

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
  if (!pr) return null;
  if (pr.platform === "gitlab") return { ref: `${pr.projectPath}!${pr.iid}`, url: `https://${pr.host}/${pr.projectPath}/-/merge_requests/${pr.iid}` };
  if (pr.platform === "bitbucket") return { ref: `${pr.workspace}/${pr.repo}#${pr.number}`, url: `https://bitbucket.org/${pr.workspace}/${pr.repo}/pull-requests/${pr.number}` };
  const ref = pr.host === "github.com" ? `${pr.owner}/${pr.repo}#${pr.number}` : `${pr.host}/${pr.owner}/${pr.repo}#${pr.number}`;
  return { ref, url: `https://${pr.host}/${pr.owner}/${pr.repo}/pull/${pr.number}` };
}

export const INBOX_CARD_PR_HINT = 'pr: "owner/repo#123", or the PR\'s URL (GitHub, GitLab, Bitbucket).';
