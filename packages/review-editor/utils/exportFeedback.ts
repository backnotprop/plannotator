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
    case "branch":       label = base ? `Branch diff vs \`${base}\`` : "Branch diff"; break;
    case "merge-base":   label = base ? `PR Diff vs \`${base}\`` : "PR Diff"; break;
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
export function exportReviewFeedback(
  annotations: CodeAnnotation[],
  prMeta?: PRMetadata | null,
  diffContext?: FeedbackDiffContext,
): string {
  if (annotations.length === 0) {
    return '# Code Review\n\nNo feedback provided.';
  }

  const grouped = new Map<string, CodeAnnotation[]>();
  for (const ann of annotations) {
    const existing = grouped.get(ann.filePath) || [];
    existing.push(ann);
    grouped.set(ann.filePath, existing);
  }

  let output = prMeta
    ? `# ${getMRLabel(prMeta)} Review: ${getDisplayRepo(prMeta)}${getMRNumberLabel(prMeta)}\n\n` +
      `**${prMeta.title}**\n` +
      `Branch: \`${prMeta.headBranch}\` → \`${prMeta.baseBranch}\`\n` +
      `${prMeta.url}\n\n`
    : `# Code Review Feedback\n\n${diffContext ? `**Diff:** ${describeDiff(diffContext)}\n\n` : ''}`;

  for (const [filePath, fileAnnotations] of grouped) {
    output += `## ${filePath}\n\n`;

    const sorted = [...fileAnnotations].sort((a, b) => {
      const aScope = a.scope ?? 'line';
      const bScope = b.scope ?? 'line';
      if (aScope !== bScope) {
        return aScope === 'file' ? -1 : 1;
      }
      return a.lineStart - b.lineStart;
    });

    for (let i = 0; i < sorted.length; i++) {
      const ann = sorted[i];
      const scope = ann.scope ?? 'line';

      const prefix = formatConventionalPrefix(ann.conventionalLabel, ann.decorations);

      if (scope === 'file') {
        output += `### File Comment\n`;

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
      output += `### ${lineRange} (${ann.side})${tokenSuffix}\n`;

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
  }

  return output;
}
