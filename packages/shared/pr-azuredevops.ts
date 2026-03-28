/**
 * Azure DevOps-specific PR provider implementation.
 *
 * Uses the `az` CLI (Azure CLI with azure-devops extension) via the PRRuntime
 * abstraction. Supports both dev.azure.com and legacy visualstudio.com URLs.
 *
 * Auth: `az login` (interactive) or `az devops login` (PAT-based).
 * Diff: fetched via git using the source/target commit SHAs from the PR metadata.
 * File content: fetched via the ADO REST API using `az rest`.
 */

import type { PRRuntime, PRMetadata, PRContext, PRReviewFileComment } from "./pr-provider";

// Azure DevOps-specific PRRef shape (used internally)
interface AdoPRRef {
  platform: "azuredevops";
  orgUrl: string;       // e.g., "https://dev.azure.com/myorg"
  organization: string; // e.g., "myorg"
  project: string;      // e.g., "MyProject"
  repo: string;         // e.g., "MyRepo"
  id: number;           // PR number
}

// --- Helpers ---

/** Build the base ADO REST API URL for a git repository */
function repoApiBase(ref: AdoPRRef): string {
  return `${ref.orgUrl}/${encodeURIComponent(ref.project)}/_apis/git/repositories/${encodeURIComponent(ref.repo)}`;
}

/**
 * Azure DevOps OAuth resource ID.
 * `az rest` defaults to the ARM token — specifying this resource tells it to
 * acquire a token scoped for Azure DevOps instead.
 */
const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

/** Run `az rest` to call the ADO REST API and return parsed JSON */
async function azRest<T>(
  runtime: PRRuntime,
  method: string,
  uri: string,
  body?: string,
): Promise<T> {
  const args = ["rest", "--method", method, "--uri", uri, "--resource", ADO_RESOURCE_ID];
  if (body) {
    args.push("--body", body);
    args.push("--headers", "Content-Type=application/json");
  }

  const result = await runtime.runCommand("az", args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `az rest failed (exit ${result.exitCode})`);
  }

  return JSON.parse(result.stdout) as T;
}

// --- Auth ---

export async function checkAdoAuth(runtime: PRRuntime, orgUrl: string): Promise<void> {
  // Try az account show first (covers az login)
  const accountResult = await runtime.runCommand("az", ["account", "show", "--output", "none"]);
  if (accountResult.exitCode === 0) return;

  // Fall back: try az devops project list as a connectivity check
  const projectResult = await runtime.runCommand("az", [
    "devops", "project", "list",
    "--org", orgUrl,
    "--output", "none",
  ]);
  if (projectResult.exitCode !== 0) {
    throw new Error(
      `Azure DevOps CLI not authenticated. Run \`az login\` or \`az devops login --org ${orgUrl}\`.\n${projectResult.stderr.trim()}`,
    );
  }
}

export async function getAdoUser(runtime: PRRuntime, orgUrl: string): Promise<string | null> {
  try {
    // Try az ad signed-in-user show (works with Entra ID login)
    const result = await runtime.runCommand("az", ["ad", "signed-in-user", "show", "--query", "userPrincipalName", "--output", "tsv"]);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
    // Fallback: az devops user show (PAT-based)
    const devopsResult = await runtime.runCommand("az", [
      "devops", "user", "show",
      "--org", orgUrl,
      "--output", "json",
    ]);
    if (devopsResult.exitCode === 0 && devopsResult.stdout.trim()) {
      const data = JSON.parse(devopsResult.stdout) as { user?: { mailAddress?: string; principalName?: string } };
      return data.user?.mailAddress ?? data.user?.principalName ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

// --- Fetch PR ---

/** Shape of `az repos pr show` JSON output we care about */
interface AdoPRShowResult {
  pullRequestId: number;
  title: string;
  createdBy: { uniqueName?: string; displayName?: string };
  sourceRefName: string;   // "refs/heads/feature"
  targetRefName: string;   // "refs/heads/main"
  lastMergeSourceCommit?: { commitId: string };
  lastMergeTargetCommit?: { commitId: string };
  repository?: { remoteUrl?: string; id?: string };
  remoteUrl?: string;
  status: string;
  isDraft: boolean;
  url: string;
}

/** Strip "refs/heads/" prefix from an ADO ref name */
function stripRefsHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/** Build the browser-facing ADO PR URL from the remote URL and PR id */
function buildPRWebUrl(remoteUrl: string | undefined, orgUrl: string, project: string, repo: string, id: number): string {
  const base = remoteUrl ?? `${orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;
  return `${base}/pullrequest/${id}`;
}

// --- Diff via ADO REST API ---

interface AdoChangeEntry {
  changeType: string; // "add" | "edit" | "delete" | "rename" | "copy" | ...
  item: { path: string; isFolder?: boolean; objectId?: string };
  originalItem?: { path: string; objectId?: string };
}

/** Fetch raw file content from ADO items API at a specific commit SHA */
async function fetchItemContentRaw(
  runtime: PRRuntime,
  base: string,
  filePath: string,
  sha: string,
): Promise<string> {
  const encodedPath = encodeURIComponent(filePath);
  const uri = `${base}/items?path=${encodedPath}&versionDescriptor.version=${sha}&versionDescriptor.versionType=commit&api-version=7.1&$format=text`;
  const result = await runtime.runCommand("az", ["rest", "--method", "get", "--uri", uri, "--resource", ADO_RESOURCE_ID]);
  if (result.exitCode !== 0) return "";
  return result.stdout;
}

/** Exported for testing only */
export const buildFilePatch_TEST = (...args: Parameters<typeof buildFilePatch>) => buildFilePatch(...args);
/** Exported for testing only */
export const computeHunks_TEST = (...args: Parameters<typeof computeHunks>) => computeHunks(...args);

/**
 * Build a git-style unified diff for a single file from old/new content strings.
 * Uses a simple line-level diff algorithm (no external packages required).
 */
function buildFilePatch(
  oldContent: string,
  newContent: string,
  filePath: string,
  originalPath?: string,
  changeType?: string,
): string {
  const aPath = changeType === "add" ? "/dev/null" : `a/${originalPath ?? filePath}`;
  const bPath = changeType === "delete" ? "/dev/null" : `b/${filePath}`;
  const displayOld = originalPath ?? filePath;

  const oldLines = oldContent ? oldContent.split("\n") : [];
  const newLines = newContent ? newContent.split("\n") : [];

  // Remove trailing empty line created by split on trailing newline
  if (oldLines[oldLines.length - 1] === "") oldLines.pop();
  if (newLines[newLines.length - 1] === "") newLines.pop();

  // Myers diff — compute edit script
  const hunks = computeHunks(oldLines, newLines);
  if (hunks.length === 0) return "";

  const header = [
    `diff --git a/${displayOld} b/${filePath}`,
    `--- ${aPath}`,
    `+++ ${bPath}`,
  ];

  return [...header, ...hunks].join("\n") + "\n";
}

/**
 * Minimal Myers diff → unified diff hunks.
 * Returns lines in unified diff format (@@ ... @@ + context/add/remove lines).
 */
function computeHunks(oldLines: string[], newLines: string[]): string[] {
  const CONTEXT = 3;
  // Build edit script using simple LCS
  const n = oldLines.length;
  const m = newLines.length;

  // dp[i][j] = LCS length of oldLines[0..i) and newLines[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to get edit operations: 'k'=keep, 'd'=delete, 'i'=insert
  type Op = { type: "k" | "d" | "i"; oldIdx?: number; newIdx?: number; line: string };
  const ops: Op[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift({ type: "k", oldIdx: i - 1, newIdx: j - 1, line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: "i", newIdx: j - 1, line: newLines[j - 1] });
      j--;
    } else {
      ops.unshift({ type: "d", oldIdx: i - 1, line: oldLines[i - 1] });
      i--;
    }
  }

  if (ops.every(o => o.type === "k")) return []; // No changes

  // Group ops into hunks with context
  const result: string[] = [];
  const ranges: Array<{ start: number; end: number }> = [];

  // Find changed op indices
  const changedIndices = ops.reduce<number[]>((acc, op, idx) => {
    if (op.type !== "k") acc.push(idx);
    return acc;
  }, []);

  if (changedIndices.length === 0) return [];

  // Merge nearby changes into hunks
  let hunkStart = Math.max(0, changedIndices[0] - CONTEXT);
  let hunkEnd = Math.min(ops.length - 1, changedIndices[0] + CONTEXT);
  for (let k = 1; k < changedIndices.length; k++) {
    const next = changedIndices[k];
    if (next - CONTEXT <= hunkEnd + 1) {
      hunkEnd = Math.min(ops.length - 1, next + CONTEXT);
    } else {
      ranges.push({ start: hunkStart, end: hunkEnd });
      hunkStart = Math.max(0, next - CONTEXT);
      hunkEnd = Math.min(ops.length - 1, next + CONTEXT);
    }
  }
  ranges.push({ start: hunkStart, end: hunkEnd });

  for (const range of ranges) {
    const slice = ops.slice(range.start, range.end + 1);

    // Compute old/new line numbers for @@ header
    const oldStart = slice.find(o => o.oldIdx !== undefined)?.oldIdx ?? 0;
    const newStart = slice.find(o => o.newIdx !== undefined)?.newIdx ?? 0;
    const oldCount = slice.filter(o => o.type !== "i").length;
    const newCount = slice.filter(o => o.type !== "d").length;

    result.push(`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`);
    for (const op of slice) {
      if (op.type === "k") result.push(` ${op.line}`);
      else if (op.type === "d") result.push(`-${op.line}`);
      else result.push(`+${op.line}`);
    }
  }

  return result;
}

/**
 * Fetch the PR diff via ADO REST API.
 * Gets the list of changed files from the PR iteration changes endpoint,
 * then fetches old/new content for each file and builds a git-style unified diff.
 */
async function fetchAdoDiffViaApi(
  runtime: PRRuntime,
  ref: AdoPRRef,
  baseSha: string,
  headSha: string,
): Promise<string> {
  const base = repoApiBase(ref);

  // Get latest iteration ID
  const iterResult = await azRest<{ value: Array<{ id: number }> }>(
    runtime, "get",
    `${base}/pullRequests/${ref.id}/iterations?api-version=7.1`,
  );
  const iterations = iterResult.value ?? [];
  if (iterations.length === 0) throw new Error("No PR iterations found");
  const latestIterId = iterations[iterations.length - 1].id;

  // Get changed files for this iteration
  const changesResult = await azRest<{ changeEntries: AdoChangeEntry[] }>(
    runtime, "get",
    `${base}/pullRequests/${ref.id}/iterations/${latestIterId}/changes?api-version=7.1&$top=2000`,
  );

  const entries = (changesResult.changeEntries ?? []).filter(e => !e.item.isFolder);
  if (entries.length === 0) return "";

  // Fetch old+new content in parallel and build unified diff
  const patches = await Promise.all(entries.map(async (entry) => {
    const ct = entry.changeType?.toLowerCase() ?? "edit";
    const filePath = entry.item.path.replace(/^\//, "");
    const originalPath = entry.originalItem?.path?.replace(/^\//, "");

    const [oldContent, newContent] = await Promise.all([
      ct === "add" ? Promise.resolve("") : fetchItemContentRaw(runtime, base, entry.originalItem?.path ?? entry.item.path, baseSha),
      ct === "delete" ? Promise.resolve("") : fetchItemContentRaw(runtime, base, entry.item.path, headSha),
    ]);

    return buildFilePatch(oldContent, newContent, filePath, originalPath, ct);
  }));

  return patches.filter(Boolean).join("");
}

/**
 * Attempt to get a unified diff for the PR.
 *
 * Strategy:
 * 1. Try `git diff <baseSha>..<headSha>` (works if the repo is cloned locally).
 * 2. If that fails, fall back to fetching the diff via the ADO REST API.
 */
async function fetchAdoDiff(
  runtime: PRRuntime,
  ref: AdoPRRef,
  baseSha: string,
  headSha: string,
): Promise<string> {
  const tryDiff = () => runtime.runCommand("git", ["diff", `${baseSha}..${headSha}`]);

  let diffResult = await tryDiff();

  if (diffResult.exitCode !== 0) {
    // Commits might not be local — try fetching from origin first
    await runtime.runCommand("git", ["fetch", "origin"]);
    diffResult = await tryDiff();
  }

  if (diffResult.exitCode === 0) {
    return diffResult.stdout;
  }

  // Not in the repo — fall back to ADO REST API
  return fetchAdoDiffViaApi(runtime, ref, baseSha, headSha);
}

export async function fetchAdoPR(
  runtime: PRRuntime,
  ref: AdoPRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string }> {
  const result = await runtime.runCommand("az", [
    "repos", "pr", "show",
    "--id", String(ref.id),
    "--org", ref.orgUrl,
    "--output", "json",
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to fetch PR metadata: ${result.stderr.trim() || `exit code ${result.exitCode}`}\n` +
      `Make sure the azure-devops extension is installed: \`az extension add --name azure-devops\``,
    );
  }

  const raw = JSON.parse(result.stdout) as AdoPRShowResult;

  const baseSha = raw.lastMergeTargetCommit?.commitId;
  const headSha = raw.lastMergeSourceCommit?.commitId;

  if (!baseSha || !headSha) {
    throw new Error("PR has no merge commits — it may be in a pending state or the source branch was deleted.");
  }

  const remoteUrl = raw.repository?.remoteUrl ?? raw.remoteUrl;
  const webUrl = buildPRWebUrl(remoteUrl, ref.orgUrl, ref.project, ref.repo, ref.id);

  const author = raw.createdBy.uniqueName ?? raw.createdBy.displayName ?? "unknown";

  const metadata: PRMetadata = {
    platform: "azuredevops",
    orgUrl: ref.orgUrl,
    organization: ref.organization,
    project: ref.project,
    repo: ref.repo,
    id: ref.id,
    title: raw.title,
    author,
    baseBranch: stripRefsHeads(raw.targetRefName),
    headBranch: stripRefsHeads(raw.sourceRefName),
    baseSha,
    headSha,
    url: webUrl,
  };

  const rawPatch = await fetchAdoDiff(runtime, ref, baseSha, headSha);

  return { metadata, rawPatch };
}

// --- PR Context ---

interface AdoThread {
  id: number;
  isDeleted?: boolean;
  comments?: Array<{
    id: number;
    author: { uniqueName?: string; displayName?: string };
    content?: string;
    publishedDate: string;
    commentType: string; // "text" | "system" | "codeChange"
  }>;
  status?: string; // "active" | "fixed" | "wontFix" | "closed" | "byDesign" | "pending"
  threadContext?: object | null;
}

interface AdoPolicyEvaluation {
  configuration?: {
    type?: { displayName?: string };
    isEnabled?: boolean;
    isBlocking?: boolean;
  };
  status?: string; // "approved" | "running" | "queued" | "rejected" | "notApplicable" | "broken"
  context?: { buildId?: number; pipelineRef?: { name?: string } };
}

export async function fetchAdoPRContext(
  runtime: PRRuntime,
  ref: AdoPRRef,
): Promise<PRContext> {
  const apiVersion = "api-version=7.1";
  const base = repoApiBase(ref);
  const prBase = `${base}/pullRequests/${ref.id}`;

  // Fetch threads (comments + reviews) and policy evaluations in parallel
  const [threadsResult, policiesResult, prResult] = await Promise.allSettled([
    azRest<{ value: AdoThread[] }>(runtime, "get", `${prBase}/threads?${apiVersion}`),
    azRest<{ value: AdoPolicyEvaluation[] }>(
      runtime, "get",
      `${ref.orgUrl}/${encodeURIComponent(ref.project)}/_apis/policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/${encodeURIComponent(ref.project)}/${ref.id}&${apiVersion}`,
    ),
    azRest<AdoPRShowResult>(runtime, "get", `${prBase}?${apiVersion}`),
  ]);

  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  // --- PR details ---
  let prRaw: AdoPRShowResult | null = null;
  if (prResult.status === "fulfilled") prRaw = prResult.value;

  const status = prRaw?.status ?? "active";
  const normalizedState = status === "active" ? "OPEN" : status.toUpperCase();
  const isDraft = prRaw?.isDraft ?? false;

  // --- Threads → comments + reviews ---
  const comments: PRContext["comments"] = [];
  const reviews: PRContext["reviews"] = [];

  if (threadsResult.status === "fulfilled") {
    for (const thread of threadsResult.value.value ?? []) {
      if (thread.isDeleted) continue;
      const firstComment = thread.comments?.[0];
      if (!firstComment) continue;

      if (firstComment.commentType === "system") continue;

      const author = firstComment.author.uniqueName ?? firstComment.author.displayName ?? "";
      const body = str(firstComment.content);
      const createdAt = str(firstComment.publishedDate);
      const webUrl = `${ref.orgUrl}/${encodeURIComponent(ref.project)}/_git/${encodeURIComponent(ref.repo)}/pullrequest/${ref.id}?_a=overview&discussionId=${thread.id}`;

      // Threads with threadContext are inline code comments; others are general
      comments.push({
        id: String(thread.id),
        author,
        body,
        createdAt,
        url: webUrl,
      });

      // Identify approval votes embedded in threads (ADO uses vote threads for reviews)
      if (thread.status === "fixed" || thread.status === "byDesign") {
        reviews.push({
          id: String(thread.id),
          author,
          state: "APPROVED",
          body,
          submittedAt: createdAt,
        });
      }
    }
  }

  // --- Policy evaluations → checks ---
  const checks: PRContext["checks"] = [];
  if (policiesResult.status === "fulfilled") {
    for (const policy of policiesResult.value.value ?? []) {
      if (!policy.configuration?.isEnabled) continue;
      const name = policy.configuration?.type?.displayName ?? "Policy";
      const polStatus = policy.status ?? "";
      const isComplete = ["approved", "rejected", "notApplicable", "broken"].includes(polStatus);
      const conclusionMap: Record<string, string> = {
        approved: "SUCCESS",
        rejected: "FAILURE",
        notApplicable: "SKIPPED",
        broken: "FAILURE",
      };
      checks.push({
        name,
        status: isComplete ? "COMPLETED" : "IN_PROGRESS",
        conclusion: isComplete ? (conclusionMap[polStatus] ?? polStatus.toUpperCase()) : null,
        workflowName: name,
        detailsUrl: "",
      });
    }
  }

  // --- Merge status ---
  // ADO uses mergeStatus: "succeeded" | "conflicts" | "rejected" | "queued" | "notSet"
  const mergeStatus = (prRaw as any)?.mergeStatus ?? "";
  const mergeable = mergeStatus === "succeeded" ? "MERGEABLE"
    : mergeStatus === "conflicts" ? "CONFLICTING"
    : "UNKNOWN";

  return {
    body: str((prRaw as any)?.description),
    state: normalizedState,
    isDraft,
    labels: [],
    reviewDecision: "",
    mergeable,
    mergeStateStatus: mergeable,
    comments,
    reviews,
    checks,
    linkedIssues: [],
  };
}

// --- File Content ---

export async function fetchAdoFileContent(
  runtime: PRRuntime,
  ref: AdoPRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  const base = repoApiBase(ref);
  const encodedPath = encodeURIComponent(filePath);
  const uri = `${base}/items?path=${encodedPath}&versionDescriptor.version=${sha}&versionDescriptor.versionType=commit&api-version=7.1&$format=text`;

  try {
    const result = await runtime.runCommand("az", ["rest", "--method", "get", "--uri", uri, "--resource", ADO_RESOURCE_ID]);
    if (result.exitCode !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

// --- Submit PR Review ---

export async function submitAdoPRReview(
  runtime: PRRuntime,
  ref: AdoPRRef,
  _headSha: string,
  action: "approve" | "comment",
  body: string,
  fileComments: PRReviewFileComment[],
): Promise<void> {
  const apiVersion = "api-version=7.1";
  const base = repoApiBase(ref);
  const prBase = `${base}/pullRequests/${ref.id}`;

  const threadsUri = `${prBase}/threads?${apiVersion}`;

  // 1. Post general comment as a thread (if non-empty)
  if (body && body.trim()) {
    await azRest<unknown>(runtime, "post", threadsUri, JSON.stringify({
      comments: [{ parentCommentId: 0, content: body.trim(), commentType: 1 }],
      status: 1,
    }));
  }

  // 2. Post inline file comments as threads with file context
  if (fileComments.length > 0) {
    const errors: string[] = [];

    const results = await Promise.allSettled(
      fileComments.map(async (comment) => {
        const isOldSide = comment.side === "LEFT";
        await azRest<unknown>(runtime, "post", threadsUri, JSON.stringify({
          comments: [{ parentCommentId: 0, content: comment.body, commentType: 1 }],
          status: 1,
          threadContext: {
            filePath: `/${comment.path}`,
            rightFileStart: isOldSide ? null : { line: comment.start_line ?? comment.line, offset: 1 },
            rightFileEnd: isOldSide ? null : { line: comment.line, offset: 1 },
            leftFileStart: isOldSide ? { line: comment.start_line ?? comment.line, offset: 1 } : null,
            leftFileEnd: isOldSide ? { line: comment.line, offset: 1 } : null,
          },
        }));
      }),
    );

    for (const r of results) {
      if (r.status === "rejected") {
        errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
    }

    if (errors.length > 0 && errors.length === fileComments.length) {
      throw new Error(`Failed to post inline comments:\n${errors.join("\n")}`);
    }
    if (errors.length > 0) {
      console.error(`Warning: ${errors.length}/${fileComments.length} inline comments failed:\n${errors.join("\n")}`);
    }
  }

  // 3. Submit vote if approving via ADO REST API (votes: 10=approve, 5=approve-with-suggestions, 0=reset, -5=wait, -10=reject)
  if (action === "approve") {
    await azRest<unknown>(runtime, "put",
      `${ref.orgUrl}/${encodeURIComponent(ref.project)}/_apis/git/repositories/${encodeURIComponent(ref.repo)}/pullRequests/${ref.id}/reviewers/${encodeURIComponent(await getCurrentUserId(runtime, ref))}?api-version=7.1`,
      JSON.stringify({ vote: 10, isRequired: false }),
    );
  }
}

/** Get the current user's ADO identity ID for the vote API */
async function getCurrentUserId(runtime: PRRuntime, ref: AdoPRRef): Promise<string> {
  try {
    // Try getting the connection data which includes the authenticated user
    const data = await azRest<{ authenticatedUser?: { id?: string; subjectDescriptor?: string } }>(
      runtime, "get",
      `${ref.orgUrl}/_apis/connectionData?api-version=7.1`,
    );
    return data.authenticatedUser?.id ?? "me";
  } catch {
    return "me";
  }
}
