import { type CommentSite, findComments } from './find-comments.ts';
import { type KeepEntry, type KeepReason, keepReason } from './rules.ts';

export interface KeptSite {
  site: CommentSite;
  reason: KeepReason;
}

export interface CommentPlan {
  remove: CommentSite[];
  keep: KeptSite[];
  parseErrors: number;
}

function onlyWhitespaceBetween(text: string, from: number, to: number): boolean {
  return /^[ \t]*\r?\n[ \t]*$/.test(text.slice(from, to));
}

function lineCommentGroups(text: string, sites: CommentSite[]): CommentSite[][] {
  const groups: CommentSite[][] = [];
  for (const site of sites) {
    const previousGroup = groups.at(-1);
    const previous = previousGroup?.at(-1);
    const isLine = !site.jsxExpression && site.comments[0]!.text.startsWith('//');
    const continues = previous !== undefined && isLine && !previous.jsxExpression && previous.comments[0]!.text.startsWith('//') && onlyWhitespaceBetween(text, previous.end, site.start);
    if (continues) previousGroup!.push(site);
    else groups.push([site]);
  }
  return groups;
}

export function planComments(path: string, text: string, keepList: KeepEntry[]): CommentPlan {
  const { sites, parseErrors } = findComments(path, text);
  const remove: CommentSite[] = [];
  const keep: KeptSite[] = [];
  for (const group of lineCommentGroups(text, sites)) {
    const reasons = group.map((site) => site.comments.map((comment) => keepReason(path, comment.text, keepList)).find((reason) => reason !== null) ?? null);
    const licenseInGroup = reasons.includes('license');
    group.forEach((site, index) => {
      const reason = reasons[index] ?? (licenseInGroup ? 'license' : null);
      if (reason) keep.push({ site, reason });
      else remove.push(site);
    });
  }
  return { remove, keep, parseErrors };
}
