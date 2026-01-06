# Plannotator Devcontainer Test

This directory contains a devcontainer setup for testing Plannotator with OpenCode in a containerized environment.

## Prerequisites

1. Docker installed and running
2. VS Code with Dev Containers extension
3. OpenCode auth configured on your host machine (`~/.local/share/opencode/auth.json`)

## Setup

1. **Create auth symlink** (one-time setup on host):
   ```bash
   mkdir -p .opencode
   ln ~/.local/share/opencode/auth.json .opencode/auth.json
   ```

2. **Open in VS Code**:
   ```bash
   code tests/devcontainer
   ```

3. **Reopen in Container**: When prompted, click "Reopen in Container" or use Command Palette: `Dev Containers: Reopen in Container`

## Testing Plannotator

The devcontainer is pre-configured with:
- `PLANNOTATOR_REMOTE=1` - enables remote mode
- `PLANNOTATOR_PORT=9999` - fixed port for the UI
- Port 9999 forwarded to host

### Test Steps

1. Inside the container terminal, run OpenCode:
   ```bash
   opencode
   ```
   Or for web interface:
   ```bash
   opencode web
   ```
   Then access http://localhost:4096 in your browser.

2. Ask OpenCode to create a plan (e.g., "Create a plan to add user authentication")

3. When OpenCode calls `submit_plan`, Plannotator should:
   - Start server on port 9999 (not random)
   - Not try to open browser (remote mode)

4. Open `http://localhost:9999` in your host browser

5. Approve or deny the plan

## Expected Behavior

**Before fix (v0.4.0):** Plugin hangs trying to open browser, random port unusable

**After fix:**
- Server uses fixed port 9999
- No browser open attempt
- Works via port forwarding

## Troubleshooting

**Plugin not updating?**
```bash
rm -rf ~/.cache/opencode/node_modules/@plannotator
```

**OpenCode crashes/aborts on startup?**
```bash
rm -rf ~/.cache/opencode
```

**Port not forwarding?**
Check VS Code "Ports" tab, ensure 9999 is listed and forwarded.

**Auth issues?**
Ensure `.opencode/auth.json` exists and contains valid credentials.
