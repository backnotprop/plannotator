/**
 * Plannotator CLI for Claude Code & Copilot CLI
 *
 * Supports eight modes:
 *
 * 1. Plan Review (default, no args):
 *    - Spawned by ExitPlanMode hook (Claude Code)
 *    - Reads hook event from stdin, extracts plan content
 *    - Serves UI, returns approve/deny decision to stdout
 *
 * 2. Code Review (`plannotator review`):
 *    - Triggered by /review slash command
 *    - Runs git diff, opens review UI
 *    - Outputs feedback to stdout (captured by slash command)
 *
 * 3. Annotate (`plannotator annotate <file.md>`):
 *    - Triggered by /plannotator-annotate slash command
 *    - Opens any markdown file in the annotation UI
 *    - Outputs structured feedback to stdout
 *
 * 4. Archive (`plannotator archive`):
 *    - Opens read-only browser for saved plan decisions
 *    - Lists plans from ~/.plannotator/plans/ with status badges
 *    - Done button closes the browser
 *
 * 5. Sessions (`plannotator sessions`):
 *    - Lists active Plannotator server sessions
 *    - `--open [N]` reopens a session in the browser
 *    - `--clean` removes stale session files
 *
 * 6. Copilot Plan (`plannotator copilot-plan`):
 *    - Spawned by preToolUse hook (Copilot CLI)
 *    - Intercepts exit_plan_mode, reads plan.md from session state
 *    - Outputs permissionDecision JSON to stdout
 *
 * 7. Copilot Last (`plannotator copilot-last`):
 *    - Annotate the last assistant message from a Copilot CLI session
 *    - Parses events.jsonl from session state
 *
 * 8. Improve Context (`plannotator improve-context`):
 *    - Spawned by PreToolUse hook on EnterPlanMode
 *    - Reads improvement hook file from ~/.plannotator/hooks/
 *    - Returns additionalContext or silently passes through
 *
 * Global flags:
 *   --help             - Show top-level usage information
 *   --browser <name>   - Override which browser to open (e.g. "Google Chrome")
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" for remote, "0"/"false" for local
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 */

import {
  startPlannotatorServer,
  handleServerReady,
} from "@plannotator/server";
import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";
import {
  startAnnotateServer,
  handleAnnotateServerReady,
} from "@plannotator/server/annotate";
import { type DiffType, getVcsContext, runVcsDiff, gitRuntime } from "@plannotator/server/vcs";
import { loadConfig, resolveDefaultDiffType, resolveUseJina } from "@plannotator/shared/config";
import { htmlToMarkdown } from "@plannotator/shared/html-to-markdown";
import { urlToMarkdown } from "@plannotator/shared/url-to-markdown";
import { fetchRef, createWorktree, removeWorktree, ensureObjectAvailable } from "@plannotator/shared/worktree";
import { parsePRUrl, checkPRAuth, fetchPR, getCliName, getCliInstallUrl, getMRLabel, getMRNumberLabel, getDisplayRepo } from "@plannotator/server/pr";
import { writeRemoteShareLink } from "@plannotator/server/share-url";
import { resolveMarkdownFile, hasMarkdownFiles } from "@plannotator/shared/resolve-file";
import { FILE_BROWSER_EXCLUDED } from "@plannotator/shared/reference-common";
import { statSync, rmSync, realpathSync, existsSync } from "fs";
import { parseRemoteUrl } from "@plannotator/shared/repo";
import { registerSession, unregisterSession, listSessions } from "@plannotator/server/sessions";
import { openBrowser } from "@plannotator/server/browser";
import { detectProjectName } from "@plannotator/server/project";
import { hostnameOrFallback } from "@plannotator/shared/project";
import { planDenyFeedback } from "@plannotator/shared/feedback-templates";
import { readImprovementHook } from "@plannotator/shared/improvement-hooks";
import { AGENT_CONFIG, type Origin } from "@plannotator/shared/agents";
import { findSessionLogsForCwd, resolveSessionLogByPpid, findSessionLogsByAncestorWalk, getLastRenderedMessage, type RenderedMessage } from "./session-log";
import { findCodexRolloutByThreadId, getLastCodexMessage } from "./codex-session";
import { findCopilotPlanContent, findCopilotSessionForCwd, getLastCopilotMessage } from "./copilot-session";
import {
  formatInteractiveNoArgClarification,
  formatTopLevelHelp,
  isInteractiveNoArgInvocation,
  isTopLevelHelpInvocation,
} from "./cli";
import path from "path";
import { tmpdir } from "os";

// Embed the built HTML at compile time
// @ts-ignore - Bun import attribute for text
import planHtml from "../dist/index.html" with { type: "text" };
const planHtmlContent = planHtml as unknown as string;

// @ts-ignore - Bun import attribute for text
import reviewHtml from "../dist/review.html" with { type: "text" };
const reviewHtmlContent = reviewHtml as unknown as string;

// Check for subcommand
const args = process.argv.slice(2);

// Global flag: --browser <name>
const browserIdx = args.indexOf("--browser");
if (browserIdx !== -1 && args[browserIdx + 1]) {
  process.env.PLANNOTATOR_BROWSER = args[browserIdx + 1];
  args.splice(browserIdx, 2);
}

// Global flag: --no-jina (disables Jina Reader for URL annotation)
const noJinaIdx = args.indexOf("--no-jina");
const cliNoJina = noJinaIdx !== -1;
if (cliNoJina) args.splice(noJinaIdx, 1);

if (isTopLevelHelpInvocation(args)) {
  console.log(formatTopLevelHelp());
  process.exit(0);
}

if (isInteractiveNoArgInvocation(args, process.stdin.isTTY)) {
  console.log(formatInteractiveNoArgClarification());
  process.exit(0);
}

// Ensure session cleanup on exit
process.on("exit", () => unregisterSession());

// Check if URL sharing is enabled (default: true)
const sharingEnabled = process.env.PLANNOTATOR_SHARE !== "disabled";

// Custom share portal URL for self-hosting
const shareBaseUrl = process.env.PLANNOTATOR_SHARE_URL || undefined;

// Paste service URL for short URL sharing
const pasteApiUrl = process.env.PLANNOTATOR_PASTE_URL || undefined;

// Detect calling agent from environment variables set by agent runtimes.
// Priority:
//   PLANNOTATOR_ORIGIN (explicit override, validated against AGENT_CONFIG)
//   > Codex (CODEX_THREAD_ID)
//   > Copilot CLI (COPILOT_CLI)
//   > OpenCode (OPENCODE)
//   > Claude Code (default fallback)
//
// To add a new agent, also add an entry to AGENT_CONFIG in
// packages/shared/agents.ts (see header comment there).
const originOverride = process.env.PLANNOTATOR_ORIGIN as Origin | undefined;
const detectedOrigin: Origin =
  (originOverride && originOverride in AGENT_CONFIG) ? originOverride :
  process.env.CODEX_THREAD_ID ? "codex" :
  process.env.COPILOT_CLI ? "copilot-cli" :
  process.env.OPENCODE ? "opencode" :
  "claude-code";

if (args[0] === "sessions") {
  // ============================================
  // SESSION DISCOVERY MODE
  // ============================================

  if (args.includes("--clean")) {
    // Force cleanup: list sessions (which auto-removes stale entries)
    const sessions = listSessions();
    console.error(`Cleaned up stale sessions. ${sessions.length} active session(s) remain.`);
    process.exit(0);
  }

  const sessions = listSessions();

  if (sessions.length === 0) {
    console.error("No active Plannotator sessions.");
    process.exit(0);
  }

  const openIdx = args.indexOf("--open");
  if (openIdx !== -1) {
    // Open a session in the browser
    const nArg = args[openIdx + 1];
    const n = nArg ? parseInt(nArg, 10) : 1;
    const session = sessions[n - 1];
    if (!session) {
      console.error(`Session #${n} not found. ${sessions.length} active session(s).`);
      process.exit(1);
    }
    await openBrowser(session.url);
    console.error(`Opened ${session.mode} session in browser: ${session.url}`);
    process.exit(0);
  }

  // List sessions as a table
  console.error("Active Plannotator sessions:\n");
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const age = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000);
    const ageStr = age < 60 ? `${age}m` : `${Math.floor(age / 60)}h ${age % 60}m`;
    console.error(`  #${i + 1}  ${s.mode.padEnd(9)} ${s.project.padEnd(20)} ${s.url.padEnd(28)} ${ageStr} ago`);
  }
  console.error(`\nReopen with: plannotator sessions --open [N]`);
  process.exit(0);

} else if (args[0] === "review") {
  // ============================================
  // CODE REVIEW MODE
  // ============================================

  // Parse local flags (strip before URL detection)
  // --local is now the default for PR/MR reviews; --no-local opts out.
  // --local kept for backwards compat (no-op).
  const localIdx = args.indexOf("--local");
  if (localIdx !== -1) args.splice(localIdx, 1);
  const noLocalIdx = args.indexOf("--no-local");
  if (noLocalIdx !== -1) args.splice(noLocalIdx, 1);

  const urlArg = args[1];
  const isPRMode = urlArg?.startsWith("http://") || urlArg?.startsWith("https://");
  const useLocal = isPRMode && noLocalIdx === -1;

  let rawPatch: string;
  let gitRef: string;
  let diffError: string | undefined;
  let gitContext: Awaited<ReturnType<typeof getVcsContext>> | undefined;
  let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;
  let initialDiffType: DiffType | undefined;
  let agentCwd: string | undefined;
  let worktreeCleanup: (() => void | Promise<void>) | undefined;

  if (isPRMode) {
    // --- PR Review Mode ---
    const prRef = parsePRUrl(urlArg);
    if (!prRef) {
      console.error(`Invalid PR/MR URL: ${urlArg}`);
      console.error("Supported formats:");
      console.error("  GitHub: https://github.com/owner/repo/pull/123");
      console.error("  GitLab: https://gitlab.com/group/project/-/merge_requests/42");
      process.exit(1);
    }

    const cliName = getCliName(prRef);
    const cliUrl = getCliInstallUrl(prRef);

    try {
      await checkPRAuth(prRef);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("ENOENT")) {
        console.error(`${cliName === "gh" ? "GitHub" : "GitLab"} CLI (${cliName}) is not installed.`);
        console.error(`Install it from ${cliUrl}`);
      } else {
        console.error(msg);
      }
      process.exit(1);
    }

    console.error(`Fetching ${getMRLabel(prRef)} ${getMRNumberLabel(prRef)} from ${getDisplayRepo(prRef)}...`);
    try {
      const pr = await fetchPR(prRef);
      rawPatch = pr.rawPatch;
      gitRef = `${getMRLabel(prRef)} ${getMRNumberLabel(prRef)}`;
      prMetadata = pr.metadata;
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Failed to fetch PR");
      process.exit(1);
    }

    // --local: create a local checkout with the PR head for full file access
    if (useLocal && prMetadata) {
      // Hoisted so catch block can clean up partially-created directories
      let localPath: string | undefined;
      try {
        const repoDir = process.cwd();
        const identifier = prMetadata.platform === "github"
          ? `${prMetadata.owner}-${prMetadata.repo}-${prMetadata.number}`
          : `${prMetadata.projectPath.replace(/\//g, "-")}-${prMetadata.iid}`;
        const suffix = Math.random().toString(36).slice(2, 8);
        // Resolve tmpdir to its real path — on macOS, tmpdir() returns /var/folders/...
        // but processes report /private/var/folders/... which breaks path stripping.
        localPath = path.join(realpathSync(tmpdir()), `plannotator-pr-${identifier}-${suffix}`);
        const fetchRefStr = prMetadata.platform === "github"
          ? `refs/pull/${prMetadata.number}/head`
          : `refs/merge-requests/${prMetadata.iid}/head`;

        // Validate inputs from platform API to prevent git flag/path injection
        if (prMetadata.baseBranch.includes('..') || prMetadata.baseBranch.startsWith('-')) throw new Error(`Invalid base branch: ${prMetadata.baseBranch}`);
        if (!/^[0-9a-f]{40,64}$/i.test(prMetadata.baseSha)) throw new Error(`Invalid base SHA: ${prMetadata.baseSha}`);

        // Detect same-repo vs cross-repo (must match both owner/repo AND host)
        let isSameRepo = false;
        try {
          const remoteResult = await gitRuntime.runGit(["remote", "get-url", "origin"]);
          if (remoteResult.exitCode === 0) {
            const remoteUrl = remoteResult.stdout.trim();
            const currentRepo = parseRemoteUrl(remoteUrl);
            const prRepo = prMetadata.platform === "github"
              ? `${prMetadata.owner}/${prMetadata.repo}`
              : prMetadata.projectPath;
            const repoMatches = !!currentRepo && currentRepo.toLowerCase() === prRepo.toLowerCase();
            // Extract host from remote URL to avoid cross-instance false positives (GHE)
            const sshHost = remoteUrl.match(/^[^@]+@([^:]+):/)?.[1];
            const httpsHost = (() => { try { return new URL(remoteUrl).hostname; } catch { return null; } })();
            const remoteHost = (sshHost || httpsHost || "").toLowerCase();
            const prHost = prMetadata.host.toLowerCase();
            isSameRepo = repoMatches && remoteHost === prHost;
          }
        } catch { /* not in a git repo — cross-repo path */ }

        if (isSameRepo) {
          // ── Same-repo: fast worktree path ──
          console.error("Fetching PR branch and creating local worktree...");
          // Fetch base branch so origin/<baseBranch> is current for agent diffs.
          // Ensure baseSha is available (may fetch, which overwrites FETCH_HEAD).
          // Both MUST happen before the PR head fetch since FETCH_HEAD is what
          // createWorktree uses — the PR head fetch must be last.
          await fetchRef(gitRuntime, prMetadata.baseBranch, { cwd: repoDir });
          await ensureObjectAvailable(gitRuntime, prMetadata.baseSha, { cwd: repoDir });
          // Fetch PR head LAST — sets FETCH_HEAD to the PR tip for createWorktree.
          await fetchRef(gitRuntime, fetchRefStr, { cwd: repoDir });

          await createWorktree(gitRuntime, {
            ref: "FETCH_HEAD",
            path: localPath,
            detach: true,
            cwd: repoDir,
          });

          worktreeCleanup = () => removeWorktree(gitRuntime, localPath, { force: true, cwd: repoDir });
          process.once("exit", () => {
            try { Bun.spawnSync(["git", "worktree", "remove", "--force", localPath]); } catch {}
          });
        } else {
          // ── Cross-repo: shallow clone + fetch PR head ──
          const prRepo = prMetadata.platform === "github"
            ? `${prMetadata.owner}/${prMetadata.repo}`
            : prMetadata.projectPath;
          // Validate repo identifier to prevent flag injection via crafted URLs
          if (/^-/.test(prRepo)) throw new Error(`Invalid repository identifier: ${prRepo}`);
          const cli = prMetadata.platform === "github" ? "gh" : "glab";
          const host = prMetadata.host;
          // gh/glab repo clone doesn't accept --hostname; set GH_HOST/GITLAB_HOST env instead
          const isDefaultHost = host === "github.com" || host === "gitlab.com";
          const cloneEnv = isDefaultHost ? undefined : {
            ...process.env,
            ...(prMetadata.platform === "github" ? { GH_HOST: host } : { GITLAB_HOST: host }),
          };

          // Step 1: Fast skeleton clone (no checkout, depth 1 — minimal data transfer)
          console.error(`Cloning ${prRepo} (shallow)...`);
          const cloneResult = Bun.spawnSync(
            [cli, "repo", "clone", prRepo, localPath, "--", "--depth=1", "--no-checkout"],
            { stderr: "pipe", env: cloneEnv },
          );
          if (cloneResult.exitCode !== 0) {
            throw new Error(`${cli} repo clone failed: ${new TextDecoder().decode(cloneResult.stderr).trim()}`);
          }

          // Step 2: Fetch only the PR head ref (targeted, much faster than full fetch)
          console.error("Fetching PR branch...");
          const fetchResult = Bun.spawnSync(
            ["git", "fetch", "--depth=200", "origin", fetchRefStr],
            { cwd: localPath, stderr: "pipe" },
          );
          if (fetchResult.exitCode !== 0) throw new Error(`Failed to fetch PR head ref: ${new TextDecoder().decode(fetchResult.stderr).trim()}`);

          // Step 3: Checkout PR head (critical — if this fails, worktree is empty)
          const checkoutResult = Bun.spawnSync(["git", "checkout", "FETCH_HEAD"], { cwd: localPath, stderr: "pipe" });
          if (checkoutResult.exitCode !== 0) {
            throw new Error(`git checkout FETCH_HEAD failed: ${new TextDecoder().decode(checkoutResult.stderr).trim()}`);
          }

          // Best-effort: create base refs so `git diff main...HEAD` and `git diff origin/main...HEAD` work
          const baseFetch = Bun.spawnSync(["git", "fetch", "--depth=200", "origin", prMetadata.baseSha], { cwd: localPath, stderr: "pipe" });
          if (baseFetch.exitCode !== 0) console.error("Warning: failed to fetch baseSha, agent diffs may be inaccurate");
          Bun.spawnSync(["git", "branch", "--", prMetadata.baseBranch, prMetadata.baseSha], { cwd: localPath, stderr: "pipe" });
          Bun.spawnSync(["git", "update-ref", `refs/remotes/origin/${prMetadata.baseBranch}`, prMetadata.baseSha], { cwd: localPath, stderr: "pipe" });

          worktreeCleanup = () => { try { rmSync(localPath, { recursive: true, force: true }); } catch {} };
          process.once("exit", () => {
            try { Bun.spawnSync(["rm", "-rf", localPath]); } catch {}
          });
        }

        // --local only provides a sandbox path for agent processes.
        // Do NOT set gitContext — that would contaminate the diff pipeline.
        agentCwd = localPath;

        console.error(`Local checkout ready at ${localPath}`);
      } catch (err) {
        console.error(`Warning: --local failed, falling back to remote diff`);
        console.error(err instanceof Error ? err.message : String(err));
        // Clean up partially-created directory (clone may have succeeded before fetch/checkout failed)
        if (localPath) try { rmSync(localPath, { recursive: true, force: true }); } catch {}
        agentCwd = undefined;
        worktreeCleanup = undefined;
      }
    }
  } else {
    // --- Local Review Mode ---
    gitContext = await getVcsContext();
    initialDiffType = gitContext.vcsType === "p4" ? "p4-default" : resolveDefaultDiffType(loadConfig());
    const diffResult = await runVcsDiff(initialDiffType, gitContext.defaultBranch);
    rawPatch = diffResult.patch;
    gitRef = diffResult.label;
    diffError = diffResult.error;
  }

  const reviewProject = (await detectProjectName()) ?? "_unknown";

  // Start review server (even if empty - user can switch diff types in local mode)
  const server = await startReviewServer({
    rawPatch,
    gitRef,
    error: diffError,
    origin: detectedOrigin,
    diffType: gitContext ? (initialDiffType ?? "unstaged") : undefined,
    gitContext,
    prMetadata,
    agentCwd,
    sharingEnabled,
    shareBaseUrl,
    htmlContent: reviewHtmlContent,
    onCleanup: worktreeCleanup,
    onReady: async (url, isRemote, port) => {
      handleReviewServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled && rawPatch) {
        await writeRemoteShareLink(rawPatch, shareBaseUrl, "review changes", "diff only").catch(() => {});
      }
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "review",
    project: reviewProject,
    startedAt: new Date().toISOString(),
    label: isPRMode ? `${getMRLabel(prMetadata!).toLowerCase()}-review-${getDisplayRepo(prMetadata!)}${getMRNumberLabel(prMetadata!)}` : `review-${reviewProject}`,
  });

  // Wait for user feedback
  const result = await server.waitForDecision();

  // Give browser time to receive response and update UI
  await Bun.sleep(1500);

  // Cleanup
  server.stop();

  // Output feedback (captured by slash command)
  if (result.exit) {
    console.log("Review session closed without feedback.");
  } else if (result.approved) {
    console.log("Code review completed — no changes requested.");
  } else {
    console.log(result.feedback);
    if (!isPRMode) {
      console.log("\nThe reviewer has identified issues above. You must address all of them.");
    }
  }
  process.exit(0);

} else if (args[0] === "annotate") {
  // ============================================
  // ANNOTATE MODE
  // ============================================

  let filePath = args[1];
  if (!filePath) {
    console.error("Usage: plannotator annotate <file.md | file.html | https://... | folder/>  [--no-jina]");
    process.exit(1);
  }

  // Strip @ prefix if present (Claude Code file reference syntax)
  if (filePath.startsWith("@")) {
    filePath = filePath.slice(1);
  }

  // Use PLANNOTATOR_CWD if set (original working directory before script cd'd)
  const projectRoot = process.env.PLANNOTATOR_CWD || process.cwd();

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Project root: ${projectRoot}`);
    console.error(`[DEBUG] File path arg: ${filePath}`);
  }

  let markdown: string;
  let absolutePath: string;
  let folderPath: string | undefined;
  let annotateMode: "annotate" | "annotate-folder" = "annotate";
  let sourceInfo: string | undefined;

  // --- URL annotation ---
  const isUrl = /^https?:\/\//i.test(filePath);

  if (isUrl) {
    const useJina = resolveUseJina(cliNoJina, loadConfig());
    console.error(`Fetching: ${filePath}${useJina ? " (via Jina Reader)" : " (via fetch+Turndown)"}`);
    try {
      const result = await urlToMarkdown(filePath, { useJina });
      markdown = result.markdown;
      if (process.env.PLANNOTATOR_DEBUG) {
        console.error(`[DEBUG] Fetched via ${result.source} (${markdown.length} chars)`);
      }
    } catch (err) {
      console.error(`Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    absolutePath = filePath; // Use URL as the "path" for display
    sourceInfo = filePath;   // Full URL for source attribution
  } else {
    // Check if the argument is a directory (folder annotation mode)
    const resolvedArg = path.resolve(projectRoot, filePath);
    let isFolder = false;
    try {
      isFolder = statSync(resolvedArg).isDirectory();
    } catch {
      // Not a directory, fall through to file resolution
    }

    if (isFolder) {
      // Folder annotation mode (markdown + HTML files)
      if (!hasMarkdownFiles(resolvedArg, FILE_BROWSER_EXCLUDED, /\.(mdx?|html?)$/i)) {
        console.error(`No markdown or HTML files found in ${resolvedArg}`);
        process.exit(1);
      }
      folderPath = resolvedArg;
      absolutePath = resolvedArg;
      markdown = "";
      annotateMode = "annotate-folder";
      console.error(`Folder: ${resolvedArg}`);
    } else if (/\.html?$/i.test(resolvedArg)) {
      // HTML file annotation mode — convert to markdown via Turndown
      if (!existsSync(resolvedArg)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }
      const htmlFile = Bun.file(resolvedArg);
      if (htmlFile.size > 10 * 1024 * 1024) {
        console.error(`File too large (${Math.round(htmlFile.size / 1024 / 1024)}MB, max 10MB): ${resolvedArg}`);
        process.exit(1);
      }
      const html = await htmlFile.text();
      markdown = htmlToMarkdown(html);
      absolutePath = resolvedArg;
      sourceInfo = path.basename(resolvedArg);
      console.error(`Converted: ${absolutePath}`);
    } else {
      // Single markdown file annotation mode
      const resolved = resolveMarkdownFile(filePath, projectRoot);

      if (resolved.kind === "ambiguous") {
        console.error(`Ambiguous filename "${resolved.input}" — found ${resolved.matches.length} matches:`);
        for (const match of resolved.matches) {
          console.error(`  ${match}`);
        }
        process.exit(1);
      }
      if (resolved.kind === "not_found") {
        console.error(`File not found: ${resolved.input}`);
        process.exit(1);
      }

      absolutePath = resolved.path;
      markdown = await Bun.file(absolutePath).text();
      console.error(`Resolved: ${absolutePath}`);
    }
  }

  const annotateProject = (await detectProjectName()) ?? "_unknown";

  // Start the annotate server (reuses plan editor HTML)
  const server = await startAnnotateServer({
    markdown,
    filePath: absolutePath,
    origin: detectedOrigin,
    mode: annotateMode,
    folderPath,
    sourceInfo,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    htmlContent: planHtmlContent,
    onReady: async (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled && markdown) {
        await writeRemoteShareLink(markdown, shareBaseUrl, "annotate", "document only").catch(() => {});
      }
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "annotate",
    project: annotateProject,
    startedAt: new Date().toISOString(),
    label: folderPath
      ? `annotate-${path.basename(folderPath)}`
      : `annotate-${isUrl ? hostnameOrFallback(absolutePath) : path.basename(absolutePath)}`,
  });

  // Wait for user feedback
  const result = await server.waitForDecision();

  // Give browser time to receive response and update UI
  await Bun.sleep(1500);

  // Cleanup
  server.stop();

  // Output feedback (captured by slash command)
  if (result.exit) {
    console.log("Annotation session closed without feedback.");
  } else {
    console.log(result.feedback || "No feedback provided.");
  }
  process.exit(0);

} else if (args[0] === "annotate-last" || args[0] === "last") {
  // ============================================
  // ANNOTATE LAST MESSAGE MODE
  // ============================================

  const projectRoot = process.env.PLANNOTATOR_CWD || process.cwd();
  const codexThreadId = process.env.CODEX_THREAD_ID;
  const isCodex = !!codexThreadId;

  let lastMessage: RenderedMessage | null = null;

  if (codexThreadId) {
    // Codex path: find rollout by thread ID
    if (process.env.PLANNOTATOR_DEBUG) {
      console.error(`[DEBUG] Codex detected, thread ID: ${codexThreadId}`);
    }
    const rolloutPath = findCodexRolloutByThreadId(codexThreadId);
    if (rolloutPath) {
      if (process.env.PLANNOTATOR_DEBUG) {
        console.error(`[DEBUG] Rollout: ${rolloutPath}`);
      }
      const msg = getLastCodexMessage(rolloutPath);
      if (msg) {
        lastMessage = { messageId: codexThreadId, text: msg.text, lineNumbers: [] };
      }
    }
  } else {
    // Claude Code path: resolve session log
    //
    // Strategy (most precise → least precise):
    // 1. PPID session metadata: ~/.claude/sessions/<ppid>.json gives us the
    //    exact sessionId and original cwd. Deterministic, O(1), no scanning.
    // 2. CWD slug match: existing behavior — works when the shell CWD hasn't
    //    changed from the session's project directory.
    // 3. Ancestor walk: walk up the directory tree trying parent slugs. Handles
    //    the common case where the user `cd`'d deeper into a subdirectory.

    if (process.env.PLANNOTATOR_DEBUG) {
      console.error(`[DEBUG] Project root: ${projectRoot}`);
      console.error(`[DEBUG] PPID: ${process.ppid}`);
    }

    /** Try each log path, return the first that yields a message. */
    function tryLogCandidates(label: string, getPaths: () => string[]): void {
      if (lastMessage) return;
      const paths = getPaths();
      if (process.env.PLANNOTATOR_DEBUG) {
        console.error(`[DEBUG] ${label}: ${paths.length ? paths.join(", ") : "(none)"}`);
      }
      for (const logPath of paths) {
        lastMessage = getLastRenderedMessage(logPath);
        if (lastMessage) return;
      }
    }

    // 1. Try PPID-based session metadata (most reliable)
    const ppidLog = resolveSessionLogByPpid();
    tryLogCandidates("PPID session metadata", () => ppidLog ? [ppidLog] : []);

    // 2. Fall back to CWD slug match
    tryLogCandidates("CWD slug match", () => findSessionLogsForCwd(projectRoot));

    // 3. Fall back to ancestor directory walk
    tryLogCandidates("Ancestor walk", () => findSessionLogsByAncestorWalk(projectRoot));
  }

  if (!lastMessage) {
    console.error("No rendered assistant message found in session logs.");
    process.exit(1);
  }

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Found message ${lastMessage.messageId} (${lastMessage.text.length} chars)`);
  }

  const annotateProject = (await detectProjectName()) ?? "_unknown";

  const server = await startAnnotateServer({
    markdown: lastMessage.text,
    filePath: "last-message",
    origin: detectedOrigin,
    mode: "annotate-last",
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    htmlContent: planHtmlContent,
    onReady: async (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled) {
        await writeRemoteShareLink(lastMessage.text, shareBaseUrl, "annotate", "message only").catch(() => {});
      }
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "annotate",
    project: annotateProject,
    startedAt: new Date().toISOString(),
    label: `annotate-last`,
  });

  const result = await server.waitForDecision();

  await Bun.sleep(1500);

  server.stop();

  if (result.exit) {
    console.log("Annotation session closed without feedback.");
  } else {
    console.log(result.feedback || "No feedback provided.");
  }
  process.exit(0);

} else if (args[0] === "archive") {
  // ============================================
  // ARCHIVE BROWSER MODE
  // ============================================

  const archiveProject = (await detectProjectName()) ?? "_unknown";

  const server = await startPlannotatorServer({
    plan: "",
    origin: detectedOrigin,
    mode: "archive",
    sharingEnabled,
    shareBaseUrl,
    htmlContent: planHtmlContent,
    onReady: (url, isRemote, port) => {
      handleServerReady(url, isRemote, port);
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "archive",
    project: archiveProject,
    startedAt: new Date().toISOString(),
    label: `archive-${archiveProject}`,
  });

  await server.waitForDone!();

  await Bun.sleep(500);
  server.stop();
  process.exit(0);

} else if (args[0] === "copilot-plan") {
  // ============================================
  // COPILOT CLI PLAN INTERCEPTION MODE
  // ============================================
  //
  // Called by preToolUse hook on EVERY tool call in Copilot CLI.
  // Must filter quickly and only activate for exit_plan_mode.
  // No output = allow the tool call to proceed.

  const eventJson = await Bun.stdin.text();
  let event: { toolName: string; toolArgs: string; cwd: string; timestamp: number; sessionId?: string };

  try {
    event = JSON.parse(eventJson);
  } catch {
    // Can't parse input — allow the tool call
    process.exit(0);
  }

  // FILTER: Only intercept exit_plan_mode
  if (event.toolName !== "exit_plan_mode") {
    process.exit(0); // No output = allow
  }

  // Find plan.md content (sessionId primary, newest plan.md fallback)
  const planContent = findCopilotPlanContent(event.sessionId);

  if (!planContent) {
    // No plan.md found — allow exit_plan_mode to proceed normally
    process.exit(0);
  }

  const planProject = (await detectProjectName()) ?? "_unknown";

  const server = await startPlannotatorServer({
    plan: planContent,
    origin: "copilot-cli",
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    htmlContent: planHtmlContent,
    onReady: async (url, isRemote, port) => {
      handleServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled) {
        await writeRemoteShareLink(planContent, shareBaseUrl, "review the plan", "plan only").catch(() => {});
      }
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "plan",
    project: planProject,
    startedAt: new Date().toISOString(),
    label: `plan-${planProject}`,
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  // Output Copilot CLI permission decision format
  if (result.approved) {
    console.log(JSON.stringify({
      permissionDecision: "allow",
    }));
  } else {
    const feedback = planDenyFeedback(
      result.feedback || "",
      "exit_plan_mode",
    );
    console.log(JSON.stringify({
      permissionDecision: "deny",
      permissionDecisionReason: feedback,
    }));
  }

  process.exit(0);

} else if (args[0] === "copilot-last") {
  // ============================================
  // COPILOT CLI ANNOTATE LAST MESSAGE MODE
  // ============================================

  const projectRoot = process.env.PLANNOTATOR_CWD || process.cwd();

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Copilot CLI detected, finding session for CWD: ${projectRoot}`);
  }

  const sessionDir = findCopilotSessionForCwd(projectRoot);

  if (!sessionDir) {
    console.error("No Copilot CLI session found.");
    process.exit(1);
  }

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Session dir: ${sessionDir}`);
  }

  const msg = getLastCopilotMessage(sessionDir);
  if (!msg) {
    console.error("No assistant message found in Copilot CLI session.");
    process.exit(1);
  }

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Found message (${msg.text.length} chars)`);
  }

  const annotateProject = (await detectProjectName()) ?? "_unknown";

  const server = await startAnnotateServer({
    markdown: msg.text,
    filePath: "last-message",
    origin: "copilot-cli",
    mode: "annotate-last",
    sharingEnabled,
    shareBaseUrl,
    htmlContent: planHtmlContent,
    onReady: async (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled) {
        await writeRemoteShareLink(msg.text, shareBaseUrl, "annotate", "message only").catch(() => {});
      }
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "annotate",
    project: annotateProject,
    startedAt: new Date().toISOString(),
    label: `annotate-last`,
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  if (result.exit) {
    console.log("Annotation session closed without feedback.");
  } else {
    console.log(result.feedback || "No feedback provided.");
  }
  process.exit(0);

} else if (args[0] === "improve-context") {
  // ============================================
  // IMPROVEMENT HOOK CONTEXT INJECTION MODE
  // ============================================
  //
  // Called by PreToolUse hook on EnterPlanMode.
  // Reads the improvement hook file and returns additionalContext.
  // No file = exit 0 silently (passthrough).

  // Must consume stdin (Claude Code hooks deliver event JSON on stdin)
  await Bun.stdin.text();

  const hook = readImprovementHook("enterplanmode-improve");
  if (!hook) process.exit(0);

  const context = [
    "[Plannotator Improvement Hook]",
    "The following corrective instructions were generated from analysis of previous plan denial patterns.",
    "Apply these guidelines when writing your plan:\n",
    hook.content,
  ].join("\n");

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context,
    },
  }));

  process.exit(0);

} else {
  // ============================================
  // PLAN REVIEW MODE (default)
  // ============================================

  // Read hook event from stdin
  const eventJson = await Bun.stdin.text();

  let planContent = "";
  let permissionMode = "default";
  let isGemini = false;
  let planFilename = "";
  let event: Record<string, any>;
  try {
    event = JSON.parse(eventJson);

    // Detect harness: Gemini sends plan_filename (file on disk), Claude Code sends plan (inline)
    planFilename = event.tool_input?.plan_filename || event.tool_input?.plan_path || "";
    isGemini = !!planFilename;

    if (isGemini) {
      // Reconstruct full plan path from transcript_path and session_id:
      // transcript_path = <projectTempDir>/chats/session-...json
      // plan lives at   = <projectTempDir>/<session_id>/plans/<plan_filename>
      const projectTempDir = path.dirname(path.dirname(event.transcript_path));
      const planFilePath = path.join(projectTempDir, event.session_id, "plans", planFilename);
      planContent = await Bun.file(planFilePath).text();
    } else {
      planContent = event.tool_input?.plan || "";
    }

    permissionMode = event.permission_mode || "default";
  } catch (e: any) {
    console.error(`Failed to parse hook event from stdin: ${e?.message || e}`);
    process.exit(1);
  }

  if (!planContent) {
    console.error("No plan content in hook event");
    process.exit(1);
  }

  const planProject = (await detectProjectName()) ?? "_unknown";

  // Start the plan review server
  const server = await startPlannotatorServer({
    plan: planContent,
    origin: isGemini ? "gemini-cli" : detectedOrigin,
    permissionMode,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    htmlContent: planHtmlContent,
    onReady: async (url, isRemote, port) => {
      handleServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled) {
        await writeRemoteShareLink(planContent, shareBaseUrl, "review the plan", "plan only").catch(() => {});
      }
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "plan",
    project: planProject,
    startedAt: new Date().toISOString(),
    label: `plan-${planProject}`,
  });

  // Wait for user decision (blocks until approve/deny)
  const result = await server.waitForDecision();

  // Give browser time to receive response and update UI
  await Bun.sleep(1500);

  // Cleanup
  server.stop();

  // Output decision in the appropriate format for the harness
  if (isGemini) {
    if (result.approved) {
      console.log(result.feedback ? JSON.stringify({ systemMessage: result.feedback }) : "{}");
    } else {
      console.log(
        JSON.stringify({
          decision: "deny",
          reason: planDenyFeedback(result.feedback || "", "exit_plan_mode", {
            planFilePath: planFilename,
          }),
        })
      );
    }
  } else {
    // Claude Code: PermissionRequest hook decision
    if (result.approved) {
      const updatedPermissions = [];
      if (result.permissionMode) {
        updatedPermissions.push({
          type: "setMode",
          mode: result.permissionMode,
          destination: "session",
        });
      }

      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
              behavior: "allow",
              ...(updatedPermissions.length > 0 && { updatedPermissions }),
            },
          },
        })
      );
    } else {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
              behavior: "deny",
              message: planDenyFeedback(result.feedback || "", "ExitPlanMode"),
            },
          },
        })
      );
    }
  }

  process.exit(0);
}
