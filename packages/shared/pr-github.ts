/**
 * GitHub-specific PR provider implementation.
 *
 * All functions use the `gh` CLI via the PRRuntime abstraction.
 */

import type { PRRuntime, PRMetadata, PRContext, PRReviewFileComment, CommandResult } from "./pr-provider";
import { encodeApiFilePath } from "./pr-provider";

// GitHub-specific PRRef shape (used internally)
interface GhPRRef {
  platform: "github";
  owner: string;
  repo: string;
  number: number;
}

// --- Auth ---

export async function checkGhAuth(runtime: PRRuntime): Promise<void> {
  const result = await runtime.runCommand("gh", ["auth", "status"]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      `GitHub CLI not authenticated. Run \`gh auth login\` first.\n${stderr}`,
    );
  }
}

export async function getGhUser(runtime: PRRuntime): Promise<string | null> {
  try {
    const result = await runtime.runCommand("gh", ["api", "user", "--jq", ".login"]);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

// --- Fetch PR ---

export async function fetchGhPR(
  runtime: PRRuntime,
  ref: GhPRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string }> {
  const repo = `${ref.owner}/${ref.repo}`;

  // Fetch diff and metadata in parallel
  const [diffResult, viewResult] = await Promise.all([
    runtime.runCommand("gh", [
      "pr", "diff", String(ref.number),
      "--repo", repo,
    ]),
    runtime.runCommand("gh", [
      "pr", "view", String(ref.number),
      "--repo", repo,
      "--json", "title,author,baseRefName,headRefName,baseRefOid,headRefOid,url",
    ]),
  ]);

  if (diffResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch PR diff: ${diffResult.stderr.trim() || `exit code ${diffResult.exitCode}`}`,
    );
  }

  if (viewResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch PR metadata: ${viewResult.stderr.trim() || `exit code ${viewResult.exitCode}`}`,
    );
  }

  const raw = JSON.parse(viewResult.stdout) as {
    title: string;
    author: { login: string };
    baseRefName: string;
    headRefName: string;
    baseRefOid: string;
    headRefOid: string;
    url: string;
  };

  const metadata: PRMetadata = {
    platform: "github",
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: raw.title,
    author: raw.author.login,
    baseBranch: raw.baseRefName,
    headBranch: raw.headRefName,
    baseSha: raw.baseRefOid,
    headSha: raw.headRefOid,
    url: raw.url,
  };

  return { metadata, rawPatch: diffResult.stdout };
}

// --- PR Context ---

const GH_CONTEXT_FIELDS = [
  "body", "state", "isDraft", "labels",
  "comments", "reviews", "reviewDecision",
  "mergeable", "mergeStateStatus",
  "statusCheckRollup", "closingIssuesReferences",
].join(",");

function parseGhPRContext(raw: Record<string, unknown>): PRContext {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const login = (v: unknown): string =>
    typeof v === "object" && v !== null && "login" in v
      ? String((v as { login: unknown }).login || "")
      : "";

  return {
    body: str(raw.body),
    state: str(raw.state),
    isDraft: raw.isDraft === true,
    labels: arr(raw.labels).map((l: any) => ({
      name: str(l?.name),
      color: str(l?.color),
    })),
    reviewDecision: str(raw.reviewDecision),
    mergeable: str(raw.mergeable),
    mergeStateStatus: str(raw.mergeStateStatus),
    comments: arr(raw.comments).map((c: any) => ({
      id: str(c?.id),
      author: login(c?.author),
      body: str(c?.body),
      createdAt: str(c?.createdAt),
      url: str(c?.url),
    })),
    reviews: arr(raw.reviews).map((r: any) => ({
      id: str(r?.id),
      author: login(r?.author),
      state: str(r?.state),
      body: str(r?.body),
      submittedAt: str(r?.submittedAt),
    })),
    checks: arr(raw.statusCheckRollup).map((c: any) => ({
      name: str(c?.name),
      status: str(c?.status),
      conclusion: typeof c?.conclusion === "string" ? c.conclusion : null,
      workflowName: str(c?.workflowName),
      detailsUrl: str(c?.detailsUrl),
    })),
    linkedIssues: arr(raw.closingIssuesReferences).map((i: any) => ({
      number: typeof i?.number === "number" ? i.number : 0,
      url: str(i?.url),
      repo: i?.repository
        ? `${login(i.repository.owner)}/${str(i.repository.name)}`
        : "",
    })),
  };
}

export async function fetchGhPRContext(
  runtime: PRRuntime,
  ref: GhPRRef,
): Promise<PRContext> {
  const repo = `${ref.owner}/${ref.repo}`;

  const result = await runtime.runCommand("gh", [
    "pr", "view", String(ref.number),
    "--repo", repo,
    "--json", GH_CONTEXT_FIELDS,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to fetch PR context: ${result.stderr.trim() || `exit code ${result.exitCode}`}`,
    );
  }

  const raw = JSON.parse(result.stdout) as Record<string, unknown>;
  return parseGhPRContext(raw);
}

// --- File Content ---

export async function fetchGhPRFileContent(
  runtime: PRRuntime,
  ref: GhPRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  const result = await runtime.runCommand("gh", [
    "api",
    `repos/${ref.owner}/${ref.repo}/contents/${encodeApiFilePath(filePath)}?ref=${sha}`,
    "--jq", ".content",
  ]);

  if (result.exitCode !== 0) return null;

  const base64Content = result.stdout.trim();
  if (!base64Content) return null;

  // GitHub returns base64-encoded content with newlines
  const cleaned = base64Content.replace(/\n/g, "");
  try {
    return Buffer.from(cleaned, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

// --- Submit PR Review ---

export async function submitGhPRReview(
  runtime: PRRuntime,
  ref: GhPRRef,
  headSha: string,
  action: "approve" | "comment",
  body: string,
  fileComments: PRReviewFileComment[],
): Promise<void> {
  const payload = JSON.stringify({
    commit_id: headSha,
    body,
    event: action === "approve" ? "APPROVE" : "COMMENT",
    comments: fileComments,
  });

  const endpoint = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`;

  let result: CommandResult;

  if (runtime.runCommandWithInput) {
    result = await runtime.runCommandWithInput(
      "gh",
      ["api", endpoint, "--method", "POST", "--input", "-"],
      payload,
    );
  } else {
    throw new Error("Runtime does not support stdin input; cannot submit PR review");
  }

  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`Failed to submit PR review: ${message}`);
  }
}
