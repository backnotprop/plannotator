// Opt-in helper that injects "1\n" into CC terminal to auto-select native clear + bypass.
import { appendFileSync, mkdirSync } from "node:fs";

const MACOS_PROCESS_TERMINALS = ["iTerm2", "Terminal"];

// osascript stderr is redirected here so an Accessibility/Automation (TCC)
// denial is diagnosable instead of failing silently.
const INJECTOR_LOG_DIR = `${process.env["HOME"] ?? "~"}/.plannotator`;
const INJECTOR_LOG = `${INJECTOR_LOG_DIR}/keystroke-injector.log`;

export function shouldAutoSelectNativeClear(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env["PLANNOTATOR_AUTO_SELECT_NATIVE_CLEAR"] === "1";
}

// Both UI paths into the native-defer branch are explicit user opt-ins: the
// one-shot dialog button sends deferToNativeForClear, the persistent
// permission-mode setting sends permissionMode="deferNative" (configured in
// settings, replayed from storage). Either fires the injector; the env var
// remains as a force-on override for other flows.
export function shouldFireInjector(
  result: { deferToNativeForClear?: boolean; permissionMode?: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    result.deferToNativeForClear === true ||
    result.permissionMode === "deferNative" ||
    shouldAutoSelectNativeClear(env)
  );
}

// Records why the defer branch did/didn't inject — an empty log was previously
// ambiguous between "branch not entered" and "gate skipped".
export function logInjectorDecision(
  result: { deferToNativeForClear?: boolean; permissionMode?: string },
  fired: boolean,
): void {
  try {
    mkdirSync(INJECTOR_LOG_DIR, { recursive: true });
    const time = new Date().toISOString();
    appendFileSync(
      INJECTOR_LOG,
      `${time} defer-branch flag=${result.deferToNativeForClear === true} mode=${result.permissionMode ?? "none"} injector=${fired ? "fired" : "skipped"}\n`,
    );
  } catch {
    // Logging must never block the approval flow.
  }
}

// Default delay raised from 600ms: CC needs time to render its native dialog
// after exit(0). Firing too early lands "1\n" before the dialog exists. No
// repeat-spray — a stray keystroke after the dialog closes lands in the prompt.
export function spawnKeystrokeInjector(delayMs = 1200): void {
  const delaySec = (delayMs / 1000).toFixed(2);
  const tmuxPane = process.env["TMUX_PANE"];

  let script: string | null = null;

  if (tmuxPane) {
    script = `mkdir -p ${JSON.stringify(INJECTOR_LOG_DIR)}; echo "$(date +%T) start" >> ${JSON.stringify(INJECTOR_LOG)}; sleep ${delaySec} && tmux send-keys -t ${JSON.stringify(tmuxPane)} 1 Enter 2>>${JSON.stringify(INJECTOR_LOG)} && echo "$(date +%T) injected" >> ${JSON.stringify(INJECTOR_LOG)}`;
  } else if (process.platform === "darwin") {
    const apps = MACOS_PROCESS_TERMINALS.map((a) => `"${a}"`).join(", ");
    // Warp ships as Warp.app/MacOS/stable so its process name is "stable", not "warp".
    // Check by bundle name first, then fall back to process-name search for other terminals.
    script = [
      `mkdir -p ${JSON.stringify(INJECTOR_LOG_DIR)}`,
      `echo "$(date +%T) start" >> ${JSON.stringify(INJECTOR_LOG)}`,
      `osascript 2>>${JSON.stringify(INJECTOR_LOG)} <<'APPLESCRIPT'`,
      `tell application "System Events" to set axEnabled to (UI elements enabled)`,
      `if not axEnabled then`,
      `  log "accessibility-not-enabled — grant Accessibility in System Settings → Privacy & Security → Accessibility"`,
      `  return`,
      `end if`,
      `log "accessibility=true"`,
      `delay ${delaySec}`,
      `if application "Warp" is running then`,
      `  tell application "Warp" to activate`,
      `  delay 0.30`,
      `  tell application "System Events"`,
      `    keystroke "1"`,
      `    delay 0.15`,
      `    key code 36`,
      `  end tell`,
      `  log "injected"`,
      `else`,
      `  tell application "System Events"`,
      `    repeat with appName in {${apps}}`,
      `      if exists (application process (appName as string)) then`,
      `        set frontmost of application process (appName as string) to true`,
      `        delay 0.30`,
      `        keystroke "1"`,
      `        delay 0.15`,
      `        key code 36`,
      `        log "injected"`,
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
