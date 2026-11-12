import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { loadConfig, resolveGuideHistory } from "@plannotator/shared/config";
import {
  deleteGuide,
  isValidGuideId,
  listGuides,
  loadGuide,
  loadGuidePatch,
  makeGuideId,
  saveGuide,
  saveGuidePatch,
  updateGuideReviewed,
  type SavedGuideEnvelope,
} from "@plannotator/shared/guide-store";
import { buildGuideSnapshot, type GuideSnapshot, type GuideSnapshotSource } from "@plannotator/core/guide-format";
import { guideDraftProgress, parseGuideDraft, type GuideDraft, type GuideFocusRange } from "./core/adapter";
import { deleteGuideAnswers } from "./ask/answers";

export interface ReviewSourceRecord {
  kind: "local" | "pr";
  repoRoot: string;
  headRoot: string;
  repoName: string;
  label: string;
  branch?: string;
  headSha: string;
  baseSha: string;
  baseLabel: string;
  workingTree?: boolean;
  pr?: { number: number; url: string; title: string; author?: string };
  worktreePath?: string;
}

export interface AgentChoiceRecord {
  id: string;
  label: string;
  model?: { id: string; label: string };
  effort?: { id: string; label: string };
}

export interface DraftRecord {
  v: 1;
  id: string;
  repoKey: string;
  createdAt: number;
  updatedAt: number;
  status: "running" | "stopped" | "failed" | "finished";
  statusMessage?: string;
  source: ReviewSourceRecord;
  agent: AgentChoiceRecord;
  instructions?: string;
  draft: GuideDraft;
  acpSessionId?: string;
  cost?: { amount: number; currency: string };
  savedGuideId?: string;
}

export interface GuideSidecar {
  v: 1;
  fileTicks: string[];
  focus: Record<string, readonly GuideFocusRange[]>;
  source?: ReviewSourceRecord;
  agent?: AgentChoiceRecord;
  acpSessionId?: string;
  askSession?: { id: string; agent: string };
  cost?: { amount: number; currency: string };
  diagramCheck?: "ok" | "unchecked" | "failed";
}

export function guideHistoryEnabled(): boolean {
  return resolveGuideHistory(loadConfig());
}

function guidesDir(repoKey: string): string {
  return join(getPlannotatorDataDir(), "guides", repoKey);
}

function vscodeDir(repoKey: string): string {
  return join(guidesDir(repoKey), "vscode");
}

function draftsDir(repoKey: string): string {
  return join(vscodeDir(repoKey), "drafts");
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function newDraftId(now = Date.now()): string {
  return `draft-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

export function saveDraftRecord(record: DraftRecord): void {
  if (!isValidGuideId(record.id)) throw new Error(`Bad draft id ${record.id}`);
  mkdirSync(draftsDir(record.repoKey), { recursive: true });
  writeAtomic(join(draftsDir(record.repoKey), `${record.id}.json`), JSON.stringify(record, null, 2));
}

export function loadDraftRecord(repoKey: string, id: string): DraftRecord | null {
  if (!isValidGuideId(id)) return null;
  return parseDraftRecord(readJson(join(draftsDir(repoKey), `${id}.json`)));
}

function parseDraftRecord(value: unknown): DraftRecord | null {
  if (!value || typeof value !== "object") return null;
  const r = value as DraftRecord;
  if (r.v !== 1 || typeof r.id !== "string" || typeof r.repoKey !== "string" || !r.source || !r.agent) return null;
  const parsed = parseGuideDraft(r.draft);
  if (!parsed.ok) return null;
  return { ...r, draft: parsed.draft };
}

export function listDraftRecords(repoKey: string): DraftRecord[] {
  let names: string[];
  try {
    names = readdirSync(draftsDir(repoKey));
  } catch {
    return [];
  }
  const out: DraftRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const r = loadDraftRecord(repoKey, name.slice(0, -5));
    if (r && r.status !== "finished") out.push(r);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteDraftRecord(repoKey: string, id: string): void {
  if (!isValidGuideId(id)) return;
  rmSync(join(draftsDir(repoKey), `${id}.json`), { force: true });
}

export interface SaveFinishedInput {
  repoKey: string;
  snapshot: GuideSnapshot;
  source: ReviewSourceRecord;
  agent: AgentChoiceRecord;
  focus: Record<string, readonly GuideFocusRange[]>;
  acpSessionId?: string;
  cost?: { amount: number; currency: string };
  diagramCheck?: GuideSidecar["diagramCheck"];
  now?: number;
}

export function snapshotSource(source: ReviewSourceRecord): GuideSnapshotSource {
  return {
    kind: source.kind,
    repo: source.repoName,
    ...(source.branch && source.kind === "local" && { branch: source.branch }),
    headSha: source.headSha,
    ...(source.pr && { pr: { url: source.pr.url, number: source.pr.number, title: source.pr.title, platform: "github" as const } }),
  };
}

export function sourceGitRef(source: ReviewSourceRecord): string {
  return source.kind === "pr" && source.pr ? `PR #${source.pr.number}` : `${source.baseLabel}..working tree`;
}

export function saveFinishedGuide(input: SaveFinishedInput): string {
  const built = buildFinishedGuide(input);
  if (!saveGuidePatch(input.repoKey, built.id, built.rawPatch ?? "")) throw new Error("Could not write the guide's patch.");
  if (!saveGuide(input.repoKey, built.id, built.envelope)) throw new Error("Could not write the guide.");
  writeSidecar(input.repoKey, built.id, built.sidecar);
  return built.id;
}

export function buildFinishedGuide(input: SaveFinishedInput): LoadedGuide {
  const now = input.now ?? Date.now();
  const { snapshot } = input;
  const { reviewed: _reviewed, ...guide } = snapshot.guide;
  const id = makeGuideId(guide.title, now);
  const generator = snapshot.generator;
  const envelope: SavedGuideEnvelope = {
    version: 1,
    savedAt: now,
    label: input.source.kind === "pr" && input.source.pr ? `PR #${input.source.pr.number}` : input.source.branch || "local",
    title: guide.title,
    engine: generator?.engine ?? "claude",
    ...(generator?.model && { model: generator.model }),
    headSha: input.source.headSha,
    ...(input.source.pr && { prUrl: input.source.pr.url }),
    generatedAt: now,
    ...(generator?.customInstructions && { customInstructions: generator.customInstructions }),
    review: {
      gitRef: snapshot.review.gitRef,
      ...(snapshot.review.diffType !== undefined && { diffType: snapshot.review.diffType }),
      ...(snapshot.review.base !== undefined && { base: snapshot.review.base }),
      source: snapshot.source,
      patchFile: `${id}.patch`,
    },
    guide: guide as SavedGuideEnvelope["guide"],
    reviewed: guide.sections.map(() => false),
  };
  const sidecar: GuideSidecar = {
    v: 1,
    fileTicks: [],
    focus: input.focus,
    source: input.source,
    agent: input.agent,
    ...(input.acpSessionId && { acpSessionId: input.acpSessionId }),
    ...(input.cost && { cost: input.cost }),
    ...(input.diagramCheck && { diagramCheck: input.diagramCheck }),
  };
  return { repoKey: input.repoKey, id, envelope, rawPatch: snapshot.review.rawPatch, sidecar };
}

export interface LoadedGuide {
  repoKey: string;
  id: string;
  envelope: SavedGuideEnvelope;
  rawPatch: string | null;
  sidecar: GuideSidecar;
}

export function loadSavedGuide(repoKey: string, id: string): LoadedGuide | null {
  const envelope = loadGuide(repoKey, id);
  if (!envelope) return null;
  return { repoKey, id, envelope, rawPatch: loadGuidePatch(repoKey, envelope), sidecar: readSidecar(repoKey, id) };
}

export function readSidecar(repoKey: string, id: string): GuideSidecar {
  const raw = isValidGuideId(id) ? readJson(join(vscodeDir(repoKey), `${id}.json`)) : null;
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<GuideSidecar>;
  return {
    v: 1,
    fileTicks: Array.isArray(r.fileTicks) ? r.fileTicks.filter((f): f is string => typeof f === "string") : [],
    focus: r.focus && typeof r.focus === "object" ? r.focus : {},
    ...(r.source && { source: r.source }),
    ...(r.agent && { agent: r.agent }),
    ...(typeof r.acpSessionId === "string" && { acpSessionId: r.acpSessionId }),
    ...(r.askSession && typeof r.askSession.id === "string" && typeof r.askSession.agent === "string" && { askSession: { id: r.askSession.id, agent: r.askSession.agent } }),
    ...(r.cost && { cost: r.cost }),
    ...((r.diagramCheck === "ok" || r.diagramCheck === "unchecked" || r.diagramCheck === "failed") && { diagramCheck: r.diagramCheck }),
  };
}

export function writeSidecar(repoKey: string, id: string, sidecar: GuideSidecar): void {
  if (!isValidGuideId(id)) return;
  mkdirSync(vscodeDir(repoKey), { recursive: true });
  writeAtomic(join(vscodeDir(repoKey), `${id}.json`), JSON.stringify(sidecar, null, 2));
}

export function snapshotOfGuide(loaded: LoadedGuide): GuideSnapshot | null {
  const env = loaded.envelope;
  if (loaded.rawPatch === null || !env.review) return null;
  return buildGuideSnapshot({
    guide: env.guide,
    reviewed: env.reviewed,
    review: { rawPatch: loaded.rawPatch, gitRef: env.review.gitRef, diffType: env.review.diffType, base: env.review.base, source: env.review.source },
    generator: {
      engine: env.engine,
      model: env.model,
      generatedAt: env.generatedAt ? new Date(env.generatedAt).toISOString() : undefined,
      customInstructions: env.customInstructions,
    },
  });
}

export function setChapterReviewed(repoKey: string, id: string, reviewed: boolean[]): boolean {
  return updateGuideReviewed(repoKey, id, reviewed);
}

export function deleteSavedGuide(repoKey: string, id: string): boolean {
  const removed = deleteGuide(repoKey, id);
  if (isValidGuideId(id)) rmSync(join(vscodeDir(repoKey), `${id}.json`), { force: true });
  deleteGuideAnswers(repoKey, id);
  return removed;
}

export interface RecentEntry {
  kind: "guide" | "draft";
  id: string;
  title: string;
  label: string;
  at: number;
  progress?: { reviewed: number; total: number };
  moved?: boolean;
  draftInfo?: { chapters: number; filesLeft: number; status: DraftRecord["status"] };
  prNumber?: number;
  sessionOnly?: boolean;
  repoKey?: string;
  repoName?: string;
}

export function repoNameOfKey(repoKey: string): string {
  const parts = repoKey.split("__");
  return parts.length >= 3 ? parts.slice(1).join("/") : repoKey;
}

export function allRepoKeys(): string[] {
  try {
    return readdirSync(join(getPlannotatorDataDir(), "guides"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

export function listRecentEverywhere(options: { limit?: number } = {}): RecentEntry[] {
  const all = allRepoKeys().flatMap((repoKey) => listRecent(repoKey).map((e) => ({ ...e, repoKey, repoName: repoNameOfKey(repoKey) })));
  all.sort((a, b) => b.at - a.at);
  return all.slice(0, options.limit ?? 12);
}

export function guideForPullRequest(repoKey: string, number: number, head?: string | null): string | null {
  let best: { id: string; at: number } | null = null;
  for (const { id, envelope } of listGuides(repoKey)) {
    const prNumber = envelope.review?.source.pr?.number ?? (envelope.prUrl ? Number(/\/pull\/(\d+)/.exec(envelope.prUrl)?.[1]) || undefined : undefined);
    if (prNumber !== number) continue;
    const guideHead = envelope.headSha ?? envelope.review?.source.headSha;
    if (head && guideHead && guideHead !== head) continue;
    if (!best || envelope.savedAt > best.at) best = { id, at: envelope.savedAt };
  }
  return best?.id ?? null;
}

export function listRecent(
  repoKey: string,
  options: { headForPR?: (n: number) => string | undefined; localHead?: string; limit?: number } = {},
): RecentEntry[] {
  const out: RecentEntry[] = [];
  for (const { id, envelope } of listGuides(repoKey)) {
    const prNumber = envelope.review?.source.pr?.number ?? (envelope.prUrl ? Number(/\/pull\/(\d+)/.exec(envelope.prUrl)?.[1]) || undefined : undefined);
    const current = prNumber !== undefined ? options.headForPR?.(prNumber) : undefined;
    out.push({
      kind: "guide",
      id,
      title: envelope.title,
      label: envelope.label,
      at: envelope.savedAt,
      progress: { reviewed: envelope.reviewed.filter(Boolean).length, total: envelope.guide.sections.length },
      moved: !!(envelope.headSha && current && envelope.headSha !== current),
      ...(prNumber !== undefined && { prNumber }),
    });
  }
  for (const d of listDraftRecords(repoKey)) {
    const progress = guideDraftProgress(d.draft);
    out.push({
      kind: "draft",
      id: d.id,
      title: d.draft.title || `Draft · ${d.source.label}`,
      label: d.source.label,
      at: d.updatedAt,
      draftInfo: { chapters: progress.chapters, filesLeft: progress.remaining.length, status: d.status },
      ...(d.source.pr && { prNumber: d.source.pr.number }),
    });
  }
  out.sort((a, b) => b.at - a.at);
  return options.limit ? out.slice(0, options.limit) : out;
}

export function guideStorePaths(repoKey: string) {
  return { guides: guidesDir(repoKey), vscode: vscodeDir(repoKey), drafts: draftsDir(repoKey), exists: existsSync(guidesDir(repoKey)) };
}
