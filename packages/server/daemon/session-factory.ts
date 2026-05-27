import { existsSync, realpathSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { basename, isAbsolute, relative, resolve } from "path";
import type { DaemonCreateSessionRequest } from "@plannotator/shared/daemon-protocol";
import { parseAnnotateArgs } from "@plannotator/shared/annotate-args";
import { resolveAtReference } from "@plannotator/shared/at-reference";
import { loadConfig, resolveDefaultDiffType, resolveUseJina } from "@plannotator/shared/config";
import { FILE_BROWSER_EXCLUDED } from "@plannotator/shared/reference-common";
import { parseRemoteUrl } from "@plannotator/shared/repo";
import {
  hasMarkdownFiles,
  resolveMarkdownFile,
  resolveUserPath,
} from "@plannotator/shared/resolve-file";
import { parseReviewArgs } from "@plannotator/shared/review-args";
import { htmlToMarkdown } from "@plannotator/shared/html-to-markdown";
import { isConvertedSource, urlToMarkdown } from "@plannotator/shared/url-to-markdown";
import { createWorktree, ensureObjectAvailable, fetchRef } from "@plannotator/shared/worktree";
import { createWorktreePool, type WorktreePool } from "@plannotator/shared/worktree-pool";
import type {
  PluginAnnotateRequest,
  PluginGoalSetupRequest,
  PluginPlanRequest,
  PluginReviewRequest,
} from "@plannotator/shared/plugin-protocol";
import { normalizeGoalSetupBundle } from "@plannotator/shared/goal-setup";
import { createPlannotatorSession } from "../index";
import { generateSlug } from "../storage";
import { createAnnotateSession } from "../annotate";
import { createGoalSetupSession } from "../goal-setup";
import { createReviewSession } from "../review";
import { detectProjectName } from "../project";
import { createRemoteShareNotice } from "../share-url";
import { addProject } from "./project-registry";
import {
  gitRuntime,
  prepareLocalReviewDiff,
  type DiffType,
} from "../vcs";
import {
  checkPRAuth,
  fetchPR,
  getCliInstallUrl,
  getCliName,
  getDisplayRepo,
  getMRLabel,
  getMRNumberLabel,
  parsePRUrl,
} from "../pr";
import {
  createDaemonSessionId,
  type DaemonSessionRecord,
} from "./session-store";
import type { DaemonFetchContext } from "./server";
import type { SessionEventBridge } from "../session-handler";

export interface DaemonSessionFactoryOptions {
  sharingEnabled?: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
  ttlMs?: number;
}

const DEFAULT_SESSION_TTL_MS = 96 * 60 * 60 * 1000;
const SESSION_TIMEOUT_GRACE_MS = 60_000;

type AnnotateInput = {
  markdown: string;
  filePath: string;
  mode: "annotate" | "annotate-folder" | "annotate-last";
  folderPath?: string;
  sourceInfo?: string;
  sourceConverted?: boolean;
  gate?: boolean;
  rawHtml?: string;
  renderHtml?: boolean;
};

function getRequestCwd(request: { cwd?: string }): string {
  if (!request.cwd) {
    throw new Error("Daemon session requests must include cwd.");
  }
  return resolve(request.cwd);
}

function makeSessionUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/$/, "")}/s/${encodeURIComponent(id)}`;
}

function createSessionEventBridge(context: DaemonFetchContext, id: string): SessionEventBridge {
  return {
    publishEvent: (family, event) => context.publishSessionEvent(id, family, event),
    registerSnapshotProvider: (family, provider) =>
      context.registerSessionSnapshotProvider(id, family, provider),
  };
}

interface SessionDecisionResult {
  approved?: boolean;
  feedback?: string;
  [key: string]: unknown;
}

function createDecisionScope(dispose: () => void | Promise<void>) {
  let releaseDecisionWait: (() => void) | undefined;
  const disposed = new Promise<never>((_, reject) => {
    releaseDecisionWait = () => reject(new Error("Session disposed."));
  });
  disposed.catch(() => {});
  const cleanup = () => {
    releaseDecisionWait?.();
    releaseDecisionWait = undefined;
    return dispose();
  };
  return { disposed, cleanup };
}

function registerSessionDecision<TResult, TStored = TResult>(
  context: DaemonFetchContext,
  id: string,
  waitForDecision: () => Promise<TResult>,
  dispose: () => void | Promise<void>,
  mapResult: (result: TResult) => TStored = (result) => result as unknown as TStored,
): () => void | Promise<void> {
  const { disposed, cleanup } = createDecisionScope(dispose);

  void Promise.race([waitForDecision(), disposed])
    .then((result) => context.store.complete(id, mapResult(result)))
    .catch((err) => {
      if (context.store.get(id)?.status === "active") {
        context.store.fail(id, err instanceof Error ? err.message : String(err));
      }
    });

  return cleanup;
}

function registerDecisionLoop(
  context: DaemonFetchContext,
  id: string,
  session: { waitForDecision: () => Promise<SessionDecisionResult>; dispose: () => void | Promise<void> },
  onResult: (result: SessionDecisionResult) => "continue" | "done",
  activeStatuses: Set<string>,
): () => void | Promise<void> {
  const { disposed, cleanup } = createDecisionScope(session.dispose);

  const loop = async () => {
    let lastPromise: Promise<SessionDecisionResult> | null = null;
    while (true) {
      const currentPromise = session.waitForDecision();
      if (currentPromise === lastPromise) return;
      lastPromise = currentPromise;
      const result = await Promise.race([currentPromise, disposed]);
      if (onResult(result) === "done") return;
    }
  };

  void loop().catch((err) => {
    const record = context.store.get(id);
    if (record && activeStatuses.has(record.status)) {
      context.store.fail(id, err instanceof Error ? err.message : String(err));
    }
  });

  return cleanup;
}

const PERSISTENT_ACTIVE = new Set(["active", "awaiting-resubmission"]);
const REVIEW_ACTIVE = new Set(["active", "idle"]);

function registerPersistentDecision(
  context: DaemonFetchContext,
  id: string,
  session: { waitForDecision: () => Promise<SessionDecisionResult>; dispose: () => void | Promise<void> },
) {
  return registerDecisionLoop(context, id, session, (result) => {
    context.store.suspend(id, result);
    return "continue";
  }, PERSISTENT_ACTIVE);
}

// Review sessions stay alive (idle) after every decision — including approve/exit.
// Sessions persist until daemon restart.
function registerReviewDecision(
  context: DaemonFetchContext,
  id: string,
  session: { waitForDecision: () => Promise<SessionDecisionResult>; dispose: () => void | Promise<void> },
) {
  return registerDecisionLoop(context, id, session, (result) => {
    context.store.idle(id, result);
    return "continue";
  }, REVIEW_ACTIVE);
}

function resolvePlanFilePath(planFilePath: string, cwd: string): string {
  const requestedPath = isAbsolute(planFilePath)
    ? planFilePath
    : resolve(cwd, planFilePath);
  const cwdReal = realpathSync(cwd);
  const planReal = realpathSync(requestedPath);
  const relativePath = relative(cwdReal, planReal);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Plugin plan file must resolve inside cwd.");
  }
  if (!/\.(?:md|mdx)$/i.test(planReal)) {
    throw new Error("Plugin plan file must be a markdown file (.md or .mdx).");
  }
  return planReal;
}

async function readPlanRequest(request: PluginPlanRequest, cwd: string): Promise<string> {
  if (typeof request.plan === "string" && request.plan.trim()) return request.plan;
  if (!request.planFilePath) {
    throw new Error("Plugin plan requests must include a non-empty plan or planFilePath.");
  }
  const planPath = resolvePlanFilePath(request.planFilePath, cwd);
  const plan = await Bun.file(planPath).text();
  if (!plan.trim()) {
    throw new Error("Plugin plan requests must include a non-empty plan or planFilePath.");
  }
  return plan;
}

async function runProcess(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrStream = proc.stderr;
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    stderrStream ? new Response(stderrStream).text() : Promise.resolve(""),
  ]);
  return { exitCode, stderr: stderr.trim() };
}

async function resolveAnnotateInput(
  request: PluginAnnotateRequest,
  cwd: string,
  defaultMode: "annotate" | "annotate-last" = "annotate",
): Promise<AnnotateInput> {
  const directMarkdown = typeof request.markdown === "string";
  const hasRawArgs = typeof request.args === "string";
  const parsedArgs = hasRawArgs ? parseAnnotateArgs(request.args ?? "") : undefined;
  const structuredFilePath = typeof request.filePath === "string" ? request.filePath : "";
  const gate = request.gate ?? parsedArgs?.gate ?? false;
  const renderHtml = request.renderHtml ?? (typeof request.rawHtml === "string" ? true : parsedArgs?.renderHtml ?? false);

  let markdown = directMarkdown ? request.markdown! : "";
  let rawHtml = request.rawHtml;
  let filePath = structuredFilePath.trim().length > 0 ? structuredFilePath : "";
  let folderPath = request.folderPath;
  let mode: "annotate" | "annotate-folder" | "annotate-last" = request.mode ?? defaultMode;
  let sourceInfo = request.sourceInfo;
  let sourceConverted = request.sourceConverted ?? false;

  if (folderPath) {
    const resolvedFolder = isAbsolute(folderPath) ? folderPath : resolveUserPath(folderPath, cwd);
    folderPath = resolvedFolder;
    filePath = resolvedFolder;
    markdown = directMarkdown ? markdown : "";
    mode = "annotate-folder";
  } else if (!directMarkdown && typeof rawHtml !== "string") {
    const rawFilePath = parsedArgs?.rawFilePath || structuredFilePath;
    if (!rawFilePath) {
      throw new Error("Plugin annotate requests must include args, markdown, filePath, folderPath, or rawHtml.");
    }

    const parsedFilePath = parsedArgs?.filePath || structuredFilePath;
    const isUrl = /^https?:\/\//i.test(parsedFilePath);

    if (isUrl) {
      const result = await urlToMarkdown(parsedFilePath, {
        useJina: request.useJina ?? resolveUseJina(request.noJina === true, loadConfig()),
        jinaApiKey: request.jinaApiKey,
      });
      markdown = result.markdown;
      sourceConverted = isConvertedSource(result.source);
      filePath = parsedFilePath;
      sourceInfo = parsedFilePath;
    } else {
      const folderCandidate = resolveAtReference(rawFilePath, (candidate) => {
        try {
          return statSync(resolveUserPath(candidate, cwd)).isDirectory();
        } catch {
          return false;
        }
      });

      if (folderCandidate !== null) {
        const resolvedTarget = resolveUserPath(folderCandidate, cwd);
        if (!hasMarkdownFiles(resolvedTarget, FILE_BROWSER_EXCLUDED, /\.(mdx?|html?)$/i)) {
          throw new Error(`No markdown or HTML files found in ${resolvedTarget}`);
        }
        folderPath = resolvedTarget;
        filePath = resolvedTarget;
        markdown = "";
        mode = "annotate-folder";
      } else {
        const htmlCandidate = resolveAtReference(rawFilePath, (candidate) => {
          const resolved = resolveUserPath(candidate, cwd);
          return /\.html?$/i.test(resolved) && existsSync(resolved);
        });

        if (htmlCandidate !== null) {
          const resolvedTarget = resolveUserPath(htmlCandidate, cwd);
          const htmlFile = Bun.file(resolvedTarget);
          if (htmlFile.size > 10 * 1024 * 1024) {
            throw new Error(`File too large (${Math.round(htmlFile.size / 1024 / 1024)}MB, max 10MB): ${resolvedTarget}`);
          }
          const html = await htmlFile.text();
          if (renderHtml) {
            rawHtml = html;
            markdown = "";
          } else {
            markdown = htmlToMarkdown(html);
            sourceConverted = true;
          }
          filePath = resolvedTarget;
          sourceInfo = basename(resolvedTarget);
        } else {
          let resolved = resolveMarkdownFile(parsedFilePath, cwd);
          if (resolved.kind === "not_found" && rawFilePath !== parsedFilePath) {
            resolved = resolveMarkdownFile(rawFilePath, cwd);
          }
          if (resolved.kind === "ambiguous") {
            throw new Error(`Ambiguous filename "${resolved.input}" found ${resolved.matches.length} matches.`);
          }
          if (resolved.kind === "not_found" || resolved.kind === "unavailable") {
            throw new Error(`File not found: ${resolved.input}`);
          }
          filePath = resolved.path;
          markdown = await Bun.file(filePath).text();
        }
      }
    }
  }

  if (!filePath) filePath = mode === "annotate-last" ? "last-message" : "document";
  return {
    markdown,
    filePath,
    mode,
    ...(folderPath && { folderPath }),
    ...(sourceInfo && { sourceInfo }),
    sourceConverted,
    gate,
    ...(rawHtml !== undefined && { rawHtml }),
    renderHtml,
  };
}

async function prepareReviewInput(request: PluginReviewRequest, cwd: string) {
  const reviewArgs = parseReviewArgs(request.args ?? "");
  const urlArg = request.prUrl ?? reviewArgs.prUrl;

  let rawPatch: string;
  let gitRef: string;
  let error: string | undefined;
  let gitContext: Awaited<ReturnType<typeof prepareLocalReviewDiff>>["gitContext"] | undefined;
  let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;
  let diffType: DiffType | undefined;
  let base: string | undefined;
  let agentCwd: string | undefined;
  let worktreePool: WorktreePool | undefined;
  let onCleanup: (() => void | Promise<void>) | undefined;
  let localWarning: string | undefined;

  if (urlArg) {
    const prRef = parsePRUrl(urlArg);
    if (!prRef) {
      throw new Error(`Invalid PR/MR URL: ${urlArg}`);
    }

    try {
      await checkPRAuth(prRef);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("ENOENT")) {
        const cliName = getCliName(prRef);
        const cliUrl = getCliInstallUrl(prRef);
        throw new Error(`${cliName === "gh" ? "GitHub" : "GitLab"} CLI (${cliName}) is not installed. Install it from ${cliUrl}`);
      }
      throw err;
    }

    const pr = await fetchPR(prRef);
    rawPatch = pr.rawPatch;
    gitRef = `${getMRLabel(prRef)} ${getMRNumberLabel(prRef)}`;
    prMetadata = pr.metadata;

    const useLocal = request.useLocal ?? reviewArgs.useLocal;
    if (useLocal && prMetadata) {
      let localPath: string | undefined;
      let sessionDir: string | undefined;
      try {
        const repoDir = cwd;
        const identifier = prMetadata.platform === "github"
          ? `${prMetadata.owner}-${prMetadata.repo}-${prMetadata.number}`
          : `${prMetadata.projectPath.replace(/\//g, "-")}-${prMetadata.iid}`;
        const suffix = Math.random().toString(36).slice(2, 8);
        sessionDir = resolve(realpathSync(tmpdir()), `plannotator-pr-${identifier}-${suffix}`);
        const prNumber = prMetadata.platform === "github" ? prMetadata.number : prMetadata.iid;
        localPath = resolve(sessionDir, "pool", `pr-${prNumber}`);
        const fetchRefStr = prMetadata.platform === "github"
          ? `refs/pull/${prMetadata.number}/head`
          : `refs/merge-requests/${prMetadata.iid}/head`;

        if (prMetadata.baseBranch.includes("..") || prMetadata.baseBranch.startsWith("-")) {
          throw new Error(`Invalid base branch: ${prMetadata.baseBranch}`);
        }
        if (!/^[0-9a-f]{40,64}$/i.test(prMetadata.baseSha)) {
          throw new Error(`Invalid base SHA: ${prMetadata.baseSha}`);
        }

        let isSameRepo = false;
        try {
          const remoteResult = await gitRuntime.runGit(["remote", "get-url", "origin"], { cwd: repoDir });
          if (remoteResult.exitCode === 0) {
            const remoteUrl = remoteResult.stdout.trim();
            const currentRepo = parseRemoteUrl(remoteUrl);
            const prRepo = prMetadata.platform === "github"
              ? `${prMetadata.owner}/${prMetadata.repo}`
              : prMetadata.projectPath;
            const repoMatches = !!currentRepo && currentRepo.toLowerCase() === prRepo.toLowerCase();
            const sshHost = remoteUrl.match(/^[^@]+@([^:]+):/)?.[1];
            const httpsHost = (() => { try { return new URL(remoteUrl).hostname; } catch { return null; } })();
            const remoteHost = (sshHost || httpsHost || "").toLowerCase();
            const prHost = prMetadata.host.toLowerCase();
            isSameRepo = repoMatches && remoteHost === prHost;
          }
        } catch {}

        if (isSameRepo) {
          await fetchRef(gitRuntime, prMetadata.baseBranch, { cwd: repoDir });
          await ensureObjectAvailable(gitRuntime, prMetadata.baseSha, { cwd: repoDir });
          await fetchRef(gitRuntime, fetchRefStr, { cwd: repoDir });
          await createWorktree(gitRuntime, {
            ref: "FETCH_HEAD",
            path: localPath,
            detach: true,
            cwd: repoDir,
          });
          onCleanup = async () => {
            try {
              if (worktreePool) await worktreePool.cleanup(gitRuntime);
            } catch {}
            try { rmSync(sessionDir!, { recursive: true, force: true }); } catch {}
          };
        } else {
          const prRepo = prMetadata.platform === "github"
            ? `${prMetadata.owner}/${prMetadata.repo}`
            : prMetadata.projectPath;
          if (/^-/.test(prRepo)) throw new Error(`Invalid repository identifier: ${prRepo}`);
          const cli = prMetadata.platform === "github" ? "gh" : "glab";
          const host = prMetadata.host;
          const isDefaultHost = host === "github.com" || host === "gitlab.com";
          const cloneEnv = isDefaultHost ? undefined : {
            ...process.env,
            ...(prMetadata.platform === "github" ? { GH_HOST: host } : { GITLAB_HOST: host }),
          };

          const cloneResult = await runProcess(
            [cli, "repo", "clone", prRepo, localPath, "--", "--depth=1", "--no-checkout"],
            { env: cloneEnv },
          );
          if (cloneResult.exitCode !== 0) {
            throw new Error(`${cli} repo clone failed: ${cloneResult.stderr}`);
          }

          const fetchResult = await runProcess(
            ["git", "fetch", "--depth=200", "origin", fetchRefStr],
            { cwd: localPath },
          );
          if (fetchResult.exitCode !== 0) {
            throw new Error(`Failed to fetch PR head ref: ${fetchResult.stderr}`);
          }

          const checkoutResult = await runProcess(["git", "checkout", "FETCH_HEAD"], { cwd: localPath });
          if (checkoutResult.exitCode !== 0) {
            throw new Error(`git checkout FETCH_HEAD failed: ${checkoutResult.stderr}`);
          }

          const baseFetch = await runProcess(["git", "fetch", "--depth=200", "origin", prMetadata.baseSha], { cwd: localPath });
          if (baseFetch.exitCode !== 0) console.error("Warning: failed to fetch baseSha, agent diffs may be inaccurate");
          await runProcess(["git", "branch", "--", prMetadata.baseBranch, prMetadata.baseSha], { cwd: localPath });
          await runProcess(["git", "update-ref", `refs/remotes/origin/${prMetadata.baseBranch}`, prMetadata.baseSha], { cwd: localPath });
          onCleanup = () => { try { rmSync(sessionDir!, { recursive: true, force: true }); } catch {} };
        }

        agentCwd = localPath;
        if (isSameRepo) {
          worktreePool = createWorktreePool(
            { sessionDir, repoDir, isSameRepo },
            { path: localPath, prUrl: prMetadata.url, number: prNumber, ready: true },
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        localWarning = `Warning: --local checkout failed; using the remote diff instead.\n${message}`;
        console.error(localWarning);
        if (sessionDir) try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        agentCwd = undefined;
        worktreePool = undefined;
        onCleanup = undefined;
      }
    }

    return {
      rawPatch,
      gitRef,
      error,
      gitContext,
      prMetadata,
      diffType,
      base,
      agentCwd,
      worktreePool,
      onCleanup,
      localWarning,
    };
  }

  const config = loadConfig();
  const diffResult = await prepareLocalReviewDiff({
    cwd,
    vcsType: request.vcsType ?? reviewArgs.vcsType,
    requestedDiffType: request.diffType as DiffType | undefined,
    requestedBase: request.defaultBranch,
    configuredDiffType: resolveDefaultDiffType(config),
    hideWhitespace: config.diffOptions?.hideWhitespace ?? false,
  });
  return {
    rawPatch: diffResult.rawPatch,
    gitRef: diffResult.gitRef,
    error: diffResult.error,
    gitContext: diffResult.gitContext,
    diffType: diffResult.diffType,
    base: diffResult.base,
    prMetadata,
    agentCwd,
    worktreePool,
    onCleanup,
    localWarning,
  };
}

export function createDaemonSessionFactory(options: DaemonSessionFactoryOptions) {
  interface PersistableSession {
    waitForDecision: () => Promise<SessionDecisionResult>;
    dispose: () => void | Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateContent?: (...args: any[]) => void | Promise<void>;
  }
  const sessionRefs = new Map<string, { matchKey: string; session: PersistableSession }>();

  const RESUBMIT_STATUSES = new Set(["awaiting-resubmission"]);
  const RESUBMIT_OR_IDLE_STATUSES = new Set(["awaiting-resubmission", "idle"]);

  function findMatchingSession(store: DaemonFetchContext["store"], matchKey: string, matchStatuses = RESUBMIT_STATUSES) {
    for (const [sessionId, ref] of sessionRefs) {
      const record = store.get(sessionId);
      if (!record || record.status === "completed" || record.status === "expired" || record.status === "failed" || record.status === "cancelled") {
        sessionRefs.delete(sessionId);
        continue;
      }
      if (!matchStatuses.has(record.status)) continue;
      if (record.matchKey !== matchKey) continue;
      return { record, session: ref.session };
    }
    return null;
  }

  return async function createSession(
    createRequest: DaemonCreateSessionRequest,
    context: DaemonFetchContext,
  ): Promise<DaemonSessionRecord> {
    const request = createRequest.request;
    const cwd = getRequestCwd(request);
    const project = (await detectProjectName(cwd)) ?? "_unknown";
    let branch: string | undefined;
    try {
      const { execSync } = await import("child_process");
      const b = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim();
      if (b && b !== "HEAD") branch = b;
    } catch {}
    try {
      const tmp = tmpdir();
      if (!cwd.startsWith(tmp)) addProject(cwd, project);
    } catch {}
    const id = createDaemonSessionId();
    const url = makeSessionUrl(context.endpoint.baseUrl, id);
    const ttlMs = request.timeoutMs === null
      ? undefined
      : request.timeoutMs !== undefined
        ? request.timeoutMs + SESSION_TIMEOUT_GRACE_MS
        : options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    const sharingEnabled = request.sharingEnabled ?? options.sharingEnabled ?? true;
    const shareBaseUrl = request.shareBaseUrl ?? options.shareBaseUrl;
    const pasteApiUrl = request.pasteApiUrl ?? options.pasteApiUrl;
    const sessionEvents = createSessionEventBridge(context, id);

    if (request.action === "plan") {
      const plan = await readPlanRequest(request, cwd);
      const matchKey = `plan:${project}:${generateSlug(plan)}`;

      const existing = findMatchingSession(context.store, matchKey);
      if (existing && existing.session.updateContent) {
        existing.session.updateContent(plan);
        if (context.endpoint.isRemote && sharingEnabled) {
          existing.record.remoteShare = await createRemoteShareNotice(plan, shareBaseUrl, "review the plan", "plan only").catch(() => undefined);
        }
        context.store.reactivate(existing.record.id);
        return existing.record;
      }

      const remoteShare = context.endpoint.isRemote && sharingEnabled
        ? await createRemoteShareNotice(plan, shareBaseUrl, "review the plan", "plan only").catch(() => undefined)
        : undefined;
      const session = await createPlannotatorSession({
        cwd,
        plan,
        origin: request.origin,
        permissionMode: request.permissionMode,
        sharingEnabled,
        shareBaseUrl,
        pasteApiUrl,
        sessionEvents,
        opencodeClient: request.availableAgents
          ? { app: { agents: async () => ({ data: request.availableAgents }) } }
          : undefined,
      });
      const record = context.store.create({
        id,
        mode: "plan",
        url,
        project,
        cwd,
        label: branch ? `plugin-plan-${request.origin}-${project}-${branch}` : `plugin-plan-${request.origin}-${project}`,
        origin: request.origin,
        matchKey,
        ttlMs,
        handleRequest: session.handleRequest,
        dispose: registerPersistentDecision(context, id, session),
        remoteShare,
        snapshot: session.getSnapshot ?? (() => ({ plan, origin: request.origin })),
      });
      sessionRefs.set(id, { matchKey, session });
      return record;
    }

    if (request.action === "annotate" || request.action === "annotate-last") {
      const input = await resolveAnnotateInput(request, cwd, request.action);
      const isSingleFile = input.mode === "annotate";
      const isFolder = input.mode === "annotate-folder";
      const matchKey = isSingleFile
        ? `annotate:${project}:${input.filePath}`
        : isFolder && input.folderPath
          ? `annotate:${project}:folder:${input.folderPath}`
          : undefined;

      if (matchKey) {
        const existing = findMatchingSession(context.store, matchKey);
        if (existing) {
          if (existing.session.updateContent) {
            existing.session.updateContent(input.markdown, input.rawHtml);
          }
          if (context.endpoint.isRemote && sharingEnabled && input.markdown) {
            existing.record.remoteShare = await createRemoteShareNotice(input.markdown, shareBaseUrl, "annotate", "document only").catch(() => undefined);
          }
          context.store.reactivate(existing.record.id);
          return existing.record;
        }
      }

      const remoteShare = context.endpoint.isRemote && sharingEnabled && input.markdown
        ? await createRemoteShareNotice(input.markdown, shareBaseUrl, "annotate", "document only").catch(() => undefined)
        : undefined;
      const session = await createAnnotateSession({
        cwd,
        ...input,
        origin: request.origin,
        sharingEnabled,
        shareBaseUrl,
        pasteApiUrl,
        sessionEvents,
      });
      const record = context.store.create({
        id,
        mode: "annotate",
        url,
        project,
        cwd,
        label: input.folderPath
          ? `plugin-annotate-${request.origin}-${basename(input.folderPath)}${branch ? `-${branch}` : ""}`
          : `plugin-annotate-${request.origin}-${input.mode === "annotate-last" ? "last" : basename(input.filePath)}${branch ? `-${branch}` : ""}`,
        origin: request.origin,
        matchKey,
        ttlMs,
        handleRequest: session.handleRequest,
        dispose: registerPersistentDecision(context, id, session),
        remoteShare,
        snapshot: session.getSnapshot ?? (() => ({ plan: input.markdown, filePath: input.filePath, mode: input.mode, sourceInfo: input.sourceInfo })),
      });
      if (matchKey) sessionRefs.set(id, { matchKey, session });
      return record;
    }

    if (request.action === "review") {
      const input = await prepareReviewInput(request, cwd);
      const reviewMatchKey = input.prMetadata
        ? `review:${input.prMetadata.url}`
        : branch ? `review:${project}:${branch}` : `review:${project}`;

      const existingReview = findMatchingSession(context.store, reviewMatchKey, RESUBMIT_OR_IDLE_STATUSES);
      if (existingReview && existingReview.session.updateContent) {
        await Promise.resolve(input.onCleanup?.()).catch(() => {});
        await existingReview.session.updateContent(
          input.prMetadata ? input.rawPatch : undefined,
          input.prMetadata ? input.gitRef : undefined,
        );
        if (context.endpoint.isRemote && sharingEnabled) {
          existingReview.record.remoteShare = await createRemoteShareNotice(input.rawPatch, shareBaseUrl, "review changes", "diff only").catch(() => undefined);
        }
        context.store.reactivate(existingReview.record.id);
        return existingReview.record;
      }

      const sessionError = [input.error, input.localWarning].filter(Boolean).join("\n\n") || undefined;
      const remoteShare = context.endpoint.isRemote && sharingEnabled
        ? await createRemoteShareNotice(input.rawPatch, shareBaseUrl, "review changes", "diff only").catch(() => undefined)
        : undefined;
      let session: Awaited<ReturnType<typeof createReviewSession>>;
      try {
        session = await createReviewSession({
          cwd,
          rawPatch: input.rawPatch,
          gitRef: input.gitRef,
          error: sessionError,
          origin: request.origin,
          diffType: input.gitContext ? (input.diffType ?? "unstaged") : undefined,
          gitContext: input.gitContext,
          initialBase: input.base,
          prMetadata: input.prMetadata,
          agentCwd: input.agentCwd,
          worktreePool: input.worktreePool,
          sharingEnabled,
          shareBaseUrl,
          sessionEvents,
          opencodeClient: request.availableAgents
            ? { app: { agents: async () => ({ data: request.availableAgents }) } }
            : undefined,
          onCleanup: input.onCleanup,
        });
      } catch (err) {
        await Promise.resolve(input.onCleanup?.()).catch(() => {});
        throw err;
      }
      session.setServerUrl(url);
      const record = context.store.create({
        id,
        mode: "review",
        url,
        project,
        cwd,
        label: input.prMetadata
          ? `plugin-${getMRLabel(input.prMetadata).toLowerCase()}-review-${getDisplayRepo(input.prMetadata)}${getMRNumberLabel(input.prMetadata)}`
          : branch ? `plugin-review-${request.origin}-${project}-${branch}` : `plugin-review-${request.origin}-${project}`,
        origin: request.origin,
        matchKey: reviewMatchKey,
        ttlMs,
        handleRequest: session.handleRequest,
        dispose: registerReviewDecision(context, id, session),
        remoteShare,
        snapshot: session.getSnapshot ?? (() => ({
          rawPatch: input.rawPatch,
          gitRef: input.gitRef,
          origin: request.origin,
          diffType: input.gitContext ? (input.diffType ?? "unstaged") : undefined,
          gitContext: input.gitContext ? { currentBranch: input.gitContext.currentBranch, base: input.base } : undefined,
        })),
      });
      sessionRefs.set(id, { matchKey: reviewMatchKey, session });
      return record;
    }

    if (request.action === "goal-setup") {
      const bundle = normalizeGoalSetupBundle(request.bundle, request.stage);
      const session = await createGoalSetupSession({
        cwd,
        bundle,
        origin: request.origin,
      });
      const record = context.store.create({
        id,
        mode: "goal-setup",
        url,
        project,
        cwd,
        label: branch ? `goal-setup-${bundle.stage}-${request.goalSlug || project}-${branch}` : `goal-setup-${bundle.stage}-${request.goalSlug || project}`,
        origin: request.origin,
        ttlMs,
        handleRequest: session.handleRequest,
        dispose: registerSessionDecision(context, id, () => session.waitForDecision(), () => session.dispose()),
        snapshot: () => ({ stage: bundle.stage, goalSlug: request.goalSlug }),
      });
      return record;
    }

    throw new Error(`Unsupported daemon session action: ${(request as { action?: string }).action}`);
  };
}
