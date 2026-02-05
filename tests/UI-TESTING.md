# UI Testing Guide

This guide helps you test UI changes in Plannotator. Whether you're adding new features or fixing bugs, follow these
steps to ensure your changes work correctly.

## Table of Contents

1. [Development Setup](#development-setup)
2. [Development Workflow](#development-workflow)
3. [Quick Testing Guide](#quick-testing-guide)
4. [UI Feature Testing Checklists](#ui-feature-testing-checklists)
5. [Debugging Common Issues](#debugging-common-issues)

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
4. Verifies "OpenCode" badge + "Send Feedback" button (not "Copy Feedback")
5. Tests feedback submission flow

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

## UI Feature Testing Checklists

For detailed feature testing checklists, see **[UI-TESTING-CHECKLIST.md](./UI-TESTING-CHECKLIST.md)**.

The checklist covers:

- Table of Contents (TOC) feature
- Annotation features
- Sticky header
- Responsive design
- Accessibility
- Performance & browser compatibility

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
