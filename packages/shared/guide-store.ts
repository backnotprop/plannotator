/**
 * Guide Store
 *
 * Persists successful Guided Reviews to disk so they survive server restarts
 * (issue #1112). Files live at:
 *
 *   ${PLANNOTATOR_DATA_DIR}/guides/{repo-key}/{id}.json      (envelope)
 *   ${PLANNOTATOR_DATA_DIR}/guides/{repo-key}/{id}.patch     (the diff the guide describes; portable export)
 *
 * repo-key is a sanitized `host__owner__repo` derived from the repository's
 * origin remote (or the PR url in PR mode), so a PR review and a local review
 * of the same repository share the same shelf while same-named branches in
 * different repositories never collide. When no parseable remote exists, the
 * key falls back to `{dir-name}-{hash8-of-resolved-path}` — the same pattern
 * annotate mode uses for its per-file history slugs.
 *
 * Runtime-agnostic (node:fs / node:path / node:crypto only), following the
 * storage.ts / draft.ts patterns. Vendored to Pi via vendor.sh. Corrupt or
 * unreadable files load as "no saved guide" (the review-skill-loader
 * skip-and-log discipline); writes are atomic (tmp + rename).
 */

import { join, resolve, basename } from "path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, existsSync } from "fs";
import { createHash } from "crypto";
import { getPlannotatorDataDir } from "./data-dir";
import { parseRemoteUrl, parseRemoteHost } from "./repo";
import { parsePRUrl } from "./pr-types";
import type { CodeGuideOutput, SavedGuideListEntry } from "./guide";
import {
  buildGuideSnapshot,
  type GuideLaunchReview,
  type GuideSnapshot,
  type GuideSnapshotSource,
} from "@plannotator/core/guide-format";

export type { SavedGuideListEntry };

/** Client-facing pseudo job-id prefix for persisted guides ("saved:{id}"). */
export const SAVED_GUIDE_ID_PREFIX = "saved:";

/** On-disk envelope for one persisted guide. */
export interface SavedGuideEnvelope {
  version: 1;
  /** Epoch ms when the guide was first persisted. */
  savedAt: number;
  /** Review-target label shown in the list — "PR #1082" or the branch name. */
  label: string;
  /** The guide's own title (envelope-level copy for listing without re-parse). */
  title: string;
  /** Engine that generated the guide (e.g. "claude", "codex"). */
  engine?: string;
  /** Model used, when known. */
  model?: string;
  /** Repo HEAD (or PR head) sha at generation time — drives the `moved` flag. */
  headSha?: string;
  /** PR/MR url when the guide was generated in PR mode. */
  prUrl?: string;
  /** Epoch ms when generation finished (export provenance). */
  generatedAt?: number;
  /** Reviewer-supplied instructions that shaped the guide (export provenance). */
  customInstructions?: string;
  /**
   * The review the guide was generated against — everything a portable export
   * needs besides the guide itself. The patch bytes live in the sibling
   * `{id}.patch` file (they can be large); this block carries the labels.
   * Absent on envelopes written before portable exports existed, in which
   * case the guide is not exportable ("diff not retained").
   */
  review?: SavedGuideReview;
  /**
   * The share link this guide currently has on the guide host (guide share
   * hosting contract, §7), so a saved guide remembers its link across
   * sessions and can remove it later. Absent when never shared or after the
   * link was removed.
   */
  share?: SavedGuideShare;
  guide: CodeGuideOutput;
  reviewed: boolean[];
}

export interface SavedGuideShare {
  /** The host's guide id (base64url, the last path segment of `url`). */
  id: string;
  /** Full share URL, including the `#key=…` fragment for encrypted shares. */
  url: string;
  /** ISO timestamp of when the link was created. */
  createdAt: string;
  /** Bearer token that deletes the link on the host. Returned once by the host; only this file remembers it. */
  deleteToken: string;
  /**
   * The guide host the link was created on (`https://guides.show` or your own
   * deployment), so removal goes to the host that holds the upload even when
   * the configured share URL has changed since.
   */
  serviceUrl: string;
}

export interface SavedGuideReview {
  gitRef: string;
  diffType?: string;
  base?: string;
  source: GuideSnapshotSource;
  /** Sibling file name holding the raw patch, e.g. "{id}.patch". */
  patchFile: string;
}

// ---------------------------------------------------------------------------
// Repo-key derivation
// ---------------------------------------------------------------------------

function sanitizeKeySegment(segment: string): string {
  const cleaned = segment.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.\-]+|[.\-]+$/g, "");
  return cleaned || "x";
}

function hash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Derive a repo key from a git remote URL (SSH, HTTPS, ssh://…), e.g.
 * `git@github.com:owner/repo.git` → `github.com__owner__repo`.
 * Subgroup paths keep every segment (`gitlab.com__group__sub__proj`).
 * Returns null when the URL doesn't parse as a known remote form.
 */
export function deriveGuideRepoKeyFromRemote(remoteUrl: string): string | null {
  const host = parseRemoteHost(remoteUrl);
  const path = parseRemoteUrl(remoteUrl);
  if (!host || !path) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  return [host, ...segments].map(sanitizeKeySegment).join("__");
}

/**
 * Derive a repo key from a PR/MR URL — lands on the same key as
 * deriveGuideRepoKeyFromRemote for the matching origin remote, so PR-mode and
 * branch-mode sessions of one repository share a shelf.
 */
export function deriveGuideRepoKeyFromPRUrl(prUrl: string): string | null {
  const ref = parsePRUrl(prUrl);
  if (!ref) return null;
  const path = ref.platform === "github" ? `${ref.owner}/${ref.repo}` : ref.projectPath;
  return [ref.host, ...path.split("/").filter(Boolean)].map(sanitizeKeySegment).join("__");
}

/**
 * No-remote fallback: repo-root (or cwd) directory name + hash8 of the
 * resolved path — mirrors annotate mode's `annotate-{basename}-{hash8}` slug.
 */
export function deriveGuideRepoKeyFallback(dirPath: string): string {
  const resolved = resolve(dirPath);
  const name = sanitizeKeySegment(basename(resolved) || "repo");
  return `${name}-${hash8(resolved)}`;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const GUIDE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Guard against path traversal — ids arrive from the client on the
 *  `saved:{id}` endpoints, so only a conservative charset is accepted. */
export function isValidGuideId(id: string): boolean {
  return id.length > 0 && id.length <= 160 && GUIDE_ID_RE.test(id);
}

/** `{timestamp}-{slug-of-title}` — sortable-by-name ≙ sortable-by-time. */
export function makeGuideId(title: string, now: number = Date.now()): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${now}-${slug || "guide"}`;
}

// ---------------------------------------------------------------------------
// Disk primitives
// ---------------------------------------------------------------------------

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

/** Top-level envelope keys this version reads. Anything else is carried through untouched (see `parseEnvelope`). */
const KNOWN_ENVELOPE_KEYS = new Set<string>([
  "version", "savedAt", "label", "title", "engine", "model", "headSha", "prUrl", "generatedAt",
  "customInstructions", "review", "share", "guide", "reviewed",
]);

/**
 * Minimal shape check — anything that fails loads as "no saved guide".
 * Top-level keys this version does not know are passed through rather than
 * dropped: every write rebuilds the file from the parsed envelope, so a
 * binary that skews behind the one that wrote the file must not destroy
 * data it cannot read — the `share` record is the only copy of a link's
 * delete token, and losing it strands a published diff.
 */
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
  // Guard the sibling file reference: a plain file name in this directory, nothing else.
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

/**
 * Atomically write a guide envelope. Returns false (never throws) on invalid
 * id or write failure — persistence must never break the review session.
 */
export function saveGuide(repoKey: string, id: string, envelope: SavedGuideEnvelope): boolean {
  if (!isValidGuideId(id)) return false;
  try {
    mkdirSync(guidesDir(repoKey), { recursive: true });
    const finalPath = guidePath(repoKey, id);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), "utf-8");
    renameSync(tmpPath, finalPath);
    return true;
  } catch (e) {
    console.error(`[guide-store] Failed to save guide ${id}: ${e}`);
    return false;
  }
}

/**
 * Atomically write the patch a guide describes beside its envelope. Returns
 * false (never throws) on failure. Callers write the patch BEFORE the envelope
 * that references it, so an envelope never points at a missing file.
 */
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

/** Read the patch referenced by an envelope. Missing → null. */
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

/**
 * Turn a saved guide (+ its patch) into a portable snapshot. Null when the
 * guide predates portable exports (no review block / no patch on disk).
 */
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

/**
 * Locate a saved guide by id across every repo shelf — for the CLI, which has
 * no session and therefore no repo key. Ids embed a timestamp + slug, so
 * collisions across shelves are practically impossible; the first match wins.
 */
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

/** Every saved guide across every repo shelf, newest first — for the CLI list. */
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

/** Load one saved guide. Missing/corrupt/invalid → null. */
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

/** Update the reviewed array of a saved guide in place (atomic rewrite). */
export function updateGuideReviewed(repoKey: string, id: string, reviewed: boolean[]): boolean {
  const envelope = loadGuide(repoKey, id);
  if (!envelope) return false;
  return saveGuide(repoKey, id, {
    ...envelope,
    reviewed: coerceReviewed(reviewed, envelope.guide.sections.length),
  });
}

/**
 * Record (or, with null, forget) the share link of a saved guide. Atomic
 * rewrite of the whole envelope; false when the guide does not exist or the
 * write failed.
 */
export function updateGuideShare(repoKey: string, id: string, share: SavedGuideShare | null): boolean {
  const envelope = loadGuide(repoKey, id);
  if (!envelope) return false;
  const { share: _previous, ...rest } = envelope;
  return saveGuide(repoKey, id, share ? { ...rest, share } : rest);
}

/** List all saved guides for a repo, newest first. Corrupt files are skipped. */
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

/** Delete a saved guide. Returns true when a file was actually removed. */
export function deleteGuide(repoKey: string, id: string): boolean {
  if (!isValidGuideId(id)) return false;
  try {
    const filePath = guidePath(repoKey, id);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    // Best-effort: the patch is worthless without its envelope.
    try { const patchPath = guidePatchPath(repoKey, id); if (existsSync(patchPath)) unlinkSync(patchPath); } catch {}
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session glue — shared by the Bun review server and the Pi mirror so the
// repo-key/headSha/label resolution and the jobId→savedId mapping are written
// exactly once. All getters are late-bound because prMetadata / gitContext /
// config can change mid-session (pr-switch, config edits).
// ---------------------------------------------------------------------------

export interface GuideStoreSessionOptions {
  /** Run `git <args>` in `cwd`, returning stdout on exit 0, else null.
   *  Omit when the session has no local git access. */
  runGit?: (args: string[], cwd?: string) => Promise<string | null>;
  /** Cwd for git commands (branch mode). Undefined disables git lookups. */
  getGitCwd: () => string | undefined;
  /** Current PR identity, or null outside PR mode. */
  getPRInfo: () => { url: string; headSha: string; label: string } | null;
  /** Branch label for non-PR sessions (gitContext.currentBranch). */
  getBranchLabel: () => string | undefined;
  /** Directory for the no-remote fallback key (workspace root / agent cwd). */
  getFallbackDir: () => string;
  /** Autosave gate — resolveGuideHistory(loadConfig()), evaluated per write. */
  writesEnabled: () => boolean;
}

/**
 * Review-target snapshot taken when a guide job LAUNCHES. Guide jobs run for
 * minutes while the session supports mid-generation PR switching
 * (/api/pr-switch) and diff switches — reading the live getters at completion
 * would permanently label the envelope with the WRONG context (launched on PR
 * A, switched to B, completed: A's content stamped with B's label/url/head).
 * Captured via captureLaunchContext() at build time and carried on the job
 * itself (AgentJobInfo.guideContext), same discipline as changedFilesSnapshot.
 */
export interface GuideLaunchContext {
  pr?: { url: string; headSha: string; label: string } | null;
  branchLabel?: string;
  headSha?: string;
}

export interface GuideStoreSession {
  /** Snapshot the CURRENT review-target context for a job being launched now.
   *  The caller stamps the result onto the job; saveForJob prefers it over
   *  the live getters at completion time. */
  captureLaunchContext(): Promise<GuideLaunchContext>;
  /** Persist a successfully validated guide for a completed job. Prefers the
   *  job's launch-time context snapshot; falls back to the live getters only
   *  when no snapshot exists (defensive). Never throws. */
  saveForJob(
    job: { id: string; engine?: string; model?: string; generatedAt?: number },
    data: CodeGuideOutput & { reviewed?: boolean[] },
    launchContext?: GuideLaunchContext,
    /** The review the guide describes, captured at launch (decision record D6). Stored beside the envelope; enables export. */
    launchReview?: GuideLaunchReview,
  ): Promise<void>;
  /** True when this live job id has already been autosaved this session. */
  isJobSaved(jobId: string): boolean;
  /** Write a live job's reviewed-state change through to its saved file. */
  writeThroughReviewed(jobId: string, reviewed: boolean[]): Promise<void>;
  /** Serve a saved guide as guide data (guide + reviewed + saved/moved flags). */
  getSavedGuideData(
    id: string,
  ): Promise<(CodeGuideOutput & { reviewed: boolean[]; saved: true; moved: boolean }) | null>;
  /** Persist reviewed state for a saved guide (`saved:{id}` PUT). */
  updateSavedReviewed(id: string, reviewed: boolean[]): Promise<boolean>;
  /** GET /api/guides rows, newest first. */
  listSaved(): Promise<SavedGuideListEntry[]>;
  /** DELETE /api/guides/:id. */
  deleteSaved(id: string): Promise<boolean>;
  /** Portable snapshot for a saved guide, or null when its diff was not retained. */
  getSavedGuideSnapshot(id: string): Promise<GuideSnapshot | null>;
  /** Portable snapshot for a live job that was autosaved this session, else null. */
  getJobGuideSnapshot(jobId: string): Promise<GuideSnapshot | null>;
  /**
   * Where the envelope behind an endpoint guide id lives on disk: `saved:{id}`
   * → this repo's shelf; a live job → its autosave (when one happened). Null
   * when nothing is persisted. Backs the share-link bookkeeping
   * (`updateGuideShare`) so a saved guide remembers its link.
   */
  locateEnvelope(jobId: string): Promise<{ repoKey: string; id: string; envelope: SavedGuideEnvelope } | null>;
}

export function createGuideStoreSession(options: GuideStoreSessionOptions): GuideStoreSession {
  const { runGit, getGitCwd, getPRInfo, getBranchLabel, getFallbackDir, writesEnabled } = options;

  /** jobId → saved location, for reviewed write-through and the `saved` flag.
   *  Carries the repo key the save actually landed under (launch-time PR key
   *  when one was captured), so write-through never chases the session key. */
  const savedIdByJob = new Map<string, { repoKey: string; id: string }>();

  let repoKeyPromise: Promise<string> | null = null;
  const resolveRepoKey = (): Promise<string> => {
    if (!repoKeyPromise) {
      repoKeyPromise = (async () => {
        const pr = getPRInfo();
        if (pr) {
          const key = deriveGuideRepoKeyFromPRUrl(pr.url);
          if (key) return key;
        }
        const cwd = getGitCwd();
        if (cwd && runGit) {
          const remote = await runGit(["remote", "get-url", "origin"], cwd);
          if (remote?.trim()) {
            const key = deriveGuideRepoKeyFromRemote(remote.trim());
            if (key) return key;
          }
          const toplevel = await runGit(["rev-parse", "--show-toplevel"], cwd);
          if (toplevel?.trim()) return deriveGuideRepoKeyFallback(toplevel.trim());
        }
        return deriveGuideRepoKeyFallback(getFallbackDir());
      })().catch(() => deriveGuideRepoKeyFallback(getFallbackDir()));
    }
    return repoKeyPromise;
  };

  /** The head the CURRENT session is looking at — PR head in PR mode, else
   *  local HEAD. Compared against each envelope's stored headSha for `moved`. */
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
        // Launch-time snapshot wins over the live getters: the envelope must
        // describe the changeset the guide was GENERATED against, not the
        // PR/diff the reviewer switched to while the job ran. Live getters are
        // the defensive fallback for jobs launched without a snapshot.
        const pr = launchContext ? launchContext.pr ?? null : getPRInfo();
        const headSha = launchContext ? launchContext.headSha : await currentHeadSha();
        const branchLabel = launchContext ? launchContext.branchLabel : getBranchLabel();
        // Anchor the shelf to the launch-time PR too — a cross-project
        // pr-switch must not file PR A's guide under B's repository.
        const repoKey = existingId?.repoKey
          ?? (pr?.url ? deriveGuideRepoKeyFromPRUrl(pr.url) : null)
          ?? (await resolveRepoKey());
        const id = existingId?.id ?? makeGuideId(guide.title);
        // A re-save rewrites the whole file: carry the stored share link (the
        // only copy of its delete token) and, absent a fresh launch review,
        // the stored review over.
        const previous = existingId ? loadGuide(existingId.repoKey, existingId.id) : null;
        // Patch first, then the envelope that references it — never the reverse.
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
        // Persistence must never break job completion.
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
