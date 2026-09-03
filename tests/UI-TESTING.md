# UI Testing Guide

This guide helps you test UI changes in Plannotator. Whether you're adding new features or fixing bugs, follow these
steps to ensure your changes work correctly.

## Table of Contents

1. [Development Setup](#development-setup)
2. [Development Workflow](#development-workflow)
3. [Quick Testing Guide](#quick-testing-guide)
4. [Debugging Common Issues](#debugging-common-issues)
5. [Decision Control Manual Checklist](#decision-control-manual-checklist)
6. [WebMCP Manual Checklist](#webmcp-manual-checklist)

---

## Development Setup

### Prerequisites

- **Bun** - JavaScript runtime and package manager ([install](https://bun.sh))
- **Git** - Version control
- **Modern browser** - Chrome, Firefox, Safari, or Edge (latest version)

### Installation

```bash
git clone https://github.com/backnotprop/plannotator.git
cd plannotator
bun install
```

### Monorepo Structure

The project uses a monorepo structure:

- **`packages/`** - Shared code
  - `ui/` - Reusable React components, hooks, utilities
  - `server/` - Server implementation (plan/review servers)
  - `editor/` - Plan review application logic
  - `review-editor/` - Code review application logic

- **`apps/`** - Deployable applications
  - `hook/` - Claude Code plugin (plan review)
  - `opencode-plugin/` - OpenCode plugin
  - `review/` - Standalone review app
  - `portal/` - Share portal (share.plannotator.ai)
  - `marketing/` - Marketing site (plannotator.ai)

### First Build Test

Verify your setup works:

```bash
bun run build:hook
```

If successful, you'll see `apps/hook/dist/index.html` created.

---

## Development Workflow

### Making UI Changes

**Shared components** (used by both plan and review UIs):

- Location: `packages/ui/components/`
- Examples: `TableOfContents.tsx`, `AnnotationToolbar.tsx`, `Viewer.tsx`

**Plan editor** (plan review UI):

- Location: `packages/editor/App.tsx`
- Main application logic for plan review

**Code review editor** (code review UI):

- Location: `packages/review-editor/App.tsx`
- Main application logic for code review

**Utilities and hooks**:

- Location: `packages/ui/utils/`, `packages/ui/hooks/`
- Examples: `parser.ts`, `useActiveSection.ts`, `annotationHelpers.ts`

### Development Servers (Hot Reload)

For rapid iteration, use development servers with hot reload:

```bash
# Plan review UI (most common)
bun run dev:hook
# Opens http://localhost:5173

# Code review UI
bun run dev:review
# Opens http://localhost:5174

# Portal (share.plannotator.ai)
bun run dev:portal

# Marketing site (plannotator.ai)
bun run dev:marketing
```

**Note:** Development servers run standalone without plugin integration. Changes appear instantly without rebuild.

### Building for Testing

When you're ready to test with actual plugin integration:

```bash
# Build plan review UI
bun run build:hook
# Output: apps/hook/dist/index.html

# Build code review UI
bun run build:review
# Output: apps/review/dist/index.html

# Build OpenCode plugin
bun run build:opencode
# Copies HTML from hook/review dist folders

# Build everything
bun run build
# Runs build:hook && build:opencode
```

### Important Build Note

**The OpenCode plugin copies pre-built HTML files from hook and review dist folders.**

When making UI changes:

✅ **Correct:**

```bash
bun run build:hook && bun run build:opencode
```

❌ **Incorrect:**

```bash
bun run build:opencode  # Uses stale HTML from previous build!
```

Always rebuild hook/review apps BEFORE building OpenCode if you changed UI code.

---

## Quick Testing Guide

### Test Scripts

UI test scripts simulate plugin behavior locally:

```bash
# Plan review UI tests
./tests/manual/local/test-hook.sh          # Claude Code simulation
./tests/manual/local/test-hook-2.sh        # OpenCode origin badge test
./tests/manual/local/test-codex-plan-review-e2e.sh  # Real Codex Stop-hook E2E

# Code review UI test
./tests/manual/local/test-opencode-review.sh  # Code review UI test
```

### What Each Script Does

**`test-hook.sh`**

1. Builds the hook plugin (`bun run build:hook`)
2. Pipes sample plan JSON (includes title, SQL/TypeScript code, checklist)
3. Starts local server
4. Opens browser with plan review UI
5. Prints approve/deny decision to terminal

**`test-hook-2.sh`**

1. Builds the hook plugin
2. Starts server with `opencode` origin flag
3. Verifies blue "OpenCode" badge appears in UI
4. Tests origin detection logic

**`test-opencode-review.sh`**

1. Builds review app (`bun run build:review`)
2. Starts review server with sample git diff
3. Opens browser with code review UI
4. Verifies "OpenCode" badge + the header decision control (`Approve` at zero annotations, `Send Feedback · n` once you annotate — not "Copy Feedback")
5. Tests feedback submission flow

**`test-codex-plan-review-e2e.sh`**

1. Builds the hook + review apps (unless `--skip-build`)
2. Creates a disposable `HOME` and sample git repo
3. Copies your Codex auth into the disposable config
4. Enables `hooks` and registers a `Stop` hook pointing at the local Plannotator entrypoint
5. Runs a real `codex exec` prompt that returns only a `<proposed_plan>` block
6. Leaves behind rollout logs, Plannotator history, plan files, and session URLs in an artifact directory

This is the best harness when you want to verify the full Codex deny/revise/approve loop instead of simulating hook
payloads. For browser automation, set `PLANNOTATOR_BROWSER=/usr/bin/true`, keep the script running in one terminal,
and drive the printed session URL with Playwright from another terminal.

See [tests/README.md](../tests/README.md) for additional integration and utility test scripts.

### Manual Testing Workflow

1. **Make your changes** in `packages/ui/` or `packages/editor/`

2. **Choose testing method:**
   - **Option A:** Dev server (fast iteration)
     ```bash
     bun run dev:hook
     ```
   - **Option B:** Build and test with script (integration test)
     ```bash
     bun run build:hook && ./tests/manual/local/test-hook.sh
     ```

3. **Verify your changes** work correctly

4. **Test responsive design:**
   - Desktop (>1024px): Full layout with TOC
   - Tablet (768-1024px): TOC hidden
   - Mobile (<768px): Touch-optimized
   - Use browser DevTools (F12) → Device Toolbar (Cmd+Shift+M / Ctrl+Shift+M)

5. **Check browser console** for errors:
   - Open DevTools (F12)
   - Console tab
   - Look for red errors

6. **Test on multiple browsers** (Chrome, Firefox, Safari, Edge)

---

## Debugging Common Issues

### Browser DevTools

Open DevTools to inspect and debug:

- **Mac:** Cmd+Option+I
- **Windows/Linux:** F12 or Ctrl+Shift+I

**Useful tabs:**

- **Console:** JavaScript errors and logs
- **Network:** Failed requests, slow resources
- **Elements:** Inspect DOM and CSS
- **Performance:** Profile rendering performance
- **Memory:** Check for memory leaks

**Recommended extensions:**

- React DevTools - Inspect component tree and props
- Redux DevTools - If using Redux (not currently)

### Common Issues & Solutions

#### Port Already in Use

**Error:**

```
Error: listen EADDRINUSE: address already in use :::5173
```

**Solution:** Kill the process using that port

**macOS/Linux:**

```bash
lsof -ti:5173 | xargs kill -9
```

**Windows:**

```powershell
netstat -ano | findstr :5173
taskkill /PID <pid> /F
```

#### Module Not Found

**Error:**

```
Error: Cannot find module '@plannotator/ui'
```

**Solution:** Clean install dependencies

```bash
rm -rf node_modules
bun install
```

#### Hot Reload Not Working

**Symptom:** Changes don't appear in browser after saving file

**Solutions:**

1. Hard refresh browser: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows/Linux)
2. Restart dev server: Ctrl+C then `bun run dev:hook`
3. Clear browser cache
4. Check terminal for errors

#### CSS Not Applying

**Symptom:** Tailwind classes not working or styles look wrong

**Solutions:**

1. Check for typos in class names (Tailwind is strict)
2. Verify Tailwind config includes your file paths
3. Try rebuilding: `bun run build:hook`
4. Check if another CSS rule is overriding (use DevTools Elements tab)
5. Ensure you're using correct responsive prefixes (`sm:`, `md:`, `lg:`)

#### TypeScript/LSP Errors

**Symptom:** Editor shows red squiggles, but code works

**Important:** Many LSP errors in this codebase are warnings, not blockers.

**Solutions:**

1. Focus on fixing errors in files YOU changed
2. Run `bun run build` to see actual compilation errors
3. Existing files may have warnings - that's okay
4. If new errors appear in your files, fix them

**Common LSP warnings you can ignore:**

- "Alternative text title element cannot be empty" (SVG icons)
- "This hook does not specify its dependency" (known)
- "Provide an explicit type prop for button" (existing code)

#### Build Fails

**Error:**

```
Build failed with X errors
```

**Solutions:**

1. Read the error message carefully (shows file and line)
2. Check for syntax errors in your changes
3. Verify imports are correct
4. Run `bun install` to ensure dependencies are up to date
5. Check that file paths are correct (case-sensitive on Linux/macOS)

### Viewing Logs

**Server logs:**

- Check terminal where `bun` is running
- Server prints requests and errors
- Hook output shows approve/deny decisions

**Browser logs:**

- DevTools → Console tab
- Network tab shows request/response details
- Preserve log checkbox keeps logs across page loads

**Test script output:**

- Test scripts print to terminal
- Shows build output, server startup, and hook decisions
- Use `echo` statements to add debug output to scripts

---

## Decision Control Manual Checklist

Not CI. Every annotate surface and the review header share one adaptive split control
(`DecisionControl`): a positive primary (`Done` / `Approve` / `Send Feedback · n`) plus a caret
menu with the alternate decisions and the in-place note composer. Run each flow in both states —
zero annotations and n annotations — on desktop AND on a real phone (touch has no `Mod+Enter`,
which is the regression class this control exists to fix).

1. **Annotate, single file** (`plannotator annotate notes.md`). At zero the primary reads `Done`;
   clicking it submits the "no feedback" record and the terminal prints it. Caret →
   `Done with a note…` opens the composer in place: `Enter` inserts a newline, `Mod+Enter`
   submits, `Escape` steps back to the menu keeping the draft. Add an annotation: the primary
   flips to `Send Feedback · 1`, and `Done, discard 1 annotation…` raises the one confirm.
2. **Annotate, gate mode** (`plannotator annotate notes.md --gate --json`). The zero-state
   primary is `Approve` and posts `/api/approve` (stdout records `"approved"`; with
   `--require-approval` only approval exits `0`); `Request changes…` records an annotated
   decision. `Approve with a note…` / `Approve with notes` appear only when the session
   advertises approval-notes support.
3. **Annotate, folder and last** (`plannotator annotate docs/`, `plannotator last`). Same
   control, same states; in a folder session switch documents mid-draft and confirm the header
   count tracks the session's annotations.
4. **HTML / live-app annotate** (`plannotator annotate page.html`, `plannotator annotate
   http://localhost:<port>`). Open the caret menu, then click the framed page: the popover
   dismisses (iframe focus is the dismissal signal — there is no parent pointerdown).
5. **Review, agent mode** (`plannotator review`). `Approve` at zero, `Send Feedback · n` after
   annotating; approving despite annotations is two clicks (caret → `Approve, discard n
   annotations…` → `Discard & approve`). With the composer open, `Escape` returns to the menu
   and does NOT collapse the file tree or close the sidebar; a second `Escape` closes the menu;
   a third runs the app's own ladder. `Mod+Enter` over the open discard confirm must fire only
   the dialog, never a second submission.
6. **Review, platform (PR) mode** (`plannotator review <pr-url>`). Same control shape, no
   composer items: every menu action opens `ReviewSubmissionDialog`. On your own PR the
   approve rows are muted with the "You can't approve your own PR/MR" reason while
   `Request changes…` / `Post comments, then…` stay live.
7. **Compact/touch** (real phone or DevTools device mode, both apps). The header menu carries a
   visible positive decision row in every state; composer rows open the note dialog
   (`DecisionNoteDialog`), not an inline textarea.
8. **Sidebar general comment** (review). "+ General comment" is reachable at zero annotations
   (empty state) and from the General section header; creating one flips the header control to
   `Send Feedback · 1`.

## WebMCP Manual Checklist

Not CI. Run this in Chrome or Edge with the API on: `chrome://flags/#enable-webmcp-testing`, or launch with `--enable-features=WebMCPTesting`. Use a fresh profile so the first-run dialogs and a recovered draft do not get in the way. The Model Context Tool Inspector extension can call tools too, but the page console is enough: `const tools = await document.modelContext.getTools()` lists them, and `JSON.parse(await document.modelContext.executeTool(tools.find((t) => t.name === 'plannotator.read_document'), {}))` calls one.

Before the flows, confirm the footprint rules:

- Load `plannotator annotate <file.md>` and do nothing. Six `plannotator.*` tools are listed, but the header shows no "Agent" marker, no banner, and `document.cookie` has no `plannotator-webmcp-tools` entry.
- Load the same session in a browser without the API. Nothing in the page changes, and the Settings General tab has no "Agent tools" row.

The five flows from the design (section 3.7):

1. **What is going on in this page right now?** Call `read_document` with no arguments. Expect `session.mode`, the full text, the outline with per-section counts, the annotations, `otherDocuments`, and `cursor`. Calling it again returns the same comments with `isNew: false`.
2. **The user just annotated something, what do they want?** Open the comment composer in the page; a `read_document` while it is open carries `composer_open`. Submit the comment; the next `read_document` carries `annotations_new` naming its id and the entry has `isNew: true`.
3. **Leave a comment on section X.** Call `add_comments` with `{ section: "<outline id>", quote: "<exact text>", text: "..." }`. Expect `anchoredBy: "quote"`, a highlight in the document, and a `browser-agent` card in the panel. Repeat the same call with the same `requestId`: `created: 0`, `deduplicated: true`. Delete the card from the panel and repeat once more: the item answers `conflict` and nothing is re-created.
4. **Reply to the user's comment.** Call `add_comments` with `{ inReplyTo: "<the human's id>", text: "..." }`. The reply renders indented under the human's card and `read_document` lists it in the parent's `replies`. `update_comment` and `remove_comments` on the human's id answer `forbidden`; on the reply they succeed.
5. **Several files in a folder session.** Run `plannotator annotate <folder>`, open one document, comment in it, then open another. Call `read_document`: `otherDocuments` names the first document with its count, and an `other_document_active` nudge carries the exact `read_document { path }` call. Call `list_documents`: every file in the tree is listed. Call `reveal { annotationId, path }` for a comment in the first document: the view navigates there and the card is selected.

Then the remaining surfaces:

- `reveal { section }` scrolls to the heading; `nudge_user` shows one banner that the dismiss button removes; a 281-character message answers `invalid_input`.
- The "Agent" marker appears in the header only after the first successful call.
- Settings, General, "Agent tools" off: `getTools()` is empty and `document.cookie` now has `plannotator-webmcp-tools=false`. Back on: six tools again and the cookie is gone.
- `plannotator annotate <file.html>` and `plannotator annotate http://localhost:<port>`: from inside the iframe, `document.modelContext.getTools()` and `registerTool()` reject with `NotAllowedError`; the parent page still lists Plannotator's tools.
- Approve or send feedback from the page: the write tools disappear from `getTools()` and `read_document` carries `session_decided`.

## Need Help?

If you're stuck:

1. Check this guide again
2. Review existing code for patterns
3. Look at `CLAUDE.md` for architecture details
4. Check `tests/README.md` for test script details
5. Open an issue on GitHub with:
   - What you're trying to do
   - What you've tried
   - Error messages (full text)
   - Browser and OS version
