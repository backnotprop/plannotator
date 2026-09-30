/** Durable viewed state, independent of annotation drafts and server lifetimes. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDiffToFiles } from "@plannotator/core/diff-files";
import { getPlannotatorDataDir } from "./data-dir";
import { parseWorktreeDiffType, type ReviewGitRuntime } from "./review-core";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export interface ReviewProgressSnapshot {
  key: string;
  fingerprints: Record<string, string>;
}

interface ViewedRecord {
  v: 1;
  path: string;
  fingerprint: string;
  viewed: boolean;
  suppressed: boolean;
}

/** Local Git uses the generation-time sidecar, including metadata-only changes.
 * Platform patches have no sidecar: text hunks can use an exact patch hash,
 * but opaque binary/metadata-only patches cannot prove unchanged content.
 */
export function reviewFileFingerprints(patch: string, identities?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const file of parseDiffToFiles(patch)) {
    if (identities) {
      if (Object.hasOwn(identities, file.path)) result[file.path] = hash(identities[file.path]);
      continue;
    }
    const header = file.patch.split(/^(?:@@|--- |Binary files |GIT binary patch)/m)[0];
    const index = header.match(/^index ([a-f0-9]{40}|[a-f0-9]{64})\.\.([a-f0-9]{40}|[a-f0-9]{64})(?: (\d+))?$/m);
    const modes = header.split("\n").filter(line => /^(?:old mode|new mode|new file mode|deleted file mode) /.test(line));
    // An opaque binary stub without IDs cannot prove that its bytes stayed the
    // same. It may be marked for this session, but must not restore as viewed.
    if (!index && !/^@@ /m.test(file.patch)) continue;
    result[file.path] = hash(JSON.stringify(index
      ? [file.path, file.oldPath, index[1], index[2], index[3], modes]
      : [file.path, file.patch]));
  }
  return result;
}

export interface ReviewProgressInput {
  patch: string;
  fileIdentities?: Record<string, string>;
  diffType: string;
  base: string;
  cwd?: string;
  vcsType?: string;
  prUrl?: string;
  prScope?: string;
  workspaceRoot?: string;
}

/** Resolve identity once per snapshot; a new commit must not create a new key. */
export async function captureReviewProgress(
  input: ReviewProgressInput,
  runGit: ReviewGitRuntime["runGit"],
): Promise<ReviewProgressSnapshot | null> {
  const fingerprints = reviewFileFingerprints(input.patch, input.fileIdentities);
  let identity: unknown;
  if (input.prUrl) {
    identity = ["pr", input.prUrl, input.prScope ?? "layer"];
  } else if (input.cwd && !input.workspaceRoot && (!input.vcsType || input.vcsType === "git")) {
    // Local reviews without generation-time identities retain the draft path.
    if (!input.fileIdentities) return null;
    identity = await localGitReviewIdentity(input, runGit);
    if (!identity) return null;
  } else {
    // Piped patches and other VCS/workspace modes keep their existing draft UX.
    return null;
  }
  return { key: hash(JSON.stringify(identity)), fingerprints };
}

/** Shared identity for local drafts and viewed progress, independent of either
 * feature's settings. Capture alongside the patch, never on a draft write:
 * the working directory may have changed branches since the review opened. */
export async function localGitReviewIdentity(
  input: Pick<ReviewProgressInput, "cwd" | "vcsType" | "workspaceRoot" | "prUrl" | "diffType" | "base">,
  runGit: ReviewGitRuntime["runGit"],
): Promise<unknown[] | null> {
  if (!input.cwd || input.prUrl || input.workspaceRoot || (input.vcsType && input.vcsType !== "git")) return null;
  const worktree = parseWorktreeDiffType(input.diffType);
  const diffType = worktree?.subType ?? input.diffType;
  const cwd = worktree?.path ?? input.cwd;
  const scope = [diffType, ["since-base", "branch", "merge-base"].includes(diffType) ? input.base : null];
  try {
    const [root, branch] = await Promise.all([
      runGit(["rev-parse", "--show-toplevel"], { cwd }),
      runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd }),
    ]);
    if (root.exitCode !== 0 || !root.stdout.trim()) return null;
    // Detached checkouts have no durable branch identity.
    const head = branch.exitCode === 0 ? branch : await runGit(["rev-parse", "HEAD"], { cwd });
    if (head.exitCode !== 0 || !head.stdout.trim()) return null;
    return ["git", canonicalPath(root.stdout.trim()), head.stdout.trim(), scope];
  } catch {
    return null;
  }
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function recordPath(snapshot: ReviewProgressSnapshot, path: string): string {
  return join(getPlannotatorDataDir(), "review-progress", snapshot.key, `${hash(path)}.json`);
}

export function loadReviewProgress(snapshot: ReviewProgressSnapshot, platformViewed: string[] = []) {
  const viewedFiles: string[] = [];
  const suppressedFiles: string[] = [];
  const platform = new Set(platformViewed);
  for (const [path, fingerprint] of Object.entries(snapshot.fingerprints)) {
    let record: ViewedRecord | undefined;
    try {
      const value = JSON.parse(readFileSync(recordPath(snapshot, path), "utf8"));
      if (value?.v === 1 && value.path === path && typeof value.fingerprint === "string"
        && typeof value.viewed === "boolean" && typeof value.suppressed === "boolean") record = value;
    } catch { /* Missing/corrupt progress is unreviewed, never a review blocker. */ }
    if (record) {
      if (record.fingerprint === fingerprint) {
        if (record.viewed) viewedFiles.push(path);
        if (record.suppressed) suppressedFiles.push(path);
      }
    } else if (platform.has(path)) {
      viewedFiles.push(path);
    }
  }
  return { viewedFiles, suppressedFiles };
}

export interface ReviewProgressChange {
  path: string;
  fingerprint: string;
  viewed: boolean;
}

export function validReviewProgressChanges(value: unknown, snapshot: ReviewProgressSnapshot): value is ReviewProgressChange[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 5000 && value.every(change =>
    change && typeof change.path === "string" && typeof change.fingerprint === "string"
    && typeof change.viewed === "boolean"
    && Object.hasOwn(snapshot.fingerprints, change.path)
    && snapshot.fingerprints[change.path] === change.fingerprint);
}

/** One atomic record per file: independent tabs/processes cannot clobber each
 * other's unrelated marks through a whole-review read/modify/write race.
 * Explicit false records override GitHub's potentially stale viewed seed.
 */
export function saveReviewProgress(snapshot: ReviewProgressSnapshot, changes: ReviewProgressChange[]): void {
  for (const change of changes) {
    const file = recordPath(snapshot, change.path);
    const tmp = `${file}.${randomUUID()}.tmp`;
    mkdirSync(join(getPlannotatorDataDir(), "review-progress", snapshot.key), { recursive: true });
    try {
      const record: ViewedRecord = {
        v: 1, path: change.path, fingerprint: change.fingerprint,
        viewed: change.viewed, suppressed: !change.viewed,
      };
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      renameSync(tmp, file);
    } finally {
      try { unlinkSync(tmp); } catch { /* Renamed successfully. */ }
    }
  }
}

/** Both HTTP runtimes use the same snapshot/validation boundary. */
export async function handleReviewProgress(input: {
  method: string;
  snapshotId: string | null;
  currentSnapshotId: () => string;
  progress: Promise<ReviewProgressSnapshot | null>;
  currentProgress: () => Promise<ReviewProgressSnapshot | null>;
  body?: unknown;
  platformViewed?: string[];
}): Promise<{ status: number; body: object }> {
  if (input.method !== "GET" && input.method !== "POST") return { status: 405, body: { error: "Method not allowed" } };
  const snapshot = await input.progress;
  if (!input.snapshotId || input.snapshotId !== input.currentSnapshotId() || input.progress !== input.currentProgress()) {
    return { status: 409, body: { error: "Review snapshot changed" } };
  }
  if (!snapshot) return { status: 200, body: { available: false } };
  if (input.method === "GET") {
    return { status: 200, body: { available: true, key: snapshot.key, fingerprints: snapshot.fingerprints, ...loadReviewProgress(snapshot, input.platformViewed) } };
  }
  const body = input.body as { key?: unknown; changes?: unknown } | null;
  if (body?.key !== snapshot.key || !validReviewProgressChanges(body?.changes, snapshot)) {
    return { status: 400, body: { error: "Invalid viewed-file update" } };
  }
  try {
    saveReviewProgress(snapshot, body.changes);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    console.error("[plannotator] Could not save review progress:", error);
    return { status: 500, body: { error: "Could not save review progress" } };
  }
}
