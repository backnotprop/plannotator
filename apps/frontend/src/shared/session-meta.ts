import {
  Code2,
  FileText,
  ListChecks,
  ScrollText,
  Target,
  Archive,
  type LucideIcon,
} from "lucide-react";
import type { SessionMode } from "../daemon/contracts";

export interface SessionModeMeta {
  icon: LucideIcon;
  label: string;
}

const MODE_META: Record<string, SessionModeMeta> = {
  plan: { icon: ScrollText, label: "Plan" },
  review: { icon: Code2, label: "Review" },
  annotate: { icon: FileText, label: "Annotate" },
  archive: { icon: Archive, label: "Archive" },
  "goal-setup": { icon: Target, label: "Goal Setup" },
};

const FALLBACK: SessionModeMeta = { icon: ListChecks, label: "Session" };

export function getSessionModeMeta(mode: SessionMode): SessionModeMeta {
  return MODE_META[mode] ?? FALLBACK;
}

const ORIGINS = /^(claude-code|opencode|pi|plannotator-frontend|codex|copilot-cli|gemini-cli)-/;

export function formatSessionLabel(label: string, mode: SessionMode): string {
  // PR/MR review: "plugin-pr-review-owner/repo#123" → "PR #123"
  const prMatch = label.match(/^plugin-(?:pr|mr)-review-.+?(#\d+|!\d+)$/);
  if (prMatch) return `${label.includes("-mr-") ? "MR" : "PR"} ${prMatch[1]}`;

  // Local review: "plugin-review-{origin}-{project}-{branch}" → "project (branch)"
  if (mode === "review") {
    const stripped = label.replace(/^plugin-review-/, "").replace(ORIGINS, "");
    const lastDash = stripped.lastIndexOf("-");
    if (lastDash > 0) {
      return `${stripped.slice(0, lastDash)} (${stripped.slice(lastDash + 1)})`;
    }
    return stripped;
  }

  // Plan: "plugin-plan-{origin}-{project}-{branch}" → "project (branch)"
  if (mode === "plan") {
    const stripped = label.replace(/^plugin-plan-/, "").replace(ORIGINS, "");
    const lastDash = stripped.lastIndexOf("-");
    if (lastDash > 0) {
      return `${stripped.slice(0, lastDash)} (${stripped.slice(lastDash + 1)})`;
    }
    return stripped;
  }

  // Annotate: "plugin-annotate-{origin}-{file}-{branch}" → "file (branch)"
  if (mode === "annotate") {
    const stripped = label.replace(/^plugin-annotate-/, "").replace(ORIGINS, "");
    const lastDash = stripped.lastIndexOf("-");
    if (lastDash > 0) {
      return `${stripped.slice(0, lastDash)} (${stripped.slice(lastDash + 1)})`;
    }
    return stripped;
  }

  // Archive: "plugin-archive-{origin}-{project}-{branch}" → "project (branch)"
  if (mode === "archive") {
    const stripped = label.replace(/^plugin-archive-/, "").replace(ORIGINS, "");
    const lastDash = stripped.lastIndexOf("-");
    if (lastDash > 0) {
      return `${stripped.slice(0, lastDash)} (${stripped.slice(lastDash + 1)})`;
    }
    return stripped;
  }

  // Goal setup: "goal-setup-{stage}-{slug}-{branch}" → "slug (branch)"
  if (mode === "goal-setup") {
    const stripped = label.replace(/^goal-setup-(interview|facts)-/, "");
    const lastDash = stripped.lastIndexOf("-");
    if (lastDash > 0) {
      return `${stripped.slice(0, lastDash)} (${stripped.slice(lastDash + 1)})`;
    }
    return stripped;
  }

  return label;
}
