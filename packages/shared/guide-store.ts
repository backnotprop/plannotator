/** Persists successful Guided Reviews as `guides/{repo-key}/{id}.json` plus `{id}.patch` under the data dir. Corrupt or unreadable files load as "no saved guide"; writes are atomic (tmp + rename). */

import { join, resolve, basename } from "path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, existsSync } from "fs";
import { createHash } from "crypto";
import { getPlannotatorDataDir } from "./data-dir";
import { parseRemoteUrl, parseRemoteHost } from "./repo";
import { getDisplayRepo, parsePRUrl } from "./pr-types";
import type { CodeGuideOutput, SavedGuideListEntry } from "./guide";
import {
  buildGuideSnapshot,
  type GuideLaunchReview,
  type GuideSnapshot,
  type GuideSnapshotSource,
} from "@plannotator/core/guide-format";

export type { SavedGuideListEntry };

export const SAVED_GUIDE_ID_PREFIX = "saved:";

export interface SavedGuideEnvelope {
  version: 1;
  savedAt: number;
  label: string;
  title: string;
  engine?: string;
  model?: string;
  headSha?: string;
  prUrl?: string;
  generatedAt?: number;
  customInstructions?: string;
  /** Absent on envelopes written before portable exports existed; such guides are not exportable. */
  review?: SavedGuideReview;
  share?: SavedGuideShare;
  guide: CodeGuideOutput;
  reviewed: boolean[];
}

export interface SavedGuideShare {
  id: string;
  url: string;
  createdAt: string;
  /** Bearer token that deletes the link on the host; returned once, only this file remembers it. */
  deleteToken: string;
  /** The host the link was created on; removal goes there even if the configured share URL has since changed. */
  serviceUrl: string;
}

export interface SavedGuideReview {
  gitRef: string;
  diffType?: string;
  base?: string;
  source: GuideSnapshotSource;
  patchFile: string;
}

function sanitizeKeySegment(segment: string): string {
  const cleaned = segment.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.\-]+|[.\-]+$/g, "");
  return cleaned || "x";
}

function hash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

export function deriveGuideRepoKeyFromRemote(remoteUrl: string): string | null {
  const host = parseRemoteHost(remoteUrl);
  const path = parseRemoteUrl(remoteUrl);
  if (!host || !path) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  return [host, ...segments].map(sanitizeKeySegment).join("__");
}

/** Lands on the same key as deriveGuideRepoKeyFromRemote so PR-mode and branch-mode share a shelf. */
export function deriveGuideRepoKeyFromPRUrl(prUrl: string): string | null {
  const ref = parsePRUrl(prUrl);
  if (!ref) return null;
  const path = getDisplayRepo(ref);
  return [ref.host, ...path.split("/").filter(Boolean)].map(sanitizeKeySegment).join("__");
}

export function deriveGuideRepoKeyFallback(dirPath: string): string {
  const resolved = resolve(dirPath);
  const name = sanitizeKeySegment(basename(resolved) || "repo");
  return `${name}-${hash8(resolved)}`;
}

export async function resolveGuideRepoKey(opts: {
  prUrl?: string;
  gitCwd?: string;
  runGit?: (args: string[], cwd?: string) => Promise<string | null>;
  fallbackDir: string;
}): Promise<string> {
  if (opts.prUrl) {
    const key = deriveGuideRepoKeyFromPRUrl(opts.prUrl);
    if (key) return key;
  }
  if (opts.gitCwd && opts.runGit) {
    const remote = await opts.runGit(["remote", "get-url", "origin"], opts.gitCwd);
    if (remote?.trim()) {
      const key = deriveGuideRepoKeyFromRemote(remote.trim());
      if (key) return key;
    }
    const toplevel = await opts.runGit(["rev-parse", "--show-toplevel"], opts.gitCwd);
    if (toplevel?.trim()) return deriveGuideRepoKeyFallback(toplevel.trim());
  }
  return deriveGuideRepoKeyFallback(opts.fallbackDir);
}

const GUIDE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Guards against path traversal: ids arrive from the client, so only a conservative charset is accepted. */
export function isValidGuideId(id: string): boolean {
  return id.length > 0 && id.length <= 160 && GUIDE_ID_RE.test(id);
}

export function makeGuideId(title: string, now: number = Date.now()): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${now}-${slug || "guide"}`;
}

function guidesDir(repoKey: string): string {
  return join(getPlannotatorDataDir(), "guides", repoKey);
}

function guidePath(repoKey: string, id: string): string {
  return join(guidesDir(repoKey), `${id}.json`);
}

function guidePatchPath(repoKey: string, id: string): string {
  return join(guidesDir(repoKey), `${id}.patch`);
}

function coerceReviewed(value: unknown, sectionCount: number): boolean[] {
  const out = new Array<boolean>(sectionCount).fill(false);
  if (Array.isArray(value)) {
    for (let i = 0; i < sectionCount; i++) out[i] = value[i] === true;
  }
  return out;
}

const KNOWN_ENVELOPE_KEYS = new Set<string>([
  "version", "savedAt", "label", "title", "engine", "model", "headSha", "prUrl", "generatedAt",
  "customInstructions", "review", "share", "guide", "reviewed",
]);

/** Unknown top-level keys pass through: every write rebuilds the file, and an older binary must not destroy data it cannot read (the `share` record holds the only copy of a delete token). */
function parseEnvelope(raw: string): SavedGuideEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) return null;
  const guide = obj.guide as Record<string, unknown> | undefined;
  if (!guide || typeof guide !== "object") return null;
  if (typeof guide.title !== "string") return null;
  if (!Array.isArray(guide.sections) || guide.sections.length === 0) return null;
  const sectionCount = guide.sections.length;
  const review = parseSavedReview(obj.review);
  const share = parseSavedShare(obj.share);
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!KNOWN_ENVELOPE_KEYS.has(key)) unknown[key] = value;
  }
  return {
    ...unknown,
    version: 1,
    savedAt: typeof obj.savedAt === "number" ? obj.savedAt : 0,
    label: typeof obj.label === "string" ? obj.label : "",
    title: typeof obj.title === "string" ? obj.title : (guide.title as string),
    ...(typeof obj.engine === "string" ? { engine: obj.engine } : {}),
    ...(typeof obj.model === "string" ? { model: obj.model } : {}),
    ...(typeof obj.headSha === "string" && obj.headSha ? { headSha: obj.headSha } : {}),
    ...(typeof obj.prUrl === "string" && obj.prUrl ? { prUrl: obj.prUrl } : {}),
    ...(typeof obj.generatedAt === "number" ? { generatedAt: obj.generatedAt } : {}),
    ...(typeof obj.customInstructions === "string" && obj.customInstructions ? { customInstructions: obj.customInstructions } : {}),
    ...(review ? { review } : {}),
    ...(share ? { share } : {}),
    guide: guide as unknown as CodeGuideOutput,
    reviewed: coerceReviewed(obj.reviewed, sectionCount),
  };
}

const SOURCE_KINDS = new Set(["local", "pr", "workspace", "commit"]);

function parseSavedReview(value: unknown): SavedGuideReview | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const source = r.source as Record<string, unknown> | undefined;
  if (typeof r.gitRef !== "string" || typeof r.patchFile !== "string") return null;
  if (!source || typeof source !== "object" || typeof source.kind !== "string" || !SOURCE_KINDS.has(source.kind)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.patch$/.test(r.patchFile) || r.patchFile.includes("..")) return null;
  return {
    gitRef: r.gitRef,
    ...(typeof r.diffType === "string" ? { diffType: r.diffType } : {}),
    ...(typeof r.base === "string" ? { base: r.base } : {}),
    source: source as unknown as GuideSnapshotSource,
    patchFile: r.patchFile,
  };
}

function parseSavedShare(value: unknown): SavedGuideShare | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.url !== "string" || !r.url) return null;
  if (typeof r.deleteToken !== "string" || !r.deleteToken) return null;
  if (typeof r.serviceUrl !== "string" || !r.serviceUrl) return null;
  return {
    id: r.id,
    url: r.url,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString(),
    deleteToken: r.deleteToken,
    serviceUrl: r.serviceUrl,
  };
}

/** Returns false, never throws: persistence must not break the review session. */
export function saveGuide(repoKey: string, id: string, envelope: SavedGuideEnvelope): boolean {
  const written = writeGuideEnvelope(repoKey, id, envelope);
  if (!written.ok) console.error(`[guide-store] Failed to save guide ${id}: ${written.error}`);
  return written.ok;
}

function writeGuideEnvelope(repoKey: string, id: string, envelope: SavedGuideEnvelope): { ok: true } | { ok: false; error: string } {
  if (!isValidGuideId(id)) return { ok: false, error: `invalid guide id ${JSON.stringify(id)}` };
  try {
    mkdirSync(guidesDir(repoKey), { recursive: true });
    const finalPath = guidePath(repoKey, id);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), "utf-8");
    renameSync(tmpPath, finalPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Callers write the patch BEFORE the envelope that references it, so an envelope never points at a missing file. */
export function saveGuidePatch(repoKey: string, id: string, rawPatch: string): boolean {
  if (!isValidGuideId(id)) return false;
  try {
    mkdirSync(guidesDir(repoKey), { recursive: true });
    const finalPath = guidePatchPath(repoKey, id);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, rawPatch, "utf-8");
    renameSync(tmpPath, finalPath);
    return true;
  } catch (e) {
    console.error(`[guide-store] Failed to save guide patch ${id}: ${e}`);
    return false;
  }
}

export function loadGuidePatch(repoKey: string, envelope: SavedGuideEnvelope): string | null {
  if (!envelope.review) return null;
  try {
    const filePath = join(guidesDir(repoKey), envelope.review.patchFile);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function buildSavedGuideSnapshot(repoKey: string, envelope: SavedGuideEnvelope): GuideSnapshot | null {
  const rawPatch = loadGuidePatch(repoKey, envelope);
  if (rawPatch === null || !envelope.review) return null;
  return buildGuideSnapshot({
    guide: envelope.guide,
    reviewed: envelope.reviewed,
    review: {
      rawPatch,
      gitRef: envelope.review.gitRef,
      diffType: envelope.review.diffType,
      base: envelope.review.base,
      source: envelope.review.source,
    },
    generator: {
      engine: envelope.engine,
      model: envelope.model,
      generatedAt: envelope.generatedAt ? new Date(envelope.generatedAt).toISOString() : undefined,
      customInstructions: envelope.customInstructions,
    },
  });
}

/** Never replaces a saved guide: the id is claimed by creating its `.patch` exclusively, and a taken id moves on to the next millisecond. */
export function saveImportedGuide(
  repoKey: string,
  snapshot: GuideSnapshot,
  opts: {
    label: string;
    prUrl?: string;
    now?: number;
    /** No head sha is stored, so a review never flags the guide as moved: the snapshot's head is not the shelf PR's head. */
    omitHeadSha?: boolean;
  },
): { ok: true; id: string } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  const { reviewed, ...guide } = snapshot.guide;
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const removeQuietly = (path: string) => {
    try { if (existsSync(path)) unlinkSync(path); } catch {}
  };
  try {
    mkdirSync(guidesDir(repoKey), { recursive: true });
  } catch (e) {
    return { ok: false, error: `Could not create ${guidesDir(repoKey)}: ${message(e)}` };
  }

  let id: string | undefined;
  for (let attempt = 0; attempt < 1000 && id === undefined; attempt++) {
    const candidate = makeGuideId(guide.title, now + attempt);
    if (existsSync(guidePath(repoKey, candidate))) continue;
    const patchPath = guidePatchPath(repoKey, candidate);
    try {
      // Patch first, then the envelope that references it.
      writeFileSync(patchPath, snapshot.review.rawPatch, { encoding: "utf-8", flag: "wx" });
      id = candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") continue;
      removeQuietly(patchPath);
      return { ok: false, error: `Could not write ${patchPath}: ${message(e)}` };
    }
  }
  if (id === undefined) return { ok: false, error: `No free guide id for "${guide.title}" in ${guidesDir(repoKey)}.` };

  const generator = snapshot.generator ?? {};
  const generatedAt = generator.generatedAt ? Date.parse(generator.generatedAt) : NaN;
  const headSha = opts.omitHeadSha ? undefined : snapshot.source.headSha;
  const envelope: SavedGuideEnvelope = {
    version: 1,
    savedAt: now,
    label: opts.label,
    title: guide.title,
    ...(generator.engine ? { engine: generator.engine } : {}),
    ...(generator.model ? { model: generator.model } : {}),
    ...(headSha ? { headSha } : {}),
    ...(opts.prUrl ? { prUrl: opts.prUrl } : {}),
    ...(Number.isFinite(generatedAt) ? { generatedAt } : {}),
    ...(generator.customInstructions ? { customInstructions: generator.customInstructions } : {}),
    review: {
      gitRef: snapshot.review.gitRef,
      ...(snapshot.review.diffType !== undefined ? { diffType: snapshot.review.diffType } : {}),
      ...(snapshot.review.base !== undefined ? { base: snapshot.review.base } : {}),
      source: snapshot.source,
      patchFile: `${id}.patch`,
    },
    guide: guide as CodeGuideOutput,
    reviewed: coerceReviewed(reviewed, guide.sections.length),
  };
  const written = writeGuideEnvelope(repoKey, id, envelope);
  if (written.ok) return { ok: true, id };
  removeQuietly(`${guidePath(repoKey, id)}.tmp`);
  removeQuietly(guidePatchPath(repoKey, id));
  return { ok: false, error: `Could not write ${guidePath(repoKey, id)}: ${written.error}` };
}

export function findSavedGuideById(id: string): { repoKey: string; envelope: SavedGuideEnvelope } | null {
  if (!isValidGuideId(id)) return null;
  let repoKeys: string[];
  try {
    repoKeys = readdirSync(join(getPlannotatorDataDir(), "guides"));
  } catch {
    return null;
  }
  for (const repoKey of repoKeys) {
    const envelope = loadGuide(repoKey, id);
    if (envelope) return { repoKey, envelope };
  }
  return null;
}

export function listAllSavedGuides(): Array<{ repoKey: string; id: string; envelope: SavedGuideEnvelope }> {
  let repoKeys: string[];
  try {
    repoKeys = readdirSync(join(getPlannotatorDataDir(), "guides"));
  } catch {
    return [];
  }
  const out: Array<{ repoKey: string; id: string; envelope: SavedGuideEnvelope }> = [];
  for (const repoKey of repoKeys) {
    for (const { id, envelope } of listGuides(repoKey)) out.push({ repoKey, id, envelope });
  }
  out.sort((a, b) => b.envelope.savedAt - a.envelope.savedAt);
  return out;
}

export function loadGuide(repoKey: string, id: string): SavedGuideEnvelope | null {
  if (!isValidGuideId(id)) return null;
  try {
    const filePath = guidePath(repoKey, id);
    if (!existsSync(filePath)) return null;
    return parseEnvelope(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function updateGuideReviewed(repoKey: string, id: string, reviewed: boolean[]): boolean {
  const envelope = loadGuide(repoKey, id);
  if (!envelope) return false;
  return saveGuide(repoKey, id, {
    ...envelope,
    reviewed: coerceReviewed(reviewed, envelope.guide.sections.length),
  });
}

export function updateGuideShare(repoKey: string, id: string, share: SavedGuideShare | null): boolean {
  const envelope = loadGuide(repoKey, id);
  if (!envelope) return false;
  const { share: _previous, ...rest } = envelope;
  return saveGuide(repoKey, id, share ? { ...rest, share } : rest);
}

export function listGuides(repoKey: string): Array<{ id: string; envelope: SavedGuideEnvelope }> {
  let names: string[];
  try {
    names = readdirSync(guidesDir(repoKey));
  } catch {
    return [];
  }
  const out: Array<{ id: string; envelope: SavedGuideEnvelope }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isValidGuideId(id)) continue;
    const envelope = loadGuide(repoKey, id);
    if (envelope) out.push({ id, envelope });
  }
  out.sort((a, b) => b.envelope.savedAt - a.envelope.savedAt);
  return out;
}

export function deleteGuide(repoKey: string, id: string): boolean {
  if (!isValidGuideId(id)) return false;
  try {
    const filePath = guidePath(repoKey, id);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    try { const patchPath = guidePatchPath(repoKey, id); if (existsSync(patchPath)) unlinkSync(patchPath); } catch {}
    return true;
  } catch {
    return false;
  }
}

export interface GuideStoreSessionOptions {
  runGit?: (args: string[], cwd?: string) => Promise<string | null>;
  getGitCwd: () => string | undefined;
  getPRInfo: () => { url: string; headSha: string; label: string } | null;
  getBranchLabel: () => string | undefined;
  getFallbackDir: () => string;
  writesEnabled: () => boolean;
}

/** Review-target snapshot taken when a guide job launches: jobs run for minutes while the live PR or diff can switch, so reading live getters at completion would label the envelope with the wrong context. */
export interface GuideLaunchContext {
  pr?: { url: string; headSha: string; label: string } | null;
  branchLabel?: string;
  headSha?: string;
}

export interface GuideStoreSession {
  captureLaunchContext(): Promise<GuideLaunchContext>;
  saveForJob(
    job: { id: string; engine?: string; model?: string; generatedAt?: number },
    data: CodeGuideOutput & { reviewed?: boolean[] },
    launchContext?: GuideLaunchContext,
    launchReview?: GuideLaunchReview,
  ): Promise<void>;
  isJobSaved(jobId: string): boolean;
  writeThroughReviewed(jobId: string, reviewed: boolean[]): Promise<void>;
  getSavedGuideData(
    id: string,
  ): Promise<(CodeGuideOutput & { reviewed: boolean[]; saved: true; moved: boolean }) | null>;
  updateSavedReviewed(id: string, reviewed: boolean[]): Promise<boolean>;
  listSaved(): Promise<SavedGuideListEntry[]>;
  deleteSaved(id: string): Promise<boolean>;
  getSavedGuideSnapshot(id: string): Promise<GuideSnapshot | null>;
  getJobGuideSnapshot(jobId: string): Promise<GuideSnapshot | null>;
  locateEnvelope(jobId: string): Promise<{ repoKey: string; id: string; envelope: SavedGuideEnvelope } | null>;
}

export function createGuideStoreSession(options: GuideStoreSessionOptions): GuideStoreSession {
  const { runGit, getGitCwd, getPRInfo, getBranchLabel, getFallbackDir, writesEnabled } = options;

  /** Carries the repo key the save landed under (the launch-time PR key when captured), so write-through never chases the session key. */
  const savedIdByJob = new Map<string, { repoKey: string; id: string }>();

  let repoKeyPromise: Promise<string> | null = null;
  const resolveRepoKey = (): Promise<string> => {
    if (!repoKeyPromise) {
      repoKeyPromise = (async () =>
        resolveGuideRepoKey({
          prUrl: getPRInfo()?.url,
          gitCwd: getGitCwd(),
          runGit,
          fallbackDir: getFallbackDir(),
        }))().catch(() => deriveGuideRepoKeyFallback(getFallbackDir()));
    }
    return repoKeyPromise;
  };

  const currentHeadSha = async (): Promise<string | undefined> => {
    const pr = getPRInfo();
    if (pr && pr.headSha) return pr.headSha;
    const cwd = getGitCwd();
    if (cwd && runGit) {
      const out = await runGit(["rev-parse", "HEAD"], cwd);
      const sha = out?.trim();
      if (sha && /^[0-9a-f]{7,64}$/i.test(sha)) return sha;
    }
    return undefined;
  };

  const isMoved = (stored: string | undefined, current: string | undefined): boolean =>
    !!(stored && current && stored !== current);

  return {
    async captureLaunchContext() {
      const pr = getPRInfo();
      return {
        ...(pr ? { pr } : {}),
        ...(getBranchLabel() ? { branchLabel: getBranchLabel() } : {}),
        ...(await currentHeadSha().then((sha) => (sha ? { headSha: sha } : {}))),
      };
    },

    async saveForJob(job, data, launchContext, launchReview) {
      try {
        if (!writesEnabled()) return;
        const { reviewed, ...guide } = data;
        const existingId = savedIdByJob.get(job.id);
        // The launch-time snapshot wins over the live getters: the envelope must describe what the guide was generated against.
        const pr = launchContext ? launchContext.pr ?? null : getPRInfo();
        const headSha = launchContext ? launchContext.headSha : await currentHeadSha();
        const branchLabel = launchContext ? launchContext.branchLabel : getBranchLabel();
        // Shelf anchored to the launch-time PR too, so a PR switch cannot file the guide under another repository.
        const repoKey = existingId?.repoKey
          ?? (pr?.url ? deriveGuideRepoKeyFromPRUrl(pr.url) : null)
          ?? (await resolveRepoKey());
        const id = existingId?.id ?? makeGuideId(guide.title);
        // A re-save rewrites the whole file: carry over the stored share link (the only copy of its delete token) and, absent a fresh review, the stored review.
        const previous = existingId ? loadGuide(existingId.repoKey, existingId.id) : null;
        const patchFile = `${id}.patch`;
        const patchSaved = launchReview ? saveGuidePatch(repoKey, id, launchReview.rawPatch) : false;
        const envelope: SavedGuideEnvelope = {
          version: 1,
          savedAt: Date.now(),
          label: pr?.label ?? branchLabel ?? "local",
          title: guide.title,
          ...(job.engine ? { engine: job.engine } : {}),
          ...(job.model ? { model: job.model } : {}),
          ...(pr?.headSha ? { headSha: pr.headSha } : headSha ? { headSha } : {}),
          ...(pr?.url ? { prUrl: pr.url } : {}),
          ...(job.generatedAt ? { generatedAt: job.generatedAt } : {}),
          ...(launchReview?.customInstructions ? { customInstructions: launchReview.customInstructions } : {}),
          ...(patchSaved && launchReview
            ? {
                review: {
                  gitRef: launchReview.gitRef,
                  ...(launchReview.diffType !== undefined ? { diffType: launchReview.diffType } : {}),
                  ...(launchReview.base !== undefined ? { base: launchReview.base } : {}),
                  source: launchReview.source,
                  patchFile,
                },
              }
            : previous?.review ? { review: previous.review } : {}),
          ...(previous?.share ? { share: previous.share } : {}),
          guide: guide as CodeGuideOutput,
          reviewed: coerceReviewed(reviewed, guide.sections.length),
        };
        if (saveGuide(repoKey, id, envelope)) savedIdByJob.set(job.id, { repoKey, id });
      } catch (e) {
        console.error(`[guide-store] Autosave failed for job ${job.id}: ${e}`);
      }
    },

    isJobSaved(jobId) {
      return savedIdByJob.has(jobId);
    },

    async writeThroughReviewed(jobId, reviewed) {
      const saved = savedIdByJob.get(jobId);
      if (!saved) return;
      try {
        updateGuideReviewed(saved.repoKey, saved.id, reviewed);
      } catch {
        // Best-effort — the in-memory state is still authoritative this session.
      }
    },

    async getSavedGuideData(id) {
      const envelope = loadGuide(await resolveRepoKey(), id);
      if (!envelope) return null;
      const head = await currentHeadSha();
      return {
        ...envelope.guide,
        reviewed: coerceReviewed(envelope.reviewed, envelope.guide.sections.length),
        saved: true,
        moved: isMoved(envelope.headSha, head),
      };
    },

    async updateSavedReviewed(id, reviewed) {
      return updateGuideReviewed(await resolveRepoKey(), id, reviewed);
    },

    async listSaved() {
      const repoKey = await resolveRepoKey();
      const head = await currentHeadSha();
      return listGuides(repoKey).map(({ id, envelope }) => ({
        id,
        label: envelope.label,
        title: envelope.title,
        savedAt: envelope.savedAt,
        progress: {
          reviewed: envelope.reviewed.filter(Boolean).length,
          total: envelope.guide.sections.length,
        },
        moved: isMoved(envelope.headSha, head),
      }));
    },

    async deleteSaved(id) {
      return deleteGuide(await resolveRepoKey(), id);
    },

    async getSavedGuideSnapshot(id) {
      const repoKey = await resolveRepoKey();
      const envelope = loadGuide(repoKey, id);
      return envelope ? buildSavedGuideSnapshot(repoKey, envelope) : null;
    },

    async getJobGuideSnapshot(jobId) {
      const saved = savedIdByJob.get(jobId);
      if (!saved) return null;
      const envelope = loadGuide(saved.repoKey, saved.id);
      return envelope ? buildSavedGuideSnapshot(saved.repoKey, envelope) : null;
    },

    async locateEnvelope(jobId) {
      const saved = jobId.startsWith(SAVED_GUIDE_ID_PREFIX)
        ? { repoKey: await resolveRepoKey(), id: jobId.slice(SAVED_GUIDE_ID_PREFIX.length) }
        : savedIdByJob.get(jobId);
      if (!saved) return null;
      const envelope = loadGuide(saved.repoKey, saved.id);
      return envelope ? { ...saved, envelope } : null;
    },
  };
}
