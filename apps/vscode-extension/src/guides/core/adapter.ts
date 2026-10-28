/**
 * The one seam between the VS Code Guides code and the shared guide-builder
 * pieces in `@plannotator/core` (guide format version 2's `overview`,
 * `guide-builder`, `guide-builder-tools`, `guide-links`). Everything in
 * `src/guides` imports these names from here.
 */

import { isGuideLinkHref } from "@plannotator/core/guide-links";

export {
  createGuideDraft,
  guideDraftProgress,
  guideSaveAsIs,
  parseGuideDraft,
  runGuideBuilderTool,
  serializeGuideDraft,
  type GuideBuilderAnswer,
  type GuideBuilderHooks,
  type GuideDraft,
  type GuideDraftProgress,
  type GuideFocusRange,
  type GuideSymbolResolution,
} from "@plannotator/core/guide-builder";
export {
  GUIDE_BUILDER_TOOLS,
  GUIDE_BUILDER_TOOL_NAMES,
  buildGuideBuilderPrompt,
} from "@plannotator/core/guide-builder-tools";
export { findGuideLinks, isGuideLinkHref, parseGuideLink, type GuideLink } from "@plannotator/core/guide-links";
export type { GuideOverview, GuideOverviewDiagram } from "@plannotator/core/guide";

const CLICK_LINE = /^\s*click\s+([A-Za-z0-9_\-.]+)\s+(?:href\s+)?(?:"([^"]*)"|'([^']*)')/;
const ANY_CLICK_LINE = /^\s*click\s/i;
/** Mermaid directives (`%%{init: …}%%`), which can carry config such as `securityLevel`. */
const DIRECTIVE = /%%\{[\s\S]*?\}%%/g;

/**
 * Mermaid `click` lines as a node id → guide link map, and the source without
 * them: the renderer never sees a click binding, the webview attaches the
 * links to the drawn nodes itself. Every other `click` line (`call …`, a
 * `javascript:` or web href) is dropped, and so are `%%{…}%%` directives, so
 * an agent's diagram cannot ask Mermaid for a looser security level or a
 * different config; the renderer's own `securityLevel: 'strict'` stands.
 */
export function splitMermaidClicks(source: string): { source: string; clicks: Map<string, string> } {
  const clicks = new Map<string, string>();
  const kept: string[] = [];
  for (const line of source.replace(DIRECTIVE, "").split("\n")) {
    const m = CLICK_LINE.exec(line);
    if (m) {
      const href = (m[2] ?? m[3] ?? "").trim();
      if (isGuideLinkHref(href)) clicks.set(m[1], href);
      continue;
    }
    if (ANY_CLICK_LINE.test(line)) continue;
    kept.push(line);
  }
  return { source: kept.join("\n"), clicks };
}
