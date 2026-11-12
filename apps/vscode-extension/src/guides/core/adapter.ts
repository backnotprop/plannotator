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
const DIRECTIVE = /%%\{[\s\S]*?\}%%/g;

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
