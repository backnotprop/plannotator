# Session Lifecycle — Manual Testing

## Setup

```bash
git checkout feat/session-lifecycle
bun run --cwd apps/frontend build
bun run dev:frontend
```

Note the daemon port from the output. The frontend runs on its own Vite port (probably 3003).

---

## 1. No frontend open — browser should open

Close all browser tabs. Run:

```bash
printf '{"hook_event_name":"PermissionRequest","tool_name":"ExitPlanMode","tool_input":{"plan":"# Test Plan\n\n- [ ] Step one"},"permission_mode":"default"}' | bun apps/hook/server/index.ts
```

**Expect:** A new browser tab opens with the plan. Sidebar is collapsed. Plan content visible.

---

## 2. Frontend visible — toast instead of new tab

Keep the tab from test 1 open. In another terminal, run:

```bash
AUTH=$(jq -r .authToken ~/.plannotator/daemon.json)
PORT=$(jq -r .port ~/.plannotator/daemon.json)
curl -s -X POST "http://localhost:${PORT}/daemon/sessions" \
  -H "Authorization: Bearer ${AUTH}" \
  -H "Content-Type: application/json" \
  -d '{"request":{"action":"plan","origin":"claude-code","cwd":"'$(pwd)'","plan":"# Second Plan\n\nThis should toast."}}'
```

**Expect:** No new tab. A toast appears in the existing tab (bottom-right) with "Plan Review — [project]" and an "Open" button. Toast dismisses after ~8 seconds. Sidebar shows the new session.

---

## 3. Toast action navigates

Click the "Open" button on the toast before it dismisses.

**Expect:** Frontend navigates to the new session. Plan content shows "Second Plan."

---

## 4. Approve a plan — banner, not overlay

Click "Approve" on the current plan.

**Expect:** Green banner at top: "Plan Approved — Claude Code will proceed with the implementation." No full-screen overlay. No auto-close. Action buttons disappear. Plan content stays visible and scrollable. Session stays in sidebar with a status badge.

---

## 5. Refresh after approval — content survives

Hard refresh the page (Cmd+R).

**Expect:** The plan content reloads. The banner shows again. Content is served from the disk snapshot.

---

## 6. Sidebar persistence

Open the sidebar (click the trigger).

**Expect:** Completed sessions show with a visual indicator (check icon, muted text). Active sessions show with a green dot. Completed sessions are clickable and navigate to their content.

---

## 7. Frontend backgrounded — new tab opens

Switch to a different app (e.g., VS Code or Finder) so the browser tab is not visible. Run:

```bash
curl -s -X POST "http://localhost:${PORT}/daemon/sessions" \
  -H "Authorization: Bearer ${AUTH}" \
  -H "Content-Type: application/json" \
  -d '{"request":{"action":"review","origin":"claude-code","cwd":"'$(pwd)'","args":""}}'
```

**Expect:** Chrome comes to the foreground with a new tab showing the code review session.

---

## 8. Daemon restart — old sessions appear

Stop the dev server (Ctrl+C). Restart:

```bash
bun run dev:frontend
```

Open the frontend. Open the sidebar.

**Expect:** Completed sessions from previous daemon run appear in the sidebar. Clicking one loads its content from disk.

---

## 9. Direct session link — sidebar collapsed

Copy a session URL (e.g., `http://localhost:PORT/s/sess_abc...`). Open it in a new tab.

**Expect:** Session loads with sidebar collapsed. Session surface fills the screen.

Navigate to `http://localhost:PORT/` (root).

**Expect:** Sidebar is open.

---

## 10. Legacy tab mode

Edit `~/.plannotator/config.json`, add `"legacyTabMode": true`. With the frontend open and visible, run:

```bash
printf '{"hook_event_name":"PermissionRequest","tool_name":"ExitPlanMode","tool_input":{"plan":"# Legacy Test\n\nShould open new tab."},"permission_mode":"default"}' | bun apps/hook/server/index.ts
```

**Expect:** A new browser tab opens (even though frontend is already visible). Approve the plan — full-screen overlay appears with auto-close countdown (not the inline banner).

Remove `"legacyTabMode": true` from config when done.

---

## 11. All modes work

Create sessions for each mode and verify they all follow the same flow:

```bash
# Annotate
curl -s -X POST "http://localhost:${PORT}/daemon/sessions" \
  -H "Authorization: Bearer ${AUTH}" -H "Content-Type: application/json" \
  -d '{"request":{"action":"annotate","origin":"claude-code","cwd":"'$(pwd)'","markdown":"# Test annotation","filePath":"test.md"}}'

# Archive
curl -s -X POST "http://localhost:${PORT}/daemon/sessions" \
  -H "Authorization: Bearer ${AUTH}" -H "Content-Type: application/json" \
  -d '{"request":{"action":"archive","origin":"claude-code","cwd":"'$(pwd)'"}}'
```

**Expect:** Each mode toasts (if frontend visible) or opens a tab (if not). Sidebar shows all. Completion behavior is identical.
