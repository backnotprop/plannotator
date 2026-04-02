# Standalone Spawn Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple Plannotator from the hook lifecycle by adding a `--spawn` flag (and `PLANNOTATOR_SPAWN` env var) that spawns a new interactive `claude` session with the feedback, plus a new `plan` subcommand for non-hook plan review.

**Architecture:** New `packages/server/spawn.ts` module handles spawn detection and Claude session launching. The `spawn: boolean` option flows from CLI → server → API response → UI (for button labels). The CLI post-decision handler branches on spawn mode: spawn `claude` with a temp file prompt instead of writing hook JSON to stdout. PR inline review comments are fetched via `gh api` and displayed in the diff viewer for annotation.

**Tech Stack:** Bun runtime, React (existing UI), `gh` CLI for PR comments

**Spec:** `docs/superpowers/specs/2026-04-02-standalone-spawn-mode-design.md`

---

### Task 1: Create spawn utility module

**Files:**
- Create: `packages/server/spawn.ts`

- [ ] **Step 1: Create `packages/server/spawn.ts` with `isSpawnMode()` and `spawnClaudeSession()`**

```typescript
/**
 * Standalone spawn mode — launches a new interactive `claude` session
 * with review feedback instead of writing hook output to stdout.
 *
 * Detection:  --spawn CLI flag  OR  PLANNOTATOR_SPAWN=1|true env var
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Check if spawn mode is active.
 * Call this in the CLI entry point, NOT in server code.
 */
export function isSpawnMode(): boolean {
  const envVal = process.env.PLANNOTATOR_SPAWN?.toLowerCase() ?? "";
  return process.argv.includes("--spawn") || envVal === "1" || envVal === "true";
}

/**
 * Spawn an interactive `claude` session with the given prompt.
 * Writes prompt to a temp file and passes a short reference as the initial message.
 * Returns the exit code of the `claude` process.
 */
export async function spawnClaudeSession(
  projectRoot: string,
  prompt: string,
): Promise<number> {
  const feedbackPath = join(tmpdir(), `plannotator-spawn-${Date.now()}.md`);
  await Bun.write(feedbackPath, prompt);

  try {
    const proc = Bun.spawn(
      ["claude", `Read and act on the review feedback in ${feedbackPath}`],
      {
        cwd: projectRoot,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const exitCode = await proc.exited;
    return exitCode;
  } finally {
    await unlink(feedbackPath).catch(() => {}); // best-effort cleanup
  }
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /Users/ch7258/git/plannotator && bun build packages/server/spawn.ts --no-bundle --outdir /tmp/spawn-check`
Expected: Builds without errors

- [ ] **Step 3: Commit**

```bash
git add packages/server/spawn.ts
git commit -m "feat: add spawn utility module for standalone claude session launching"
```

---

### Task 2: Add `spawn` option to all three server interfaces and API responses

**Files:**
- Modify: `packages/server/index.ts` (lines 59-82 ServerOptions, line 276 /api/plan response)
- Modify: `packages/server/review.ts` (lines 34-59 ReviewServerOptions, lines 256-270 /api/diff response)
- Modify: `packages/server/annotate.ts` (lines 32-53 AnnotateServerOptions, lines 134-148 /api/plan response)

- [ ] **Step 1: Add `spawn` to `ServerOptions` in `packages/server/index.ts`**

In the `ServerOptions` interface (after the `customPlanPath` field around line 81), add:

```typescript
  /** Whether the UI is in standalone spawn mode (changes button labels) */
  spawn?: boolean;
```

- [ ] **Step 2: Include `spawn` in the `/api/plan` response in `packages/server/index.ts`**

Destructure `spawn` from options alongside the existing destructured fields at line 122:

```typescript
const { plan, origin, htmlContent, permissionMode, sharingEnabled = true, shareBaseUrl, pasteApiUrl, onReady, mode, customPlanPath, spawn } = options;
```

Add `spawn` to the non-archive `/api/plan` response at line 276:

```typescript
return Response.json({ plan, origin, permissionMode, sharingEnabled, shareBaseUrl, pasteApiUrl, repoInfo, previousPlan, versionInfo, projectRoot: process.cwd(), isWSL: wslFlag, serverConfig: getServerConfig(gitUser), spawn });
```

- [ ] **Step 3: Add `spawn` to `ReviewServerOptions` in `packages/server/review.ts`**

In the `ReviewServerOptions` interface (after `prMetadata` around line 58), add:

```typescript
  /** Whether the UI is in standalone spawn mode (changes button labels) */
  spawn?: boolean;
```

- [ ] **Step 4: Include `spawn` in the `/api/diff` response in `packages/server/review.ts`**

Destructure `spawn` from options at line 95:

```typescript
const { htmlContent, origin, gitContext, sharingEnabled = true, shareBaseUrl, onReady, prMetadata, spawn } = options;
```

Add `spawn` to the `/api/diff` response object (inside the `Response.json({...})` at lines 256-270):

```typescript
spawn,
```

- [ ] **Step 5: Add `spawn` to `AnnotateServerOptions` in `packages/server/annotate.ts`**

In the `AnnotateServerOptions` interface (after `onReady` around line 52), add:

```typescript
  /** Whether the UI is in standalone spawn mode (changes button labels) */
  spawn?: boolean;
```

- [ ] **Step 6: Include `spawn` in the annotate `/api/plan` response in `packages/server/annotate.ts`**

Destructure `spawn` from options alongside existing fields at line 87:

```typescript
const {
  markdown,
  filePath,
  htmlContent,
  origin,
  mode = "annotate",
  folderPath,
  sharingEnabled = true,
  shareBaseUrl,
  pasteApiUrl,
  onReady,
  spawn,
} = options;
```

Add `spawn` to the `/api/plan` response at line 135:

```typescript
return Response.json({
  plan: markdown,
  origin,
  mode,
  filePath,
  sharingEnabled,
  shareBaseUrl,
  pasteApiUrl,
  repoInfo,
  projectRoot: folderPath || process.cwd(),
  isWSL: wslFlag,
  serverConfig: getServerConfig(gitUser),
  spawn,
});
```

- [ ] **Step 7: Verify builds**

Run: `cd /Users/ch7258/git/plannotator && bun run build:hook`
Expected: Builds without errors

- [ ] **Step 8: Commit**

```bash
git add packages/server/index.ts packages/server/review.ts packages/server/annotate.ts
git commit -m "feat: add spawn option to plan, review, and annotate server interfaces"
```

---

### Task 3: UI button label changes in spawn mode

**Files:**
- Modify: `packages/editor/App.tsx` (lines ~414-449 for reading spawn from API, lines ~1134-1206 for buttons)
- Modify: `packages/review-editor/App.tsx` (lines ~425-474 for reading spawn from API, lines ~1244-1329 for buttons)

- [ ] **Step 1: Add `spawn` state to `packages/editor/App.tsx`**

Find the state declarations area (around line 92-100). Add a new state variable near the `annotateMode` state:

```typescript
const [spawnMode, setSpawnMode] = useState(false);
```

In the `useEffect` that fetches `/api/plan` (around line 414-449), after the existing state-setting from the API response, add:

```typescript
if (data.spawn) setSpawnMode(true);
```

- [ ] **Step 2: Update button labels in `packages/editor/App.tsx`**

Find the deny/feedback button label area (around lines 1158-1163). The current label logic is:

```tsx
annotateMode ? (allAnnotations.length > 0 || editorAnnotations.length > 0 || linkedDocHook.docAnnotationCount > 0 ? 'Send Annotations' : 'Done') : 'Send Feedback'
```

Replace with:

```tsx
spawnMode ? 'Send to Claude'
  : annotateMode ? (allAnnotations.length > 0 || editorAnnotations.length > 0 || linkedDocHook.docAnnotationCount > 0 ? 'Send Annotations' : 'Done')
  : 'Send Feedback'
```

Apply the same change to the `title` attribute on the same button (the `title=` prop a few lines above the `<span>`).

Find the approve button rendering condition (around line 1166). Currently it has `{!annotateMode && ...}`. Change to show in annotate+spawn mode too:

```tsx
{(!annotateMode || spawnMode) && (
```

Find the approve button label (around line 1197). The current label is `'Approve'`. Replace with:

```tsx
spawnMode ? 'Dismiss' : 'Approve'
```

Also update the submitting label from `'Approving...'` to:

```tsx
spawnMode ? 'Dismissing...' : 'Approving...'
```

- [ ] **Step 3: Change approve behavior in spawn mode for `packages/editor/App.tsx`**

In spawn mode, "Dismiss" should close the UI without feedback. Find the `handleApprove` call in the approve button's onClick (around line 1185). Wrap it:

```tsx
if (spawnMode) {
  // Dismiss: close without sending feedback
  window.close();
  return;
}
handleApprove();
```

- [ ] **Step 4: Add `spawn` state to `packages/review-editor/App.tsx`**

Find the state declarations area. Add:

```typescript
const [spawnMode, setSpawnMode] = useState(false);
```

In the `useEffect` that fetches `/api/diff` (around lines 425-474), after setting other state from the response, add:

```typescript
if (data.spawn) setSpawnMode(true);
```

- [ ] **Step 5: Update button labels in `packages/review-editor/App.tsx`**

Find the "Send Feedback" button label area (around line 1273). Replace the label logic:

Current:
```tsx
platformMode ? 'Post Comments' : 'Send Feedback'
```

New:
```tsx
spawnMode ? 'Send to Claude' : (platformMode ? 'Post Comments' : 'Send Feedback')
```

Find the "Approve" button label (around line 1309). Replace:

Current: `"Approve"` / `"Approve - no changes needed"`

New:
```tsx
spawnMode ? 'Dismiss' : "Approve - no changes needed"
```

- [ ] **Step 6: Change approve behavior in spawn mode for `packages/review-editor/App.tsx`**

In the approve button's onClick handler (around lines 1280-1291), add a spawn mode check at the top:

```tsx
if (spawnMode) {
  window.close();
  return;
}
```

- [ ] **Step 7: Build the UI and verify**

Run: `cd /Users/ch7258/git/plannotator && bun run --cwd apps/review build && bun run build:hook`
Expected: Builds without errors

- [ ] **Step 8: Commit**

```bash
git add packages/editor/App.tsx packages/review-editor/App.tsx
git commit -m "feat: update button labels for spawn mode (Send to Claude / Dismiss)"
```

---

### Task 4: New `plan` subcommand in CLI entry point

**Files:**
- Modify: `apps/hook/server/index.ts` (add new subcommand block between `annotate` and `annotate-hook`, around line 434)

- [ ] **Step 1: Add imports for spawn utilities**

At the top of `apps/hook/server/index.ts` (around line 58-84, after the existing imports), add:

```typescript
import { isSpawnMode, spawnClaudeSession } from "@plannotator/server/spawn";
```

- [ ] **Step 2: Consume `--spawn` from global args**

After the `--browser` flag handling (around line 103), add:

```typescript
// Global flag: --spawn (or PLANNOTATOR_SPAWN env var)
const spawnFlag = isSpawnMode();
// Remove --spawn from args so it doesn't confuse subcommand routing
const spawnIdx = args.indexOf("--spawn");
if (spawnIdx !== -1) args.splice(spawnIdx, 1);
```

- [ ] **Step 3: Add the `plan` subcommand block**

Insert a new `else if` block for `args[0] === "plan"` between the `annotate` block (ending at line 433) and the `annotate-hook` block (starting at line 435):

```typescript
} else if (args[0] === "plan") {
  // ============================================
  // STANDALONE PLAN REVIEW MODE
  // ============================================
  // Opens plan review UI with content from a file, archive, or stdin.
  // With --spawn / PLANNOTATOR_SPAWN: spawns a new `claude` session with feedback.

  const projectRoot = process.env.PLANNOTATOR_CWD || process.cwd();
  const planProject = (await detectProjectName()) ?? "_unknown";

  let planContent = "";

  if (args.includes("--archive")) {
    // Archive mode: open archive browser, user picks a plan
    const server = await startPlannotatorServer({
      plan: "",
      origin: detectedOrigin,
      mode: "archive",
      sharingEnabled,
      shareBaseUrl,
      spawn: spawnFlag,
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
      project: planProject,
      startedAt: new Date().toISOString(),
      label: `plan-archive-${planProject}`,
    });

    await server.waitForDone!();
    await Bun.sleep(500);
    server.stop();
    process.exit(0);
  }

  // Determine plan source: file path or stdin (-)
  const source = args[1];
  if (!source) {
    console.error("Usage: plannotator plan <file.md | --archive | ->");
    process.exit(1);
  }

  if (source === "-") {
    // Read from stdin
    planContent = await Bun.stdin.text();
  } else {
    // Read from file
    const { resolve } = await import("node:path");
    const filePath = resolve(projectRoot, source);
    try {
      planContent = await Bun.file(filePath).text();
    } catch {
      console.error(`Cannot read file: ${filePath}`);
      process.exit(1);
    }
  }

  if (!planContent.trim()) {
    console.error("Empty plan content");
    process.exit(1);
  }

  // Start the plan review server
  const server = await startPlannotatorServer({
    plan: planContent,
    origin: detectedOrigin,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    spawn: spawnFlag,
    htmlContent: planHtmlContent,
    onReady: (url, isRemote, port) => {
      handleServerReady(url, isRemote, port);
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

  if (spawnFlag && !result.approved && result.feedback) {
    // Spawn mode: launch claude with the plan + feedback
    const prompt = [
      "# Plan Review Feedback\n",
      "## Original Plan\n",
      planContent,
      "\n\n## Reviewer Feedback\n",
      result.feedback,
      "\n\nPlease address the feedback in the annotations above.",
    ].join("\n");

    const exitCode = await spawnClaudeSession(projectRoot, prompt);
    process.exit(exitCode);
  } else if (spawnFlag && result.approved) {
    // Dismiss — no action
    process.exit(0);
  } else if (result.feedback) {
    // Non-spawn mode: print feedback to stdout
    console.log(result.feedback);
  }

  process.exit(0);
```

- [ ] **Step 4: Verify builds**

Run: `cd /Users/ch7258/git/plannotator && bun run build:hook`
Expected: Builds without errors

- [ ] **Step 5: Manual test — file input**

Create a test plan file and run:

```bash
echo "# Test Plan\n\n- Step 1\n- Step 2" > /tmp/test-plan.md
plannotator plan /tmp/test-plan.md
```

Expected: Browser opens with plan review UI, "Send Feedback" / "Approve" buttons visible

- [ ] **Step 6: Manual test — spawn mode**

```bash
plannotator plan /tmp/test-plan.md --spawn
```

Expected: Browser opens, buttons show "Send to Claude" / "Dismiss". Submitting feedback spawns an interactive `claude` session.

- [ ] **Step 7: Commit**

```bash
git add apps/hook/server/index.ts
git commit -m "feat: add plan subcommand for standalone plan review"
```

---

### Task 5: `--spawn` flag for `review` and `annotate` subcommands

**Files:**
- Modify: `apps/hook/server/index.ts` (review block lines 397-411, annotate block lines 413-433, `runReviewFlow` lines 238-350, `runAnnotateFlow` lines 131-229)

- [ ] **Step 1: Add `spawn` parameter to `runReviewFlow()`**

Change the function signature at line 238:

```typescript
async function runReviewFlow(
  reviewArg: string | undefined,
  projectRoot: string,
  spawn?: boolean,
): Promise<string>
```

Pass `spawn` to `startReviewServer()` in the server options (around line 299):

```typescript
const server = await startReviewServer({
  rawPatch: patch,
  gitRef: label,
  error: diffError,
  htmlContent: reviewHtmlContent,
  origin: detectedOrigin,
  diffType,
  gitContext,
  sharingEnabled,
  shareBaseUrl,
  spawn,
  ...
```

- [ ] **Step 2: Add `spawn` parameter to `runAnnotateFlow()`**

Change the function signature at line 131:

```typescript
async function runAnnotateFlow(
  filePath: string,
  projectRoot: string,
  spawn?: boolean,
): Promise<string>
```

Pass `spawn` to `startAnnotateServer()` in the server options (around line 188):

```typescript
const server = await startAnnotateServer({
  markdown,
  filePath: resolvedPath,
  htmlContent: planHtmlContent,
  origin: detectedOrigin,
  mode: annotateMode,
  folderPath,
  sharingEnabled,
  shareBaseUrl,
  pasteApiUrl,
  spawn,
  ...
```

- [ ] **Step 3: Update `review` subcommand to handle spawn**

Replace the review subcommand block (lines 397-411):

```typescript
} else if (args[0] === "review") {
  // ============================================
  // CODE REVIEW MODE
  // ============================================

  const projectRoot = process.env.PLANNOTATOR_CWD || process.cwd();

  try {
    const feedback = await runReviewFlow(args[1], projectRoot, spawnFlag);

    if (spawnFlag && feedback) {
      const prompt = [
        "# Code Review Feedback\n",
        feedback,
        "\n\nPlease address the review feedback above.",
      ].join("\n");
      const exitCode = await spawnClaudeSession(projectRoot, prompt);
      process.exit(exitCode);
    }

    console.log(feedback);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  process.exit(0);
```

- [ ] **Step 4: Update `annotate` subcommand to handle spawn**

Replace the annotate subcommand block (lines 413-433):

```typescript
} else if (args[0] === "annotate") {
  // ============================================
  // ANNOTATE MODE
  // ============================================

  const filePath = args[1];
  if (!filePath) {
    console.error("Usage: plannotator annotate <file.md | folder/>");
    process.exit(1);
  }

  const projectRoot = process.env.PLANNOTATOR_CWD || process.cwd();

  try {
    const feedback = await runAnnotateFlow(filePath, projectRoot, spawnFlag);

    if (spawnFlag && feedback) {
      const prompt = [
        "# Annotation Feedback\n",
        feedback,
        "\n\nPlease address the annotations above.",
      ].join("\n");
      const exitCode = await spawnClaudeSession(projectRoot, prompt);
      process.exit(exitCode);
    }

    console.log(feedback);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  process.exit(0);
```

- [ ] **Step 5: Verify builds**

Run: `cd /Users/ch7258/git/plannotator && bun run build:hook`
Expected: Builds without errors

- [ ] **Step 6: Manual test — review with spawn**

```bash
plannotator review --spawn
```

Expected: Browser opens code review with "Send to Claude" / "Dismiss" buttons. Submitting spawns `claude` with diff feedback.

- [ ] **Step 7: Commit**

```bash
git add apps/hook/server/index.ts
git commit -m "feat: add --spawn flag to review and annotate subcommands"
```

---

### Task 6: Add PR inline review comment types

**Files:**
- Modify: `packages/shared/pr-provider.ts` (add `PRInlineComment` type and extend `PRContext`)
- Modify: `packages/shared/pr-github.ts` (add fetch function for inline comments)

- [ ] **Step 1: Add `PRInlineComment` type to `packages/shared/pr-provider.ts`**

After the existing `PRReviewFileComment` interface (around line 145), add:

```typescript
/** An existing inline review comment on a PR diff */
export interface PRInlineComment {
  id: number;
  author: string;
  body: string;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
  createdAt: string;
  url: string;
  /** The review this comment belongs to (if any) */
  inReplyToId?: number;
  /** Start line for multi-line comments */
  startLine?: number;
  /** Original line for outdated comments */
  originalLine?: number;
}
```

- [ ] **Step 2: Add `inlineComments` to `PRContext`**

Extend the `PRContext` interface (around line 124) to include inline comments:

```typescript
export interface PRContext {
  body: string;
  state: string;
  isDraft: boolean;
  labels: Array<{ name: string; color: string }>;
  reviewDecision: string;
  mergeable: string;
  mergeStateStatus: string;
  comments: PRComment[];
  reviews: PRReview[];
  checks: PRCheck[];
  linkedIssues: PRLinkedIssue[];
  inlineComments?: PRInlineComment[];
}
```

- [ ] **Step 3: Add `fetchGhInlineComments()` to `packages/shared/pr-github.ts`**

Add a new export function after `fetchGhPRContext()`:

```typescript
/** Fetch inline review comments on a GitHub PR diff */
export async function fetchGhInlineComments(
  runtime: PRRuntime,
  ref: GhPRRef,
): Promise<PRInlineComment[]> {
  const result = await runtime.runCommand("gh", [
    "api",
    `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
    "--paginate",
    "--jq",
    '[.[] | {id: .id, author: .user.login, body: .body, path: .path, line: .line, side: .side, createdAt: .created_at, url: .html_url, inReplyToId: .in_reply_to_id, startLine: .start_line, originalLine: .original_line}]',
  ]);

  if (result.exitCode !== 0) {
    return []; // Non-fatal: inline comments are supplementary
  }

  try {
    // gh --paginate with --jq may return multiple JSON arrays (one per page)
    const raw = result.stdout.trim();
    if (!raw) return [];
    const arrays = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return arrays.flat();
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Wire inline comments into `fetchGhPRContext()`**

In `packages/shared/pr-github.ts`, modify `fetchGhPRContext()` to also fetch inline comments. After the existing `parseGhPRContext(raw)` call (around line 182), add:

```typescript
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
  const context = parseGhPRContext(raw);

  // Fetch inline review comments (supplementary, non-fatal)
  context.inlineComments = await fetchGhInlineComments(runtime, ref);

  return context;
}
```

- [ ] **Step 5: Verify builds**

Run: `cd /Users/ch7258/git/plannotator && bun run build:hook`
Expected: Builds without errors

- [ ] **Step 6: Commit**

```bash
git add packages/shared/pr-provider.ts packages/shared/pr-github.ts
git commit -m "feat: add PR inline review comment types and GitHub fetching"
```

---

### Task 7: Add `prComment` field to annotation types and export

**Files:**
- Modify: `packages/ui/types.ts` (add `prComment` field to `CodeAnnotation`)
- Modify: `packages/review-editor/utils/exportFeedback.ts` (export PR comment responses)
- Modify: `packages/review-editor/utils/exportFeedback.test.ts` (add test for PR comment export)

- [ ] **Step 1: Add `prComment` field to `CodeAnnotation` in `packages/ui/types.ts`**

In the `CodeAnnotation` interface (around lines 65-79), add after the `source` field:

```typescript
  /** PR comment this annotation responds to */
  prComment?: {
    id: number;
    author: string;
    body: string;
    path?: string;
    line?: number;
  };
```

- [ ] **Step 2: Add PR comment response section to `exportReviewFeedback()` in `packages/review-editor/utils/exportFeedback.ts`**

After the main file-grouped annotation export loop (around line 80), add a section for PR comment responses:

```typescript
  // Export PR comment responses
  const commentResponses = annotations.filter((a) => a.prComment);
  if (commentResponses.length > 0) {
    output += "## PR Comment Responses\n\n";
    for (const ann of commentResponses) {
      const pc = ann.prComment!;
      const location = pc.path && pc.line ? ` on ${pc.path}:${pc.line}` : "";
      output += `### @${pc.author}${location}\n`;
      output += `> ${pc.body.split("\n").join("\n> ")}\n\n`;
      if (ann.text) {
        output += `${ann.text}\n\n`;
      }
    }
  }
```

- [ ] **Step 3: Add test for PR comment export in `packages/review-editor/utils/exportFeedback.test.ts`**

Read the existing test file first, then add a new test case:

```typescript
test("exports PR comment responses", () => {
  const annotations: CodeAnnotation[] = [
    {
      id: "1",
      type: "comment",
      filePath: "src/auth.ts",
      lineStart: 42,
      lineEnd: 42,
      side: "new",
      text: "Yes, we should add rate limiting here.",
      createdAt: Date.now(),
      prComment: {
        id: 123,
        author: "reviewer",
        body: "Should we add rate limiting here?",
        path: "src/auth.ts",
        line: 42,
      },
    },
  ];

  const result = exportReviewFeedback(annotations);
  expect(result).toContain("## PR Comment Responses");
  expect(result).toContain("@reviewer on src/auth.ts:42");
  expect(result).toContain("> Should we add rate limiting here?");
  expect(result).toContain("Yes, we should add rate limiting here.");
});
```

- [ ] **Step 4: Run the test**

Run: `cd /Users/ch7258/git/plannotator && bun test packages/review-editor/utils/exportFeedback.test.ts`
Expected: All tests pass including the new one

- [ ] **Step 5: Commit**

```bash
git add packages/ui/types.ts packages/review-editor/utils/exportFeedback.ts packages/review-editor/utils/exportFeedback.test.ts
git commit -m "feat: add prComment field to CodeAnnotation and PR comment export"
```

---

### Task 8: Display PR inline comments in the review UI

**Files:**
- Create: `packages/review-editor/components/PRInlineComment.tsx`
- Modify: `packages/review-editor/components/DiffViewer.tsx` (or wherever diff lines are rendered — investigate)
- Modify: `packages/review-editor/hooks/usePRContext.ts` (expose inline comments)

This task requires reading the `DiffViewer` component to understand how diff lines are rendered, since inline comments need to be positioned at specific file+line locations. The implementer should:

- [ ] **Step 1: Read the DiffViewer component to understand line rendering**

Read `packages/review-editor/components/DiffViewer.tsx` (or the component responsible for rendering diff lines). Identify where individual diff lines are rendered — this is where inline comment indicators will be inserted.

- [ ] **Step 2: Create `packages/review-editor/components/PRInlineComment.tsx`**

A compact component that renders an inline PR comment:

```tsx
import React, { useState } from 'react';
import type { PRInlineComment as PRInlineCommentType } from '@plannotator/shared/pr-provider';

interface PRInlineCommentProps {
  comment: PRInlineCommentType;
  onRespond: (commentId: number, response: string) => void;
}

export function PRInlineComment({ comment, onRespond }: PRInlineCommentProps) {
  const [isResponding, setIsResponding] = useState(false);
  const [response, setResponse] = useState('');

  return (
    <div className="mx-2 my-1 rounded border border-border bg-muted/30 p-2 text-xs">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
        <span className="font-medium text-foreground">@{comment.author}</span>
        <span>&middot;</span>
        <span>{new Date(comment.createdAt).toLocaleDateString()}</span>
      </div>
      <div className="text-foreground/90 whitespace-pre-wrap">{comment.body}</div>
      {!isResponding ? (
        <button
          onClick={() => setIsResponding(true)}
          className="mt-1 text-[10px] text-accent hover:underline"
        >
          Reply with annotation
        </button>
      ) : (
        <div className="mt-2">
          <textarea
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            placeholder="Your response..."
            className="w-full rounded border border-border bg-background p-1.5 text-xs resize-none"
            rows={2}
            autoFocus
          />
          <div className="flex gap-1.5 mt-1">
            <button
              onClick={() => {
                if (response.trim()) {
                  onRespond(comment.id, response.trim());
                  setResponse('');
                  setIsResponding(false);
                }
              }}
              className="px-2 py-0.5 rounded bg-accent text-accent-foreground text-[10px]"
            >
              Add
            </button>
            <button
              onClick={() => { setIsResponding(false); setResponse(''); }}
              className="px-2 py-0.5 rounded bg-muted text-muted-foreground text-[10px]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Integrate inline comments into the diff viewer**

This step depends heavily on the DiffViewer's structure (discovered in step 1). The general approach:

1. Group `prContext.inlineComments` by `path` and `line`
2. After each diff line row, check if there are inline comments for that file+line
3. If so, render a `<PRInlineComment>` for each
4. The `onRespond` callback creates a `CodeAnnotation` with the `prComment` field populated

The implementer should adapt the exact insertion point based on the DiffViewer's DOM structure.

- [ ] **Step 4: Wire `onRespond` to create annotations**

When the user responds to a PR comment, create a `CodeAnnotation` with the `prComment` metadata:

```typescript
const handlePRCommentResponse = (comment: PRInlineCommentType, response: string) => {
  const annotation: CodeAnnotation = {
    id: crypto.randomUUID(),
    type: 'comment',
    filePath: comment.path,
    lineStart: comment.line ?? 0,
    lineEnd: comment.line ?? 0,
    side: comment.side === 'LEFT' ? 'old' : 'new',
    text: response,
    createdAt: Date.now(),
    prComment: {
      id: comment.id,
      author: comment.author,
      body: comment.body,
      path: comment.path,
      line: comment.line ?? undefined,
    },
  };
  // Add to annotation state (use existing annotation add mechanism)
};
```

- [ ] **Step 5: Build and verify**

Run: `cd /Users/ch7258/git/plannotator && bun run --cwd apps/review build && bun run build:hook`
Expected: Builds without errors

- [ ] **Step 6: Manual test**

Test with an actual PR that has inline review comments:

```bash
plannotator review https://github.com/<owner>/<repo>/pull/<number> --spawn
```

Expected: Inline comments appear on the diff at the correct file/line positions. Clicking "Reply with annotation" opens a text input. Submitting creates an annotation with PR comment context. "Send to Claude" exports the response in the "PR Comment Responses" section.

- [ ] **Step 7: Commit**

```bash
git add packages/review-editor/components/PRInlineComment.tsx packages/review-editor/components/DiffViewer.tsx packages/review-editor/hooks/usePRContext.ts
git commit -m "feat: display PR inline review comments in diff viewer with reply support"
```

---

### Task 9: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add `plan` subcommand and `--spawn` flag documentation**

In the CLAUDE.md header comment that documents modes (around the top), add documentation for the new `plan` subcommand. Also add `PLANNOTATOR_SPAWN` to the Environment Variables table.

In the "Environment Variables" section, add:

```markdown
| `PLANNOTATOR_SPAWN` | Set to `1` or `true` to enable spawn mode. Feedback spawns a new `claude` session instead of writing hook output. |
```

In the "Project Structure" section or a new "CLI Usage" section, document:

```markdown
## Standalone Mode

Plannotator can run independently of hooks, opening a review UI and spawning a new `claude` session with the feedback:

\`\`\`bash
# Plan review from file
plannotator plan ./roadmap.md --spawn

# Plan review from archive
plannotator plan --archive --spawn

# Plan review from stdin
cat plan.md | plannotator plan - --spawn

# Code review with spawn
plannotator review --spawn
plannotator review https://github.com/org/repo/pull/42 --spawn

# Annotate with spawn
plannotator annotate ./notes.md --spawn

# Or set env var instead of --spawn flag
export PLANNOTATOR_SPAWN=1
plannotator plan ./roadmap.md
\`\`\`

Without `--spawn`, the `plan` subcommand prints feedback to stdout. The `review` and `annotate` subcommands behave as before (stdout for slash commands, hook JSON for hook subcommands).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document plan subcommand, --spawn flag, and PLANNOTATOR_SPAWN env var"
```
