import { join, resolve, sep } from "path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "fs";
import { sanitizeTag } from "./project";
import { resolveUserPath } from "./resolve-file";
import { getPlannotatorDataDir } from "./data-dir";

export function getPlanDir(customPath?: string | null): string {
  let planDir: string;

  if (customPath?.trim()) {
    planDir = resolveUserPath(customPath);
  } else {
    planDir = join(getPlannotatorDataDir(), "plans");
  }

  mkdirSync(planDir, { recursive: true });
  return planDir;
}

function extractFirstHeading(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (!match) return null;
  return match[1].trim();
}

export function generateSlug(plan: string): string {
  const date = new Date().toISOString().split("T")[0];

  const heading = extractFirstHeading(plan);
  const slug = heading ? sanitizeTag(heading) : null;

  return slug ? `${slug}-${date}` : `plan-${date}`;
}

export function savePlan(slug: string, content: string, customPath?: string | null): string {
  const planDir = getPlanDir(customPath);
  const filePath = join(planDir, `${slug}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function saveAnnotations(slug: string, annotationsContent: string, customPath?: string | null): string {
  const planDir = getPlanDir(customPath);
  const filePath = join(planDir, `${slug}.annotations.md`);
  writeFileSync(filePath, annotationsContent, "utf-8");
  return filePath;
}

export function saveFinalSnapshot(
  slug: string,
  status: "approved" | "denied",
  plan: string,
  annotations: string,
  customPath?: string | null
): string {
  const planDir = getPlanDir(customPath);
  const filePath = join(planDir, `${slug}-${status}.md`);

  let content = plan;
  if (annotations && annotations !== "No changes detected.") {
    content += "\n\n---\n\n" + annotations;
  }

  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

import type { ArchivedPlan } from '@plannotator/core/storage-types';
export type { ArchivedPlan };

export function parseArchiveFilename(filename: string): ArchivedPlan | null {
  if (filename.endsWith(".annotations.md") || filename.endsWith(".diff.md")) return null;

  const base = filename.replace(/\.md$/, "");

  let status: ArchivedPlan["status"] = "unknown";
  let slug = base;
  if (base.endsWith("-approved")) {
    status = "approved";
    slug = base.slice(0, -"-approved".length);
  } else if (base.endsWith("-denied")) {
    status = "denied";
    slug = base.slice(0, -"-denied".length);
  } else {
    return null;
  }

  const dateMatch = slug.match(/(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : "";

  const title = slug
    .replace(/\d{4}-\d{2}-\d{2}/, "")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, " ")
    .trim() || "Untitled Plan";

  return { filename, title, date, timestamp: "", status, size: 0 };
}

export function listArchivedPlans(customPath?: string | null): ArchivedPlan[] {
  const planDir = getPlanDir(customPath);
  try {
    const entries = readdirSync(planDir);
    const plans: ArchivedPlan[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const parsed = parseArchiveFilename(entry);
      if (!parsed) continue;
      try {
        const stat = statSync(join(planDir, entry));
        parsed.size = stat.size;
        parsed.timestamp = stat.mtime.toISOString();
      } catch { }
      plans.push(parsed);
    }
    return plans.sort((a, b) => b.date.localeCompare(a.date) || b.timestamp.localeCompare(a.timestamp));
  } catch {
    return [];
  }
}

export function readArchivedPlan(filename: string, customPath?: string | null): string | null {
  const planDir = getPlanDir(customPath);
  const filePath = resolve(planDir, filename);
  if (!filePath.startsWith(planDir + sep)) return null;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function getHistoryDir(project: string, slug: string): string {
  const historyDir = join(getPlannotatorDataDir(), "history", project, slug);
  mkdirSync(historyDir, { recursive: true });
  return historyDir;
}

function getNextVersionNumber(historyDir: string): number {
  try {
    const entries = readdirSync(historyDir);
    let max = 0;
    for (const entry of entries) {
      const match = entry.match(/^(\d+)\.md$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
    return max + 1;
  } catch {
    return 1;
  }
}

export function saveToHistory(
  project: string,
  slug: string,
  plan: string
): { version: number; path: string; isNew: boolean } {
  const historyDir = getHistoryDir(project, slug);
  const nextVersion = getNextVersionNumber(historyDir);

  if (nextVersion > 1) {
    const latestPath = join(historyDir, `${String(nextVersion - 1).padStart(3, "0")}.md`);
    try {
      const existing = readFileSync(latestPath, "utf-8");
      if (existing === plan) {
        return { version: nextVersion - 1, path: latestPath, isNew: false };
      }
    } catch {
    }
  }

  const fileName = `${String(nextVersion).padStart(3, "0")}.md`;
  const filePath = join(historyDir, fileName);
  writeFileSync(filePath, plan, "utf-8");
  return { version: nextVersion, path: filePath, isNew: true };
}

export function saveAnnotateSubmission(project: string, slug: string, content: string): string {
  const submissionsDir = join(getHistoryDir(project, slug), "submissions");
  mkdirSync(submissionsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let filePath = join(submissionsDir, `${stamp}.md`);
  for (let n = 2; existsSync(filePath); n++) {
    filePath = join(submissionsDir, `${stamp}-${n}.md`);
  }
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function getPlanVersion(
  project: string,
  slug: string,
  version: number
): string | null {
  const historyDir = join(getPlannotatorDataDir(), "history", project, slug);
  const fileName = `${String(version).padStart(3, "0")}.md`;
  const filePath = join(historyDir, fileName);

  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function getPlanVersionPath(
  project: string,
  slug: string,
  version: number
): string | null {
  const historyDir = join(getPlannotatorDataDir(), "history", project, slug);
  const fileName = `${String(version).padStart(3, "0")}.md`;
  const filePath = join(historyDir, fileName);
  return existsSync(filePath) ? filePath : null;
}

export function getVersionCount(project: string, slug: string): number {
  const historyDir = join(getPlannotatorDataDir(), "history", project, slug);
  try {
    const entries = readdirSync(historyDir);
    return entries.filter((e) => /^\d+\.md$/.test(e)).length;
  } catch {
    return 0;
  }
}

export function listVersions(
  project: string,
  slug: string
): Array<{ version: number; timestamp: string }> {
  const historyDir = join(getPlannotatorDataDir(), "history", project, slug);
  try {
    const entries = readdirSync(historyDir);
    const versions: Array<{ version: number; timestamp: string }> = [];
    for (const entry of entries) {
      const match = entry.match(/^(\d+)\.md$/);
      if (match) {
        const version = parseInt(match[1], 10);
        const filePath = join(historyDir, entry);
        try {
          const stat = statSync(filePath);
          versions.push({ version, timestamp: stat.mtime.toISOString() });
        } catch {
          versions.push({ version, timestamp: "" });
        }
      }
    }
    return versions.sort((a, b) => a.version - b.version);
  } catch {
    return [];
  }
}

export function listProjectPlans(
  project: string
): Array<{ slug: string; versions: number; lastModified: string }> {
  const projectDir = join(getPlannotatorDataDir(), "history", project);
  try {
    const entries = readdirSync(projectDir, { withFileTypes: true });
    const plans: Array<{ slug: string; versions: number; lastModified: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slugDir = join(projectDir, entry.name);
      const files = readdirSync(slugDir).filter((f) => /^\d+\.md$/.test(f));
      if (files.length === 0) continue;

      let latest = 0;
      for (const file of files) {
        try {
          const mtime = statSync(join(slugDir, file)).mtime.getTime();
          if (mtime > latest) latest = mtime;
        } catch { }
      }

      plans.push({
        slug: entry.name,
        versions: files.length,
        lastModified: latest ? new Date(latest).toISOString() : "",
      });
    }
    return plans.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  } catch {
    return [];
  }
}

export const PLAN_HISTORY_CONTINUE_WINDOW_MS = 48 * 60 * 60 * 1000;

const HISTORY_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveHistorySlug(
  project: string,
  datedSlug: string,
  options: { now?: Date; current?: string } = {},
): string {
  const dateSuffix = datedSlug.match(/-(\d{4}-\d{2}-\d{2})$/);
  if (!dateSuffix) return datedSlug;

  const startedOn = dateSuffix[1];
  const base = datedSlug.slice(0, -dateSuffix[0].length);
  const chainDate = (slug: string): string | null => {
    if (!slug.startsWith(`${base}-`)) return null;
    const date = slug.slice(base.length + 1);
    return HISTORY_DATE.test(date) ? date : null;
  };

  if (options.current && chainDate(options.current) !== null) return options.current;

  const now = (options.now ?? new Date()).getTime();
  let best: { slug: string; date: string; mtime: number } | null = null;
  for (const plan of listProjectPlans(project)) {
    if (plan.slug === datedSlug) return datedSlug;
    const date = chainDate(plan.slug);
    if (date === null || date > startedOn) continue;
    const mtime = plan.lastModified ? Date.parse(plan.lastModified) : 0;
    if (!best || mtime > best.mtime || (mtime === best.mtime && date > best.date)) {
      best = { slug: plan.slug, date, mtime };
    }
  }

  if (best && best.mtime > 0 && now - best.mtime <= PLAN_HISTORY_CONTINUE_WINDOW_MS) return best.slug;
  return datedSlug;
}

export function resolveHistoryChain(
  projects: readonly string[],
  datedSlug: string,
  options: { now?: Date; current?: string } = {},
): { project: string; slug: string } {
  const candidates = [...new Set(projects.filter((project) => project))];
  const home = candidates[0] ?? "_unknown";
  for (const project of candidates) {
    const slug = resolveHistorySlug(project, datedSlug, options);
    if (getVersionCount(project, slug) > 0) return { project, slug };
  }
  return { project: home, slug: resolveHistorySlug(home, datedSlug, options) };
}
