import type { CodeAnnotation, ConventionalLabel, ConventionalDecoration, CommentAnnotation, Annotation, ArtifactAnnotationMeta } from '@plannotator/ui/types';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import { getMRLabel, getMRNumberLabel, getDisplayRepo } from '@plannotator/shared/pr-types';
import { exportAnnotations, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { artifactAnchorLabel } from './artifactAnnotations';

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
  /** Subject of the active commit when mode is `commit:<sha>` — header readability only. */
  commitSubject?: string;
  /** Exact server snapshot for providers whose line anchors can outlive a refresh. */
  snapshotId?: string;
}

/** The sha when a `commit:<sha>` diff is (or was) the anchor, else undefined.
 *  Shared with App's annotation-stamping context so the stamp and the export
 *  comparison can never parse the mode differently. */
export function commitShaFromMode(mode: string | undefined): string | undefined {
  return mode?.startsWith('commit:') ? mode.slice('commit:'.length) : undefined;
}

function describeDiff(ctx: FeedbackDiffContext): string {
  const { mode, base, worktreePath } = ctx;
  let label: string;
  const commitSha = commitShaFromMode(mode);
  if (commitSha) {
    const subject = ctx.commitSubject ? ` — ${ctx.commitSubject}` : '';
    return `Commit \`${commitSha.slice(0, 7)}\`${subject} (diff vs its parent)${worktreePath ? ` _(worktree: ${worktreePath})_` : ''}`;
  }
  if (mode === 'gitbutler:workspace') {
    label = 'GitButler workspace (all applied changes)';
    return worktreePath ? `${label} _(worktree: ${worktreePath})_` : label;
  }
  for (const [prefix, kind] of [
    ['gitbutler:stack:', 'stack'],
    ['gitbutler:branch:', 'branch'],
  ] as const) {
    if (!mode.startsWith(prefix)) continue;
    let target = mode.slice(prefix.length);
    try { target = decodeURIComponent(target); } catch { /* keep encoded fallback */ }
    label = `GitButler ${kind} \`${target}\` (committed changes)`;
    return worktreePath ? `${label} _(worktree: ${worktreePath})_` : label;
  }
  switch (mode) {
    case "uncommitted":  label = "Uncommitted changes"; break;
    case "staged":       label = "Staged changes"; break;
    case "unstaged":     label = "Unstaged changes"; break;
    case "last-commit":  label = "Last commit"; break;
    case "workspace-current":  label = "Workspace current changes"; break;
    case "workspace-staged":   label = "Workspace staged changes"; break;
    case "workspace-unstaged": label = "Workspace unstaged changes"; break;
    case "workspace-last":     label = "Workspace last change"; break;
    case "jj-current":   label = "Current change"; break;
    case "jj-last":      label = "Last change"; break;
    case "jj-line":      label = base ? `Line of work vs \`${base}\`` : "Line of work"; break;
    case "jj-all":       label = "All files"; break;
    case "since-base":   label = base ? `All changes since \`${base}\` (committed + uncommitted + untracked)` : "All changes since base (committed + uncommitted + untracked)"; break;
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
/**
 * Anchor-mismatch note: an annotation made on a commit:<sha> diff carries
 * line numbers from THAT commit's diff-vs-parent — exporting it under any
 * other diff header (or vice versa) without saying so would silently point
 * the agent at the wrong code. Empty when the anchor matches the header.
 */
function commitMismatchNote(ann: CodeAnnotation, currentCommitSha?: string): string {
  if (ann.commitSha && ann.commitSha !== currentCommitSha) {
    const subject = ann.commitSubject ? ` ("${ann.commitSubject}")` : '';
    return `_Made on commit \`${ann.commitSha.slice(0, 7)}\`${subject} — anchored to that commit's diff, not the diff above._\n`;
  }
  if (!ann.commitSha && currentCommitSha) {
    return `_Made on a working-tree diff, not commit \`${currentCommitSha.slice(0, 7)}\` — anchored there._\n`;
  }
  return '';
}

function gitButlerMismatchNote(ann: CodeAnnotation, current?: FeedbackDiffContext): string {
  if (!ann.gitButlerDiffType) return '';
  const sameSnapshot = !ann.gitButlerSnapshotId || ann.gitButlerSnapshotId === current?.snapshotId;
  if (ann.gitButlerDiffType === current?.mode && ann.gitButlerBase === current.base && sameSnapshot) return '';
  const source = ann.gitButlerDiffLabel ?? describeDiff({
    mode: ann.gitButlerDiffType,
    base: ann.gitButlerBase,
  });
  return `_Made on ${source} — anchored to that GitButler diff, not the diff above._\n`;
}

function formatFileAnnotations(fileAnnotations: CodeAnnotation[], headingLevel = '###', currentDiff?: FeedbackDiffContext): string {
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
      output += commitMismatchNote(ann, commitShaFromMode(currentDiff?.mode));
      output += gitButlerMismatchNote(ann, currentDiff);
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
    output += commitMismatchNote(ann, commitShaFromMode(currentDiff?.mode));
    output += gitButlerMismatchNote(ann, currentDiff);

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

function renderGeneralComments(annotations: CodeAnnotation[]): string {
  let output = '## General\n\n';
  for (const ann of annotations) {
    const prefix = formatConventionalPrefix(ann.conventionalLabel, ann.decorations);
    if (ann.text) {
      output += `${prefix}${ann.text}\n`;
    } else if (prefix) {
      output += `${prefix.trimEnd()}\n`;
    }
    if (ann.reasoning) {
      output += `\n**Reasoning:** ${ann.reasoning}\n`;
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

function renderFileGroups(grouped: Map<string, CodeAnnotation[]>, headingLevel: string, currentDiff?: FeedbackDiffContext): string {
  const annotationHeading = headingLevel + '#';
  let output = '';
  for (const [filePath, fileAnnotations] of grouped) {
    output += `${headingLevel} ${filePath}\n\n`;
    output += formatFileAnnotations(fileAnnotations, annotationHeading, currentDiff);
  }
  return output;
}

function scopeDisplayLabel(scope: string): string {
  if (scope === 'layer') return 'Layer';
  if (scope === 'full-stack') return 'Full-stack';
  return scope;
}

function renderScopedGroups(annotations: CodeAnnotation[], headingLevel: string, currentDiff?: FeedbackDiffContext): string {
  const scopes = new Set(annotations.map(a => a.diffScope).filter(Boolean));
  if (scopes.size <= 1) return renderFileGroups(groupByFile(annotations), headingLevel, currentDiff);

  let output = '';
  for (const scope of scopes) {
    const scopeAnns = annotations.filter(a => a.diffScope === scope);
    output += `${headingLevel} ${scopeDisplayLabel(scope)}\n\n`;
    output += renderFileGroups(groupByFile(scopeAnns), headingLevel + '#', currentDiff);
  }
  const unscopedAnns = annotations.filter(a => !a.diffScope);
  if (unscopedAnns.length > 0) {
    output += renderFileGroups(groupByFile(unscopedAnns), headingLevel, currentDiff);
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

  // General (review-level) comments belong to no file — render them in their own
  // section and group only the rest by file.
  const general = annotations.filter(a => (a.scope ?? 'line') === 'general');
  const placed = annotations.filter(a => (a.scope ?? 'line') !== 'general');
  const generalSection = general.length > 0 ? renderGeneralComments(general) : '';

  const prUrls = new Set(placed.map(a => a.prUrl).filter(Boolean));
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

    output += renderScopedGroups(placed, '##', diffContext);
    output += generalSection;
    return output;
  }

  // Multi-PR: group by prUrl, then by file within each
  let output = isMultiPR ? '# Multi-PR Review\n\n' : '# Code Review\n\n';

  const byPR = new Map<string, CodeAnnotation[]>();
  for (const ann of placed) {
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

  output += generalSection;
  return output;
}

/**
 * The prose-annotation feedback block (PR description notes + PR comment notes),
 * joined. Shared by the agent feedback (feedbackMarkdown) and the GitHub review
 * body seed, so the two never drift. Returns '' when there are no prose notes.
 */
export function buildProseFeedback(
  descriptionAnnotations: Annotation[],
  commentAnnotations: CommentAnnotation[],
  descriptionBody: string | undefined,
): string {
  const parts: string[] = [];
  const regularDescription = descriptionAnnotations.filter((annotation) => !annotation.artifact);
  const regularComments = commentAnnotations.filter((annotation) => !annotation.artifact);
  const artifactDescription = descriptionAnnotations.filter(
    (annotation): annotation is Annotation & { artifact: ArtifactAnnotationMeta } => !!annotation.artifact,
  );
  const artifactComments = commentAnnotations.filter(
    (annotation): annotation is CommentAnnotation & { artifact: ArtifactAnnotationMeta } => !!annotation.artifact,
  );

  if (regularDescription.length > 0 && descriptionBody) {
    parts.push(exportAnnotations(
      parseMarkdownToBlocks(descriptionBody),
      regularDescription,
      [],
      'PR Description Feedback',
      'PR description',
    ));
  }
  if (regularComments.length > 0) {
    parts.push(exportCommentAnnotations(regularComments));
  }
  if (artifactDescription.length > 0 || artifactComments.length > 0) {
    parts.push(exportArtifactAnnotations(artifactDescription, artifactComments));
  }
  return parts.join('\n\n');
}

/**
 * Format feedback from PR comment annotations. Unlike code (the agent can read
 * the repo) a PR comment is invisible to the agent, so the full comment body is
 * quoted inline alongside the reviewer's note.
 */
export function exportCommentAnnotations(annotations: CommentAnnotation[]): string {
  if (annotations.length === 0) return '';
  let output = '# PR Comment Feedback\n\n';
  for (const ann of annotations) {
    output += `## Comment by @${ann.commentAuthor}\n\n`;
    if (ann.commentBody.trim()) {
      const quoted = ann.commentBody.trim().split('\n').map(line => `> ${line}`).join('\n');
      output += `${quoted}\n\n`;
    }
    output += `${ann.text}\n\n`;
  }
  return output.trimEnd() + '\n';
}

function quoteMarkdown(markdown: string): string {
  return markdown.trim().split('\n').map((line) => `> ${line}`).join('\n');
}

function safeHeading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim() || 'Artifact';
}

function artifactFeedbackEntry(
  meta: ArtifactAnnotationMeta,
  note: string,
  source: { kind: 'description' } | { kind: 'comment'; author: string; body: string },
): string {
  let output = `## ${safeHeading(meta.artifactName)} — ${artifactAnchorLabel(meta.anchor)}\n\n`;
  output += `[Open artifact](<${meta.artifactUrl}>) · [View source](<${meta.sourceUrl}>)\n\n`;
  if (source.kind === 'comment') {
    output += `In reply to the artifact source comment by @${source.author}:\n\n`;
    if (source.body.trim()) output += `${quoteMarkdown(source.body)}\n\n`;
  } else {
    output += 'Regarding an artifact in the PR description.\n\n';
  }
  if (meta.anchor.kind === 'document' && meta.anchor.originalText) {
    output += `${quoteMarkdown(meta.anchor.originalText)}\n\n`;
  }
  output += `${note.trim()}\n`;
  return output;
}

/** Artifact notes share this block for local-agent delivery and GitHub reviews. */
export function exportArtifactAnnotations(
  descriptionAnnotations: Array<Annotation & { artifact: ArtifactAnnotationMeta }>,
  commentAnnotations: Array<CommentAnnotation & { artifact: ArtifactAnnotationMeta }>,
): string {
  if (descriptionAnnotations.length === 0 && commentAnnotations.length === 0) return '';
  let output = '# PR Artifact Feedback\n\n';
  for (const annotation of descriptionAnnotations) {
    output += `${artifactFeedbackEntry(annotation.artifact, annotation.text ?? '', { kind: 'description' })}\n`;
  }
  for (const annotation of commentAnnotations) {
    output += `${artifactFeedbackEntry(annotation.artifact, annotation.text, {
      kind: 'comment',
      author: annotation.commentAuthor,
      body: annotation.commentBody,
    })}\n`;
  }
  return output.trimEnd() + '\n';
}
