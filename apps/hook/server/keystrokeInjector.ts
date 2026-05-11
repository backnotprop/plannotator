/**
 * Detached keystroke injector for auto-confirming CC's native plan-accept dialog.
 *
 * CC renders the plan-accept dialog in the terminal ~200–500ms after the hook
 * process exits. This module spawns a background process that fires "1\n" into
 * the active CC terminal window after a configurable delay, selecting
 * "Yes, clear context and bypass permissions" without user interaction.
 *
 * Platform strategy:
 *   1. tmux ($TMUX_PANE)   → tmux send-keys (no accessibility permissions needed)
 *   2. macOS               → osascript targeting WarpTerminal, iTerm2, or Terminal
 *   3. everything else     → no-op (user must press 1 manually)
 *
 * Silent-fail contract: any error (accessibility denied, no terminal found, etc.)
 * exits the child process non-zero without affecting the hook's exit or logging noise.
 */

const KNOWN_MACOS_TERMINALS = ["warp", "iTerm2", "Terminal"] as const;

function buildTmuxScript(pane: string, delayMs: number): string {
  const delaySec = (delayMs / 1000).toFixed(2);
  return `sleep ${delaySec} && tmux send-keys -t ${JSON.stringify(pane)} 1 Enter`;
}

function buildOsascriptScript(delayMs: number): string {
  const delaySec = (delayMs / 1000).toFixed(2);
  const appList = KNOWN_MACOS_TERMINALS.map((a) => `"${a}"`).join(", ");
  // prettier-ignore
  return [
    `osascript <<'APPLESCRIPT'`,
    `delay ${delaySec}`,
    `tell application "System Events"`,
    `  repeat with appName in {${appList}}`,
    `    if exists (application process (appName as string)) then`,
    `      set frontmost of application process (appName as string) to true`,
    `      delay 0.05`,
    `      keystroke "1"`,
    `      key code 36`,
    `      exit repeat`,
    `    end if`,
    `  end repeat`,
    `end tell`,
    `APPLESCRIPT`,
  ].join("\n");
}

/**
 * Spawn a detached process that injects "1\n" into the CC terminal window.
 * Returns immediately; the child continues running after the parent exits.
 *
 * @param delayMs Milliseconds to wait before sending the keystroke (default: 600).
 *                Should be longer than CC's dialog render time (~200–500ms).
 */
export function spawnKeystrokeInjector(delayMs = 600): void {
  const tmuxPane = process.env["TMUX_PANE"];

  if (tmuxPane) {
    const script = buildTmuxScript(tmuxPane, delayMs);
    const child = Bun.spawn(["bash", "-c", script], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
    return;
  }

  if (process.platform === "darwin") {
    const script = buildOsascriptScript(delayMs);
    const child = Bun.spawn(["bash", "-c", script], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
    return;
  }

  // Linux/Windows without tmux: no-op; user must press 1 manually.
}
