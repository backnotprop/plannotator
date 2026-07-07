/**
 * GitLab-specific MR provider implementation.
 *
 * All functions use the `glab` CLI via the PRRuntime abstraction.
 * Self-hosted instances are supported via the --hostname flag.
 */

import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import type { PRRuntime, PRMetadata, PRContext, PRReviewFileComment, CommandResult } from "./pr-types";
import { encodeApiFilePath } from "./pr-types";
import { getPlannotatorDataDir } from "./data-dir";

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
  /** Content withheld because the file's diff exceeds GitLab's size limits. Absent on older GitLab. */
  too_large?: boolean | null;
  /** Diff collapsed (content omitted from the response). Absent on older GitLab. */
  collapsed?: boolean | null;
}

export { parsePaginatedArray } from "./cli-pagination";
import { parsePaginatedArray } from "./cli-pagination";

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
      // Diff parsers (e.g. Pierre's) key rename classification off the
      // similarity line; the API doesn't expose the score, so emit 100% for
      // pure renames (empty diff) and a synthetic <100% otherwise.
      header += d.diff.trim() === "" ? "\nsimilarity index 100%" : "\nsimilarity index 99%";
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

/**
 * True when a JSON diffs-API entry should carry diff content but doesn't.
 *
 * Modern GitLab marks withheld content explicitly per entry (`too_large`,
 * `collapsed`) — authoritative both ways: a too-large ADDED file is caught
 * (it would otherwise be indistinguishable from a legitimately empty new
 * file), and binaries/empty files are never misflagged.
 *
 * Older GitLab (the same versions this JSON fallback exists for) omits the
 * flags entirely; there an empty diff on a plain modification is the only
 * reliable withheld signal — empty adds/deletes/renames stay exempt.
 */
function entryMissingContent(d: GitLabDiffEntry): boolean {
  if (d.diff.trim() !== "") return false;
  if (d.too_large || d.collapsed) return true;
  // == null catches both absent (old GitLab) and explicit null (GitLab emits
  // null for unknown on sibling fields like generated_file) — either way the
  // flags are inconclusive and the heuristic must decide.
  if (d.too_large == null && d.collapsed == null) {
    return !d.renamed_file && !d.new_file && !d.deleted_file;
  }
  return false;
}

export async function fetchGlMR(
  runtime: PRRuntime,
  ref: GlMRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string; patchIncomplete?: boolean }> {
  const encoded = encodeProject(ref.projectPath);

  // Primary: raw_diffs — preserves Git's binary-marker shape and includes
  // collapsed/generated file contents that the JSON diffs API can omit.
  const [diffResult, viewResult] = await Promise.all([
    runtime.runCommand("glab", apiArgs(ref.host, `projects/${encoded}/merge_requests/${ref.iid}/raw_diffs`)),
    runtime.runCommand("glab", apiArgs(ref.host, `projects/${encoded}/merge_requests/${ref.iid}`)),
  ]);

  if (viewResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch MR metadata: ${viewResult.stderr.trim() || `exit code ${viewResult.exitCode}`}`,
    );
  }

  // Fall back to the paginated JSON diffs API when raw_diffs is unavailable
  // (older self-hosted GitLab that doesn't expose the raw_diffs endpoint) or
  // returns empty (very large MRs that exceed its safety limit). Reconstruct a
  // unified patch from the JSON entries — the long-standing pre-raw_diffs path.
  let rawPatch: string;
  let patchIncomplete = false;
  if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
    rawPatch = diffResult.stdout;
  } else {
    const fallback = await runtime.runCommand(
      "glab",
      apiArgs(ref.host, `projects/${encoded}/merge_requests/${ref.iid}/diffs?per_page=100`, ["--paginate"]),
    );
    if (fallback.exitCode !== 0) {
      const rawErr = diffResult.stderr.trim() || `exit code ${diffResult.exitCode}`;
      const fbErr = fallback.stderr.trim() || `exit code ${fallback.exitCode}`;
      throw new Error(`Failed to fetch MR diff (raw_diffs: ${rawErr}; diffs: ${fbErr}).`);
    }
    const entries = parsePaginatedArray<GitLabDiffEntry>(fallback.stdout);
    rawPatch = reconstructPatch(entries);
    if (!rawPatch.trim()) {
      throw new Error(
        "MR diff is empty — the diff may be too large to fetch via the GitLab API. Review it on the GitLab web UI.",
      );
    }
    const missingContent = entries.filter(entryMissingContent).length;
    if (missingContent > 0) {
      console.error(
        `Warning: GitLab omitted diff content for ${missingContent} file(s) (MR too large). They appear in the review without hunks; the full diff can be recomputed locally once the checkout is ready.`,
      );
      patchIncomplete = true;
    }
  }

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

  return { metadata, rawPatch, ...(patchIncomplete && { patchIncomplete }) };
}

// --- MR Context ---

/**
 * Best-effort GitLab bot detection. GitLab's note/approval user objects don't
 * reliably carry a `bot` flag (unlike GitHub's `__typename`), so check it when
 * present and otherwise fall back to the username conventions GitLab uses for
 * automation accounts: project/group access-token bots (`project_<id>_bot…`,
 * `group_<id>_bot…`), a `_bot`/`[bot]` suffix, and the `ghost` placeholder.
 * Conservative on purpose — better to miss a bot than hide a real person.
 */
function isGitlabBot(user: any): boolean {
  if (!user) return false;
  if (user.bot === true) return true;
  const name = String(user.username ?? "").toLowerCase();
  return (
    /^(project|group)_\d+_bot/.test(name) ||
    name.endsWith("_bot") ||
    name.endsWith("[bot]") ||
    name === "ghost"
  );
}

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
  // GitLab returns avatar URLs that are absolute on gitlab.com but often
  // relative (`/uploads/...`) on self-hosted instances. A relative URL would
  // resolve against our local server, not the GitLab host, so make it absolute.
  const resolveAvatar = (v: unknown): string | undefined => {
    const s = str(v);
    if (!s) return undefined;
    return s.startsWith("/") ? `https://${ref.host}${s}` : s;
  };

  // --- MR details ---
  if (mrResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch MR context: ${mrResult.stderr.trim() || `exit code ${mrResult.exitCode}`}`,
    );
  }

  let mr: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(mrResult.stdout);
    if (!isRecord(parsed)) {
      throw new Error("non-object MR response");
    }
    mr = parsed;
  } catch {
    throw new Error("Failed to fetch MR context: invalid MR response");
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
        const avatarUrl = resolveAvatar(n.author?.avatar_url);
        notes.push({
          id: String(n.id ?? ""),
          author: str(n.author?.username),
          ...(avatarUrl ? { avatarUrl } : {}),
          ...(isGitlabBot(n.author) ? { isBot: true } : {}),
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
        const avatarUrl = resolveAvatar(user.avatar_url);
        reviews.push({
          id: String(user.id ?? ""),
          author: str(user.username),
          ...(avatarUrl ? { avatarUrl } : {}),
          ...(isGitlabBot(user) ? { isBot: true } : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
        const dir = join(getPlannotatorDataDir(), "failed-comments");
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
