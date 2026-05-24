/**
 * GitLab-specific MR provider implementation.
 *
 * All functions use the `glab` CLI via the PRRuntime abstraction.
 * Self-hosted instances are supported via the --hostname flag.
 */

import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import type { PRRuntime, PRMetadata, PRContext, PRReviewFileComment, CommandResult } from "./pr-types";
import { encodeApiFilePath } from "./pr-types";

// GitLab-specific MRRef shape (used internally)
interface GlMRRef {
  platform: "gitlab";
  host: string;
  projectPath: string;
  iid: number;
}

/** URL-encode the project path for GitLab API (group/project → group%2Fproject) */
function encodeProject(projectPath: string): string {
  return encodeURIComponent(projectPath);
}

/** Build glab API args with optional --hostname for self-hosted */
function apiArgs(host: string, endpoint: string, extra: string[] = []): string[] {
  const args = ["api", endpoint, ...extra];
  if (host !== "gitlab.com") {
    args.push("--hostname", host);
  }
  return args;
}

/** Shape of each entry from the GitLab merge_request diffs API */
interface GitLabDiffEntry {
  diff: string;
  old_path: string;
  new_path: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
}

/**
 * Parse output of `glab api --paginate`.
 *
 * glab concatenates pages as adjacent JSON arrays (`[...][...]`) which is not
 * valid JSON. Walk the output, split it into top-level arrays, and merge them.
 * Single-page output (the common case) round-trips through the same path.
 */
export function parsePaginatedArray<T>(stdout: string): T[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const slices: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "[" || c === "{") {
      if (depth === 0 && c === "[") start = i;
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0 && c === "]" && start !== -1) {
        slices.push(trimmed.slice(start, i + 1));
        start = -1;
      }
    }
  }

  if (slices.length === 0) {
    return JSON.parse(trimmed) as T[];
  }

  const merged: T[] = [];
  for (const slice of slices) {
    const page = JSON.parse(slice) as T[];
    if (Array.isArray(page)) merged.push(...page);
  }
  return merged;
}

/**
 * Reconstruct a unified patch from GitLab's merge_request diffs API response.
 *
 * Each entry has: { diff, old_path, new_path, new_file, deleted_file, renamed_file }
 * We construct proper `diff --git` headers that the UI parser expects.
 */
function reconstructPatch(diffs: GitLabDiffEntry[]): string {
  const parts: string[] = [];

  for (const d of diffs) {
    const aPath = d.new_file ? "/dev/null" : `a/${d.old_path}`;
    const bPath = d.deleted_file ? "/dev/null" : `b/${d.new_path}`;
    const displayOld = d.new_file ? d.new_path : d.old_path;
    const displayNew = d.deleted_file ? d.old_path : d.new_path;

    let header = `diff --git a/${displayOld} b/${displayNew}`;
    if (d.renamed_file) {
      header += `\nrename from ${d.old_path}\nrename to ${d.new_path}`;
    }
    if (d.new_file) {
      header += "\nnew file mode 100644";
    }
    if (d.deleted_file) {
      header += "\ndeleted file mode 100644";
    }

    parts.push(`${header}\n--- ${aPath}\n+++ ${bPath}\n${d.diff}`);
  }

  return parts.join("");
}

// --- Auth ---

export async function checkGlAuth(runtime: PRRuntime, host: string): Promise<void> {
  const args = ["auth", "status"];
  if (host !== "gitlab.com") {
    args.push("--hostname", host);
  }
  const result = await runtime.runCommand("glab", args);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const hostHint = host !== "gitlab.com" ? ` --hostname ${host}` : "";
    throw new Error(
      `GitLab CLI not authenticated. Run \`glab auth login${hostHint}\` first.\n${stderr}`,
    );
  }
}

export async function getGlUser(runtime: PRRuntime, host: string): Promise<string | null> {
  try {
    const result = await runtime.runCommand("glab", apiArgs(host, "/user"));
    if (result.exitCode === 0 && result.stdout.trim()) {
      const user = JSON.parse(result.stdout) as { username?: string };
      return user.username ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

// --- Fetch MR ---

export async function fetchGlMR(
  runtime: PRRuntime,
  ref: GlMRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string }> {
  const encoded = encodeProject(ref.projectPath);

  // Fetch diff and metadata in parallel via glab api (supports --hostname for self-hosted)
  const [diffResult, viewResult] = await Promise.all([
    runtime.runCommand("glab", apiArgs(ref.host, `projects/${encoded}/merge_requests/${ref.iid}/diffs?per_page=100`, ["--paginate"])),
    runtime.runCommand("glab", apiArgs(ref.host, `projects/${encoded}/merge_requests/${ref.iid}`)),
  ]);

  if (diffResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch MR diff: ${diffResult.stderr.trim() || `exit code ${diffResult.exitCode}`}`,
    );
  }

  if (viewResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch MR metadata: ${viewResult.stderr.trim() || `exit code ${viewResult.exitCode}`}`,
    );
  }

  // Reconstruct unified patch from structured API response
  const diffs = parsePaginatedArray<GitLabDiffEntry>(diffResult.stdout);
  const rawPatch = reconstructPatch(diffs);

  const raw = JSON.parse(viewResult.stdout) as {
    title: string;
    author: { username: string };
    source_branch: string;
    target_branch: string;
    target_project_id?: number;
    diff_refs: { base_sha: string; head_sha: string; start_sha: string } | null;
    web_url: string;
  };

  if (!raw.diff_refs) {
    throw new Error("MR has no diff refs — it may have been merged or the source branch deleted.");
  }

  let defaultBranch: string | undefined;
  const projectEndpoint = typeof raw.target_project_id === "number"
    ? `projects/${raw.target_project_id}`
    : `projects/${encoded}`;
  try {
    const projectResult = await runtime.runCommand("glab", apiArgs(ref.host, projectEndpoint));
    if (projectResult.exitCode === 0 && projectResult.stdout.trim()) {
      const project = JSON.parse(projectResult.stdout) as { default_branch?: string };
      defaultBranch = project.default_branch;
    }
  } catch { /* default branch is best-effort metadata */ }

  const metadata: PRMetadata = {
    platform: "gitlab",
    host: ref.host,
    projectPath: ref.projectPath,
    iid: ref.iid,
    title: raw.title,
    author: raw.author.username,
    baseBranch: raw.target_branch,
    headBranch: raw.source_branch,
    defaultBranch,
    baseSha: raw.diff_refs.base_sha,
    headSha: raw.diff_refs.head_sha,
    url: raw.web_url,
  };

  return { metadata, rawPatch };
}

// --- MR Context ---

export async function fetchGlMRContext(
  runtime: PRRuntime,
  ref: GlMRRef,
): Promise<PRContext> {
  const encoded = encodeProject(ref.projectPath);
  const mrEndpoint = `projects/${encoded}/merge_requests/${ref.iid}`;

  // Fetch all context in parallel
  const [mrResult, notesResult, approvalsResult, pipelinesResult, issuesResult] = await Promise.all([
    runtime.runCommand("glab", apiArgs(ref.host, mrEndpoint)),
    runtime.runCommand("glab", apiArgs(ref.host, `${mrEndpoint}/notes?sort=asc&per_page=100`)),
    runtime.runCommand("glab", apiArgs(ref.host, `${mrEndpoint}/approvals`)),
    runtime.runCommand("glab", apiArgs(ref.host, `${mrEndpoint}/pipelines?per_page=5`)),
    runtime.runCommand("glab", apiArgs(ref.host, `${mrEndpoint}/closes_issues`)),
  ]);

  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  // --- MR details ---
  let mr: Record<string, unknown> = {};
  if (mrResult.exitCode === 0) {
    try { mr = JSON.parse(mrResult.stdout); } catch { /* non-JSON response */ }
  }

  // Normalize state: GitLab uses "opened"/"closed"/"merged" → uppercase
  const glState = str(mr.state);
  const state = glState === "opened" ? "OPEN" : glState.toUpperCase();

  const isDraft = mr.draft === true
    || (typeof mr.title === "string" && /^(Draft:|WIP:)/i.test(mr.title));

  const labels = arr(mr.labels).map((l: any) => {
    if (typeof l === "string") return { name: l, color: "" };
    return { name: str(l?.name), color: str(l?.color) };
  });

  // GitLab merge_status values
  const mergeStatus = str(mr.merge_status);
  const detailedStatus = str(mr.detailed_merge_status);
  const mergeable = mergeStatus === "can_be_merged" ? "MERGEABLE"
    : mergeStatus === "cannot_be_merged" ? "CONFLICTING"
    : mergeStatus === "unchecked" ? "UNKNOWN"
    : mergeStatus.toUpperCase();

  // Map GitLab detailed_merge_status to GitHub-compatible merge state enums
  const mergeStateMap: Record<string, string> = {
    mergeable: "CLEAN",
    broken_status: "DIRTY",
    checking: "UNKNOWN",
    unchecked: "UNKNOWN",
    ci_must_pass: "BLOCKED",
    ci_still_running: "BLOCKED",
    discussions_not_resolved: "BLOCKED",
    draft_status: "BLOCKED",
    blocked_status: "BLOCKED",
    not_approved: "BLOCKED",
    not_open: "DIRTY",
    need_rebase: "BEHIND",
    conflict: "DIRTY",
    jira_association_missing: "BLOCKED",
  };
  const mergeStateStatus = detailedStatus
    ? (mergeStateMap[detailedStatus] ?? detailedStatus.toUpperCase())
    : mergeable;

  // --- Notes (comments) ---
  const notes: PRContext["comments"] = [];
  if (notesResult.exitCode === 0) {
    try {
      const rawNotes = JSON.parse(notesResult.stdout) as any[];
      for (const n of rawNotes) {
        if (n.system) continue;
        notes.push({
          id: String(n.id ?? ""),
          author: str(n.author?.username),
          body: str(n.body),
          createdAt: str(n.created_at),
          url: str(n.web_url) || "",
        });
      }
    } catch { /* non-JSON response */ }
  }

  // --- Approvals ---
  let reviewDecision = "";
  const reviews: PRContext["reviews"] = [];
  if (approvalsResult.exitCode === 0) {
    try {
      const approvals = JSON.parse(approvalsResult.stdout) as Record<string, unknown>;
      const approvedBy = arr(approvals.approved_by);
      const approved = approvals.approved === true || approvedBy.length > 0;
      reviewDecision = approved ? "APPROVED" : "";

      for (const a of approvedBy) {
        const user = (a as any)?.user;
        if (!user) continue;
        reviews.push({
          id: String(user.id ?? ""),
          author: str(user.username),
          state: "APPROVED",
          body: "",
          submittedAt: "",
        });
      }
    } catch { /* non-JSON response */ }
  }

  // --- Pipelines → Checks ---
  const checks: PRContext["checks"] = [];
  if (pipelinesResult.exitCode === 0) {
    try {
      const pipelines = JSON.parse(pipelinesResult.stdout) as any[];
      if (pipelines.length > 0) {
        const latest = pipelines[0];
        const jobsResult = await runtime.runCommand(
          "glab",
          apiArgs(ref.host, `projects/${encoded}/pipelines/${latest.id}/jobs?per_page=100`),
        );
        if (jobsResult.exitCode === 0) {
          try {
            const jobs = JSON.parse(jobsResult.stdout) as any[];
            for (const job of jobs) {
              const jobStatus = str(job.status);
              const isComplete = ["success", "failed", "canceled", "skipped"].includes(jobStatus);
              // Map GitLab job statuses to GitHub-compatible conclusion enums
              const conclusionMap: Record<string, string> = {
                success: "SUCCESS",
                failed: "FAILURE",
                canceled: "NEUTRAL",
                skipped: "SKIPPED",
              };
              checks.push({
                name: str(job.name),
                status: isComplete ? "COMPLETED" : "IN_PROGRESS",
                conclusion: isComplete ? (conclusionMap[jobStatus] ?? jobStatus.toUpperCase()) : null,
                workflowName: str(latest.ref),
                detailsUrl: str(job.web_url),
              });
            }
          } catch { /* non-JSON jobs response */ }
        }
      }
    } catch { /* non-JSON pipelines response */ }
  }

  // --- Linked Issues ---
  const linkedIssues: PRContext["linkedIssues"] = [];
  if (issuesResult.exitCode === 0) {
    try {
      const issues = JSON.parse(issuesResult.stdout) as any[];
      for (const i of issues) {
        linkedIssues.push({
          number: typeof i.iid === "number" ? i.iid : 0,
          url: str(i.web_url),
          repo: ref.projectPath,
        });
      }
    } catch {
      // Non-critical — some GitLab versions may not support this endpoint
    }
  }

  return {
    body: str(mr.description),
    state,
    isDraft,
    labels,
    reviewDecision,
    mergeable,
    mergeStateStatus,
    comments: notes,
    reviews,
    reviewThreads: [],  // TODO: parse DiffNote positions from notes for thread support
    checks,
    linkedIssues,
  };
}

// --- File Content ---

export async function fetchGlFileContent(
  runtime: PRRuntime,
  ref: GlMRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  const encoded = encodeProject(ref.projectPath);
  const encodedPath = encodeApiFilePath(filePath);

  const result = await runtime.runCommand(
    "glab",
    apiArgs(ref.host, `projects/${encoded}/repository/files/${encodedPath}/raw?ref=${sha}`),
  );

  if (result.exitCode !== 0) return null;

  // GitLab returns raw file content (no base64 encoding)
  return result.stdout;
}

// --- Submit MR Review ---

export async function submitGlMRReview(
  runtime: PRRuntime,
  ref: GlMRRef,
  headSha: string,
  action: "approve" | "comment",
  body: string,
  fileComments: PRReviewFileComment[],
): Promise<void> {
  if (!runtime.runCommandWithInput) {
    throw new Error("Runtime does not support stdin input; cannot submit MR review");
  }

  const encoded = encodeProject(ref.projectPath);
  const mrEndpoint = `projects/${encoded}/merge_requests/${ref.iid}`;

  // Fetch base SHA for position context (needed for line comments)
  // We use the headSha passed in and derive baseSha from MR metadata
  // The caller already has this info, but GitLab's discussion API needs start_sha too

  // 1. Post general body as a note (if non-empty)
  if (body && body.trim()) {
    const notePayload = JSON.stringify({ body: body.trim() });
    const noteResult = await runtime.runCommandWithInput(
      "glab",
      apiArgs(ref.host, `${mrEndpoint}/notes`, ["--method", "POST", "--input", "-", "-H", "Content-Type:application/json"]),
      notePayload,
    );
    if (noteResult.exitCode !== 0) {
      const msg = noteResult.stderr.trim() || noteResult.stdout.trim() || `exit code ${noteResult.exitCode}`;
      throw new Error(`Failed to post MR note: ${msg}`);
    }
  }

  // 2. Post inline file comments as discussions with position
  if (fileComments.length > 0) {
    // We need the MR's diff_refs for the position SHAs.
    const mrResult = await runtime.runCommand(
      "glab",
      apiArgs(ref.host, mrEndpoint),
    );
    let baseSha = headSha; // fallback
    let startSha = headSha;
    if (mrResult.exitCode === 0 && mrResult.stdout.trim()) {
      try {
        const mrData = JSON.parse(mrResult.stdout) as { diff_refs?: { base_sha: string; start_sha: string; head_sha: string } };
        if (mrData.diff_refs) {
          baseSha = mrData.diff_refs.base_sha;
          startSha = mrData.diff_refs.start_sha;
        }
      } catch {
        // Use fallbacks
      }
    }

    const errors: string[] = [];

    // Submit comments in parallel
    const results = await Promise.allSettled(
      fileComments.map(async (comment) => {
        const isOldSide = comment.side === "LEFT";
        const position: Record<string, unknown> = {
          position_type: "text",
          base_sha: baseSha,
          head_sha: headSha,
          start_sha: startSha,
          new_path: comment.path,
          old_path: comment.path,
        };

        if (isOldSide) {
          position.old_line = comment.line;
        } else {
          position.new_line = comment.line;
        }

        // Multi-line range support
        if (comment.start_line != null && comment.start_line !== comment.line) {
          const startIsOld = (comment.start_side ?? comment.side) === "LEFT";
          const startEntry: Record<string, unknown> = { type: startIsOld ? "old" : "new" };
          if (startIsOld) startEntry.old_line = comment.start_line;
          else startEntry.new_line = comment.start_line;

          const endEntry: Record<string, unknown> = { type: isOldSide ? "old" : "new" };
          if (isOldSide) endEntry.old_line = comment.line;
          else endEntry.new_line = comment.line;

          position.line_range = { start: startEntry, end: endEntry };
        }

        const payload = JSON.stringify({ body: comment.body, position });
        const res = await runtime.runCommandWithInput!(
          "glab",
          apiArgs(ref.host, `${mrEndpoint}/discussions`, ["--method", "POST", "--input", "-", "-H", "Content-Type:application/json"]),
          payload,
        );

        if (res.exitCode !== 0) {
          const msg = res.stderr.trim() || res.stdout.trim() || `exit code ${res.exitCode}`;
          throw new Error(`${comment.path}:${comment.line}: ${msg}`);
        }
      }),
    );

    for (const r of results) {
      if (r.status === "rejected") {
        errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
    }

    if (errors.length > 0) {
      // Persist unposted bodies to disk so the work survives transient GitLab errors.
      // We keep the original throw-vs-warn split intentionally:
      //  - all-fail → throw (nothing was posted, caller retries from clean state)
      //  - partial-fail → warn only (some discussions + the MR note are already on
      //    the server; throwing would have the client re-submit the whole review
      //    and create duplicates).
      const failed = results
        .map((r, i) => (r.status === "rejected" ? fileComments[i] : null))
        .filter((c): c is PRReviewFileComment => c !== null);
      let savedTo: string | null = null;
      try {
        const dir = join(homedir(), ".plannotator", "failed-comments");
        mkdirSync(dir, { recursive: true });
        const slug = `${ref.host}-${ref.projectPath.replace(/\//g, "_")}-mr${ref.iid}-${Date.now()}`;
        savedTo = join(dir, `${slug}.json`);
        writeFileSync(
          savedTo,
          JSON.stringify({ ref, headSha, baseSha, startSha, errors, failedComments: failed }, null, 2),
        );
      } catch (writeErr) {
        console.error(`[plannotator] Failed to persist unposted comments: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
      }
      const suffix = savedTo ? ` (unposted bodies saved to ${savedTo})` : "";

      if (errors.length === fileComments.length) {
        // All failed — safe to throw, nothing was posted.
        throw new Error(
          `Failed to post inline comments${suffix}:\n${errors.join("\n")}`,
        );
      }
      // Partial failure — some comments and the MR note are already posted.
      // Don't throw, or the UI will resubmit the whole review and duplicate them.
      console.error(
        `[plannotator] ${errors.length}/${fileComments.length} inline comments failed${suffix}:\n${errors.join("\n")}`,
      );
    }
  }

  // 3. Approve if requested
  if (action === "approve") {
    const approveResult = await runtime.runCommandWithInput(
      "glab",
      apiArgs(ref.host, `${mrEndpoint}/approve`, ["--method", "POST", "--input", "-", "-H", "Content-Type:application/json"]),
      "{}",
    );
    if (approveResult.exitCode !== 0) {
      const msg = approveResult.stderr.trim() || approveResult.stdout.trim() || `exit code ${approveResult.exitCode}`;
      throw new Error(`Failed to approve MR: ${msg}`);
    }
  }
}
