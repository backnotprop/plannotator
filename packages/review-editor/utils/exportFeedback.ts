import type { CodeAnnotation } from '@plannotator/ui/types';
import type { PRMetadata } from '@plannotator/shared/pr-provider';
import { getMRLabel, getMRNumberLabel, getDisplayRepo } from '@plannotator/shared/pr-provider';

/**
 * Build markdown feedback from code review annotations.
 *
 * In PR mode (prMeta provided), the header includes repo, PR number,
 * title, branches, and URL so the receiving agent has full context.
 */
export function exportReviewFeedback(
  annotations: CodeAnnotation[],
  prMeta?: PRMetadata | null,
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
    : '# Code Review Feedback\n\n';

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

      if (scope === 'file') {
        output += `### File Comment\n`;

        if (ann.text) {
          output += `${ann.text}\n`;
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

      output += `### ${lineRange} (${ann.side})\n`;

      if (ann.text) {
        output += `${ann.text}\n`;
      }

      if (ann.suggestedCode) {
        output += `\n**Suggested code:**\n\`\`\`\n${ann.suggestedCode}\n\`\`\`\n`;
      }

      output += '\n';
    }
  }

  return output;
}
