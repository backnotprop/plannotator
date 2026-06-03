import { extractCandidateCodePathMentions } from "@plannotator/shared/extract-code-paths";
import { parseCodePath } from "@plannotator/shared/code-file";
import type { Block } from "../types";

export type PlanContextStatus = "mentioned" | "modified" | "created" | "deleted";

export interface PlanContextFile {
  path: string;
  resolvedPath?: string;
  status: PlanContextStatus;
  mentionCount: number;
  firstBlockId: string;
  sectionTitle?: string;
  validationStatus?: "found" | "ambiguous" | "missing" | "unavailable";
}

interface HeadingFrame {
  level: number;
  title: string;
  status: Exclude<PlanContextStatus, "mentioned"> | null;
}

interface MutablePlanContextFile {
  path: string;
  explicitStatuses: Set<Exclude<PlanContextStatus, "mentioned">>;
  mentionCount: number;
  firstBlockId: string;
  firstOrder: number;
  sectionTitle?: string;
}

const BLOCK_TYPES_WITH_PATH_MENTIONS = new Set<Block["type"]>([
  "paragraph",
  "heading",
  "blockquote",
  "list-item",
  "table",
  "html",
  "directive",
]);

export function inferPlanContextStatusFromHeading(
  heading: string
): Exclude<PlanContextStatus, "mentioned"> | null {
  const normalized = heading
    .toLowerCase()
    .replace(/[`*_#[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/(^|\b)(modified|updated|changed)\s+files?\b/.test(normalized)) {
    return "modified";
  }
  if (/\bfiles?\s+(to\s+)?(modify|update|change)\b/.test(normalized)) {
    return "modified";
  }
  if (/(^|\b)(created|new|added)\s+files?\b/.test(normalized)) {
    return "created";
  }
  if (/\bfiles?\s+(to\s+)?(create|add)\b/.test(normalized)) {
    return "created";
  }
  if (/(^|\b)(deleted|removed)\s+files?\b/.test(normalized)) {
    return "deleted";
  }
  if (/\bfiles?\s+(to\s+)?(delete|remove)\b/.test(normalized)) {
    return "deleted";
  }

  return null;
}

export function extractPlanContextFiles(blocks: Block[]): PlanContextFile[] {
  const byPath = new Map<string, MutablePlanContextFile>();
  let headingStack: HeadingFrame[] = [];

  for (const block of [...blocks].sort((a, b) => a.order - b.order)) {
    if (block.type === "heading") {
      const level = block.level ?? 1;
      headingStack = headingStack.filter((heading) => heading.level < level);
      headingStack.push({
        level,
        title: block.content,
        status: inferPlanContextStatusFromHeading(block.content),
      });
    }

    if (!BLOCK_TYPES_WITH_PATH_MENTIONS.has(block.type)) continue;

    const mentions = extractCandidateCodePathMentions(block.content);
    if (mentions.length === 0) continue;

    const explicitStatus = [...headingStack].reverse().find((heading) => heading.status)?.status ?? null;
    const sectionTitle = [...headingStack].reverse().find((heading) => heading.title)?.title;

    for (const mention of mentions) {
      const path = parseCodePath(mention).filePath;
      const existing = byPath.get(path);
      if (existing) {
        existing.mentionCount += 1;
        if (explicitStatus) existing.explicitStatuses.add(explicitStatus);
        continue;
      }

      byPath.set(path, {
        path,
        explicitStatuses: explicitStatus ? new Set([explicitStatus]) : new Set(),
        mentionCount: 1,
        firstBlockId: block.id,
        firstOrder: block.order,
        sectionTitle,
      });
    }
  }

  return [...byPath.values()]
    .sort((a, b) => a.firstOrder - b.firstOrder || a.path.localeCompare(b.path))
    .map((entry) => {
      const explicitStatuses = [...entry.explicitStatuses];
      const status: PlanContextStatus =
        explicitStatuses.length === 1 ? explicitStatuses[0] : "mentioned";

      return {
        path: entry.path,
        status,
        mentionCount: entry.mentionCount,
        firstBlockId: entry.firstBlockId,
        sectionTitle: entry.sectionTitle,
      };
    });
}
