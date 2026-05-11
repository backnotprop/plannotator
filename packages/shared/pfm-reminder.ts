/**
 * Plannotator planning reminders.
 *
 * Static prose injected into the EnterPlanMode PreToolUse hook when the user
 * has opted in through ~/.plannotator/config.json. These reminders tell the
 * planning agent how to shape plans for Plannotator review.
 *
 * Keep this short. The agent reads it on every EnterPlanMode call.
 */

/**
 * Compose the additionalContext string for the improve-context PreToolUse handler.
 * Returns null when no sources are enabled (handler should exit silently).
 *
 * Order: PFM reminder first (capabilities), ASCII flow reminder second
 * (structure), then improvement hook (corrective rules). Sections appear
 * separated by a horizontal rule.
 */
export function composeImproveContext(input: {
  pfmEnabled: boolean;
  asciiFlowEnabled: boolean;
  improvementHookContent: string | null;
}): string | null {
  const sections: string[] = [];

  if (input.pfmEnabled) {
    sections.push(PFM_REMINDER);
  }

  if (input.asciiFlowEnabled) {
    sections.push(ASCII_FLOW_REMINDER);
  }

  if (input.improvementHookContent) {
    sections.push([
      "[Plannotator Improvement Hook]",
      "The following corrective instructions were generated from analysis of previous plan denial patterns.",
      "Apply these guidelines when writing your plan:\n",
      input.improvementHookContent,
    ].join("\n"));
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n---\n\n");
}

export const PFM_REMINDER = `[Plannotator Flavored Markdown]
This plan will be reviewed in Plannotator, which renders GitHub Flavored Markdown plus the extensions below. Use these features when they make the plan clearer for the reviewer — don't force them in for their own sake.

Code-file links (highest leverage)
Reference real source files inline. Plannotator validates the path and renders a clickable badge that opens the file in the reviewer's editor — prefer this over pasting code when you just need to point at something.
  \`packages/server/index.ts\`            backticked path
  \`packages/server/index.ts:42\`         path with line number
  \`packages/server/index.ts:10-20\`      line range — hover shows a code snippet preview
  [the handler](packages/server/index.ts:42)  markdown link form
Ambiguous paths (e.g. \`index.ts\`) still render and open a picker.

Callouts and alerts
GitHub-style alerts highlight critical context:
  > [!NOTE]      general callout
  > [!TIP]       suggestion
  > [!WARNING]   watch out
  > [!CAUTION]   risk
  > [!IMPORTANT] must-read
Or use directive containers for richer blocks:
  :::tip
  Body with **inline markdown**.
  :::

Tables
Pipe tables are interactive — the reviewer can copy as Markdown/CSV from a hover toolbar, or expand to a sortable, filterable popout. Reach for them for comparisons, files-to-change lists, or risk summaries.

Task lists
Use \`- [ ]\` and \`- [x]\` for actionable steps the reviewer (or a follow-up agent) can tick off.

Diagrams
Code fences with \`mermaid\` or \`graphviz\` render as live diagrams. Useful for flow, state, sequence, or architecture sketches.

Other extras
  - Wiki-links: [[architecture]] auto-resolves to .md docs in the workspace
  - Hex color swatches: #1a2bcc renders as a small color chip
  - @username and #123 link to GitHub when a repo is detected
  - A small set of emoji shortcodes is supported (:rocket:, :warning:, :white_check_mark:, ...)

Plain prose is always fine. The point is: prefer code-file links over copy-pasted snippets, and reach for callouts or tables when structure makes the plan easier to scan.`;

export const ASCII_FLOW_REMINDER = `[ASCII Plan Flow]
This plan will be reviewed by a human before implementation. Add a compact \`## Plan Flow\` section after Summary/Context and before implementation details so the reviewer can quickly judge whether the order, branches, and review gates make sense.

Use a fenced \`text\` code block with pure ASCII only:
\`\`\`text
[Explore] -> [Draft plan] -> [Review]
                   |             |
                   v             v
              [Revise] <---- [Feedback]
\`\`\`

Rules:
- Use pure ASCII characters only. Do not use Unicode box drawing.
- Do not use Mermaid, Graphviz, or SVG for this section.
- Show the main execution order, important branches, review gates, rollback/feedback loops, and parallel work where relevant.
- Keep it compact: roughly 5-12 nodes, short concrete labels, and no decorative art.
- For very small plans, keep the flow to the minimum useful shape.`;
