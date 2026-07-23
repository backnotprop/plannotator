import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import type { CodeGuideOutput, GuideLaunchSettings } from "@plannotator/shared/guide";
import { parseRemoteHost, parseRemoteUrl } from "@plannotator/shared/repo";
import type { PRMetadata } from "@plannotator/shared/pr-types";
import type { ReviewGitRuntime } from "@plannotator/shared/review-core";

export type GuideTarget =
  | { kind: "pr"; repository: string; number: number }
  | { kind: "branch"; repository: string; branch: string };

export interface GuidePersistenceContext {
  /** Primary review target followed by any reliable aliases, such as a PR's head branch. */
  targets: GuideTarget[];
  /** PR head SHA or local HEAD at generation time. */
  revision: string;
  /** Stable hash of the exact patch used to generate the guide. */
  fingerprint: string;
}

export interface PersistedGuide {
  version: 1;
  id: string;
  context: GuidePersistenceContext;
  generatedAt: number;
  engine?: string;
  launch?: GuideLaunchSettings;
  guide: CodeGuideOutput;
  reviewed: boolean[];
}

export interface CurrentPersistedGuide {
  record: PersistedGuide;
  outdated: boolean;
}

export interface GuideStore {
  readCurrent(context: GuidePersistenceContext): CurrentPersistedGuide | null;
  write(record: PersistedGuide): void;
}

export function normalizeRepositoryIdentity(host: string, repositoryPath: string): string | null {
  const normalizedHost = host.trim().toLowerCase();
  const normalizedPath = repositoryPath
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (!normalizedHost || !normalizedPath) return null;
  return `${normalizedHost}/${normalizedPath}`;
}

export function hashGuideChangeset(patch: string): string {
  return createHash("sha256").update(patch).digest("hex");
}

export function createPRGuidePersistenceContext(
  metadata: PRMetadata,
  patch: string,
): GuidePersistenceContext | null {
  const basePath = metadata.platform === "github"
    ? `${metadata.owner}/${metadata.repo}`
    : metadata.projectPath;
  const baseRepository = normalizeRepositoryIdentity(metadata.host, basePath);
  if (!baseRepository || !metadata.headSha) return null;

  const targets: GuideTarget[] = [{
    kind: "pr",
    repository: baseRepository,
    number: metadata.platform === "github" ? metadata.number : metadata.iid,
  }];
  const headPath = metadata.platform === "github"
    ? metadata.headRepository
    : metadata.headProjectPath;
  if (headPath) {
    const headRepository = normalizeRepositoryIdentity(metadata.host, headPath);
    if (headRepository && metadata.headBranch) {
      targets.push({ kind: "branch", repository: headRepository, branch: metadata.headBranch });
    }
  }

  return {
    targets,
    revision: metadata.headSha,
    fingerprint: hashGuideChangeset(patch),
  };
}

export function createBranchGuidePersistenceContext(
  repository: string,
  branch: string,
  revision: string,
  patch: string,
): GuidePersistenceContext | null {
  if (!repository || !branch || !revision || branch === "HEAD") return null;
  return {
    targets: [{ kind: "branch", repository, branch }],
    revision,
    fingerprint: hashGuideChangeset(patch),
  };
}

function repositoryFromRemote(remoteUrl: string): string | null {
  let host: string | null = null;
  try {
    host = new URL(remoteUrl).host || null;
  } catch {
    host = parseRemoteHost(remoteUrl);
  }
  const repositoryPath = parseRemoteUrl(remoteUrl);
  return host && repositoryPath
    ? normalizeRepositoryIdentity(host, repositoryPath)
    : null;
}

/** Resolve a local Git branch without ever conflating similarly-named branches across repositories. */
export async function resolveLocalGuidePersistenceContext(
  runtime: ReviewGitRuntime,
  cwd: string,
  patch: string,
): Promise<GuidePersistenceContext | null> {
  const options = { cwd, interaction: "forbid" as const };
  const [branchResult, revisionResult] = await Promise.all([
    runtime.runGit(["branch", "--show-current"], options),
    runtime.runGit(["rev-parse", "HEAD"], options),
  ]);
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "";
  const revision = revisionResult.exitCode === 0 ? revisionResult.stdout.trim() : "";
  if (!branch || !revision) return null;

  let repository: string | null = null;
  const trackedRemote = await runtime.runGit(
    ["for-each-ref", "--format=%(upstream:remotename)", `refs/heads/${branch}`],
    options,
  );
  const trackedRemoteName = trackedRemote.exitCode === 0 ? trackedRemote.stdout.trim() : "";
  if (trackedRemoteName && trackedRemoteName !== ".") {
    const trackedRemoteUrl = await runtime.runGit(["remote", "get-url", trackedRemoteName], options);
    if (trackedRemoteUrl.exitCode === 0) repository = repositoryFromRemote(trackedRemoteUrl.stdout.trim());
  }

  if (!repository) {
    const origin = await runtime.runGit(["remote", "get-url", "origin"], options);
    if (origin.exitCode === 0) repository = repositoryFromRemote(origin.stdout.trim());
  }

  if (!repository) {
    const remotes = await runtime.runGit(["remote"], options);
    const names = remotes.exitCode === 0
      ? remotes.stdout.split("\n").map((name) => name.trim()).filter(Boolean)
      : [];
    if (names.length === 1) {
      const onlyRemote = await runtime.runGit(["remote", "get-url", names[0]], options);
      if (onlyRemote.exitCode === 0) repository = repositoryFromRemote(onlyRemote.stdout.trim());
    }
  }

  if (!repository) {
    const commonDirectory = await runtime.runGit(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      options,
    );
    if (commonDirectory.exitCode === 0 && commonDirectory.stdout.trim()) {
      repository = `local/${hashGuideChangeset(commonDirectory.stdout.trim())}`;
    }
  }

  return repository
    ? createBranchGuidePersistenceContext(repository, branch, revision, patch)
    : null;
}

function targetKey(target: GuideTarget): string {
  return target.kind === "pr"
    ? `pr\0${target.repository}\0${target.number}`
    : `branch\0${target.repository}\0${target.branch}`;
}

function targetPath(directory: string, target: GuideTarget): string {
  const key = createHash("sha256").update(targetKey(target)).digest("hex");
  return join(directory, `${key}.json`);
}

function sameTarget(left: GuideTarget, right: GuideTarget): boolean {
  if (left.kind !== right.kind || left.repository !== right.repository) return false;
  return left.kind === "pr"
    ? left.number === (right as Extract<GuideTarget, { kind: "pr" }>).number
    : left.branch === (right as Extract<GuideTarget, { kind: "branch" }>).branch;
}

function isTarget(value: unknown): value is GuideTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  if (typeof target.repository !== "string" || !target.repository) return false;
  if (target.kind === "pr") return Number.isInteger(target.number) && Number(target.number) > 0;
  return target.kind === "branch" && typeof target.branch === "string" && target.branch.length > 0;
}

function isGuide(value: unknown): value is CodeGuideOutput {
  if (!value || typeof value !== "object") return false;
  const guide = value as Record<string, unknown>;
  if (typeof guide.title !== "string" || typeof guide.intent !== "string" || !Array.isArray(guide.sections)) {
    return false;
  }
  return guide.sections.every((section) => {
    if (!section || typeof section !== "object") return false;
    const candidate = section as Record<string, unknown>;
    return typeof candidate.title === "string"
      && typeof candidate.overview === "string"
      && Array.isArray(candidate.diffs)
      && candidate.diffs.every((diff) => {
        if (!diff || typeof diff !== "object") return false;
        const ref = diff as Record<string, unknown>;
        return typeof ref.file === "string"
          && (ref.summary === undefined || typeof ref.summary === "string");
      });
  }) && (guide.unplacedFiles === undefined
    || (Array.isArray(guide.unplacedFiles) && guide.unplacedFiles.every((file) => typeof file === "string")));
}

function isLaunchSettings(value: unknown): value is GuideLaunchSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const launch = value as Record<string, unknown>;
  return ["engine", "model", "effort", "reasoningEffort", "thinking"]
    .every((key) => launch[key] === undefined || typeof launch[key] === "string")
    && (launch.fastMode === undefined || typeof launch.fastMode === "boolean");
}

function parseRecord(text: string): PersistedGuide | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.version !== 1
      || typeof value.id !== "string"
      || !value.id
      || typeof value.generatedAt !== "number"
      || !Number.isFinite(value.generatedAt)
      || !value.context
      || typeof value.context !== "object"
      || !isGuide(value.guide)
      || !Array.isArray(value.reviewed)
      || !value.reviewed.every((item) => typeof item === "boolean")) {
      return null;
    }
    const context = value.context as Record<string, unknown>;
    if (!Array.isArray(context.targets)
      || context.targets.length === 0
      || !context.targets.every(isTarget)
      || typeof context.revision !== "string"
      || typeof context.fingerprint !== "string") {
      return null;
    }
    if (value.engine !== undefined && typeof value.engine !== "string") return null;
    if (value.launch !== undefined && !isLaunchSettings(value.launch)) return null;
    return value as unknown as PersistedGuide;
  } catch {
    return null;
  }
}

function uniqueTargets(targets: GuideTarget[]): GuideTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = targetKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createGuideStore(directory = join(getPlannotatorDataDir(), "guides")): GuideStore {
  return {
    readCurrent(context) {
      let newest: PersistedGuide | null = null;
      for (const target of uniqueTargets(context.targets)) {
        let record: PersistedGuide | null = null;
        try {
          record = parseRecord(readFileSync(targetPath(directory, target), "utf8"));
        } catch {
          // A missing, unreadable, or invalid artifact behaves like no saved guide.
        }
        if (!record || !record.context.targets.some((storedTarget) => sameTarget(storedTarget, target))) continue;
        if (!newest || record.generatedAt >= newest.generatedAt) newest = record;
      }
      if (!newest) return null;
      return {
        record: newest,
        outdated: newest.context.revision !== context.revision
          || newest.context.fingerprint !== context.fingerprint,
      };
    },

    write(record) {
      const targets = uniqueTargets(record.context.targets);
      if (targets.length === 0) throw new Error("Cannot persist a guide without a target");
      mkdirSync(directory, { recursive: true });
      const text = JSON.stringify(record);
      for (const target of targets) {
        const finalPath = targetPath(directory, target);
        const temporaryPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(temporaryPath, text, "utf8");
        renameSync(temporaryPath, finalPath);
      }
    },
  };
}
