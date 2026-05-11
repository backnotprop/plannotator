// Injects "1\n" into CC terminal to auto-select the plan-accept "clear + bypass" option.
const MACOS_PROCESS_TERMINALS = ["iTerm2", "Terminal"];

export function spawnKeystrokeInjector(delayMs = 600): void {
  const delaySec = (delayMs / 1000).toFixed(2);
  const tmuxPane = process.env["TMUX_PANE"];

  let script: string | null = null;

  if (tmuxPane) {
    script = `sleep ${delaySec} && tmux send-keys -t ${JSON.stringify(tmuxPane)} 1 Enter`;
  } else if (process.platform === "darwin") {
    const apps = MACOS_PROCESS_TERMINALS.map((a) => `"${a}"`).join(", ");
    // Warp ships as Warp.app/MacOS/stable so its process name is "stable", not "warp".
    // Check by bundle name first, then fall back to process-name search for other terminals.
    script = [
      `osascript <<'APPLESCRIPT'`,
      `delay ${delaySec}`,
      `if application "Warp" is running then`,
      `  tell application "Warp" to activate`,
      `  delay 0.05`,
      `  tell application "System Events"`,
      `    keystroke "1"`,
      `    key code 36`,
      `  end tell`,
      `else`,
      `  tell application "System Events"`,
      `    repeat with appName in {${apps}}`,
      `      if exists (application process (appName as string)) then`,
      `        set frontmost of application process (appName as string) to true`,
      `        delay 0.05`,
      `        keystroke "1"`,
      `        key code 36`,
      `        exit repeat`,
      `      end if`,
      `    end repeat`,
      `  end tell`,
      `end if`,
      `APPLESCRIPT`,
    ].join("\n");
  }

  if (!script) return; // Linux/Windows without tmux: user must press 1 manually

  const child = Bun.spawn(["bash", "-c", script], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
}
