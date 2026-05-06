import type { CodeAnnotation, ConventionalLabel, ConventionalDecoration } from '@plannotator/ui/types';
import type { PRMetadata } from '@plannotator/shared/pr-provider';
import { getMRLabel, getMRNumberLabel, getDisplayRepo } from '@plannotator/shared/pr-provider';

/**
 * Format a conventional comment prefix per the Conventional Comments spec:
 * `**label (decorations):** ` — entire label+decorations+colon wrapped in bold.
 * See https://conventionalcomments.org for examples.
 */
export function formatConventionalPrefix(
  label?: ConventionalLabel,
  decorations?: ConventionalDecoration[],
): string {
  if (!label) return '';
  const decs = decorations?.length ? ` (${decorations.join(', ')})` : '';
  return `**${label}${decs}:** `;
}

/**
 * Describes what the reviewer was looking at in local-review mode — diff mode,
 * optional base branch, optional worktree. Threaded into the feedback header so
 * the receiving agent knows which diff the annotations are anchored to. Ignored
 * in PR mode, where `prMeta` already carries equivalent context.
 */
export interface FeedbackDiffContext {
  mode: string;
  base?: string;
  worktreePath?: string | null;
}

function describeDiff(ctx: FeedbackDiffContext): string {
  const { mode, base, worktreePath } = ctx;
  let label: string;
  switch (mode) {
    case "uncommitted":  label = "Uncommitted changes"; break;
    case "staged":       label = "Staged changes"; break;
    case "unstaged":     label = "Unstaged changes"; break;
    case "last-commit":  label = "Last commit"; break;
    case "jj-current":   label = "Current change"; break;
    case "jj-last":      label = "Last change"; break;
    case "jj-line":      label = base ? `Line of work vs \`${base}\`` : "Line of work"; break;
    case "jj-all":       label = "All files"; break;
    case "branch":       label = base ? `Branch diff vs \`${base}\`` : "Branch diff"; break;
    case "merge-base":   label = base ? `Committed changes vs \`${base}\`` : "Committed changes"; break;
    case "all":          label = "All files"; break;
    default:             label = mode; // p4-* or anything else — show raw
  }
  return worktreePath ? `${label} _(worktree: ${worktreePath})_` : label;
}

/**
 * Build markdown feedback from code review annotations.
 *
 * In PR mode (prMeta provided), the header includes repo, PR number,
 * title, branches, and URL so the receiving agent has full context.
 *
 * In local mode, an optional diffContext adds one line describing which
 * diff the reviewer was looking at — otherwise the agent only sees file
 * paths and line numbers and has to guess which diff those anchor to.
 */
function formatFileAnnotations(fileAnnotations: CodeAnnotation[], headingLevel = '###'): string {
  let output = '';

  const sorted = [...fileAnnotations].sort((a, b) => {
    const aScope = a.scope ?? 'line';
    const bScope = b.scope ?? 'line';
    if (aScope !== bScope) {
      return aScope === 'file' ? -1 : 1;
    }
    return a.lineStart - b.lineStart;
  });

  for (const ann of sorted) {
    const scope = ann.scope ?? 'line';
    const prefix = formatConventionalPrefix(ann.conventionalLabel, ann.decorations);

    if (scope === 'file') {
      output += `${headingLevel} File Comment\n`;
      if (ann.text) {
        output += `${prefix}${ann.text}\n`;
      } else if (prefix) {
        output += `${prefix.trimEnd()}\n`;
      }
      if (ann.suggestedCode) {
        output += `\n**Suggested code:**\n\`\`\`\n${ann.suggestedCode}\n\`\`\`\n`;
      }
      output += '\n';
      continue;
    }

    const lineRange = ann.lineStart === ann.lineEnd
      ? `Line ${ann.lineStart}`
      : `Lines ${ann.lineStart}-${ann.lineEnd}`;
    const tokenSuffix = ann.tokenText
      ? ` — \`\`${ann.tokenText.replace(/`/g, '\\`')}\`\`${ann.charStart != null ? ` (chars ${ann.charStart}-${ann.charEnd})` : ''}`
      : '';
    output += `${headingLevel} ${lineRange} (${ann.side})${tokenSuffix}\n`;

    if (ann.text) {
      output += `${prefix}${ann.text}\n`;
    } else if (prefix) {
      output += `${prefix.trimEnd()}\n`;
    }
    if (ann.reasoning) {
      output += `\n**Reasoning:** ${ann.reasoning}\n`;
    }
    if (ann.suggestedCode) {
      output += `\n**Suggested code:**\n\`\`\`\n${ann.suggestedCode}\n\`\`\`\n`;
    }
    output += '\n';
  }

  return output;
}

function groupByFile(annotations: CodeAnnotation[]): Map<string, CodeAnnotation[]> {
  const grouped = new Map<string, CodeAnnotation[]>();
  for (const ann of annotations) {
    const existing = grouped.get(ann.filePath) || [];
    existing.push(ann);
    grouped.set(ann.filePath, existing);
  }
  return grouped;
}

function renderFileGroups(grouped: Map<string, CodeAnnotation[]>, headingLevel: string): string {
  const annotationHeading = headingLevel + '#';
  let output = '';
  for (const [filePath, fileAnnotations] of grouped) {
    output += `${headingLevel} ${filePath}\n\n`;
    output += formatFileAnnotations(fileAnnotations, annotationHeading);
  }
  return output;
}

function scopeDisplayLabel(scope: string): string {
  if (scope === 'layer') return 'Layer';
  if (scope === 'full-stack') return 'Full-stack';
  return scope;
}

function renderScopedGroups(annotations: CodeAnnotation[], headingLevel: string): string {
  const scopes = new Set(annotations.map(a => a.diffScope).filter(Boolean));
  if (scopes.size <= 1) return renderFileGroups(groupByFile(annotations), headingLevel);

  let output = '';
  for (const scope of scopes) {
    const scopeAnns = annotations.filter(a => a.diffScope === scope);
    output += `${headingLevel} ${scopeDisplayLabel(scope)}\n\n`;
    output += renderFileGroups(groupByFile(scopeAnns), headingLevel + '#');
  }
  const unscopedAnns = annotations.filter(a => !a.diffScope);
  if (unscopedAnns.length > 0) {
    output += renderFileGroups(groupByFile(unscopedAnns), headingLevel);
  }
  return output;
}

export function exportReviewFeedback(
  annotations: CodeAnnotation[],
  prMeta?: PRMetadata | null,
  diffContext?: FeedbackDiffContext,
  prReviewScope?: string,
): string {
  if (annotations.length === 0) {
    return '# Code Review\n\nNo feedback provided.';
  }

  const prUrls = new Set(annotations.map(a => a.prUrl).filter(Boolean));
  const isMultiPR = prUrls.size > 1;
  const singlePrUrl = prUrls.size === 1 ? [...prUrls][0] : null;
  const prMismatch = singlePrUrl && prMeta && singlePrUrl !== prMeta.url;

  if (!isMultiPR && !prMismatch) {
    const scopes = new Set(annotations.map(a => a.diffScope).filter(Boolean));
    const derivedScope = scopes.size === 1 ? [...scopes][0] : undefined;
    const scopeLabel = derivedScope ?? (scopes.size === 0 ? prReviewScope : undefined);

    let output = prMeta
      ? `# ${getMRLabel(prMeta)} Review: ${getDisplayRepo(prMeta)}${getMRNumberLabel(prMeta)}\n\n` +
        `**${prMeta.title}**\n` +
        `Branch: \`${prMeta.headBranch}\` → \`${prMeta.baseBranch}\`\n` +
        `${scopeLabel ? `Review scope: ${scopeLabel}\n` : ''}` +
        `${prMeta.url}\n\n`
      : `# Code Review Feedback\n\n${diffContext ? `**Diff:** ${describeDiff(diffContext)}\n\n` : ''}`;

    output += renderScopedGroups(annotations, '##');
    return output;
  }

  // Multi-PR: group by prUrl, then by file within each
  let output = isMultiPR ? '# Multi-PR Review\n\n' : '# Code Review\n\n';

  const byPR = new Map<string, CodeAnnotation[]>();
  for (const ann of annotations) {
    const key = ann.prUrl ?? '_none';
    const existing = byPR.get(key) || [];
    existing.push(ann);
    byPR.set(key, existing);
  }

  for (const [prUrl, prAnnotations] of byPR) {
    const sample = prAnnotations[0];
    if (prUrl === '_none') {
      output += '## Local Changes\n\n';
    } else {
      const repo = sample.prRepo ?? '';
      const num = sample.prNumber != null ? `#${sample.prNumber}` : '';
      const title = sample.prTitle ?? '';
      output += `## ${repo}${num}${title ? ` — ${title}` : ''}\n\n`;
    }

    const scopes = new Set(prAnnotations.map(a => a.diffScope).filter(Boolean));
    if (scopes.size === 1) {
      output += `Review scope: ${[...scopes][0]}\n\n`;
    }

    output += renderScopedGroups(prAnnotations, '###');
  }

  return output;
}
