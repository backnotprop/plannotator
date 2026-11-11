/**
 * `PLANNOTATOR_BROWSER` (and `--browser`) belongs to Plannotator: a "none" value opens nothing at all (no VS Code IPC, Glimpse, `BROWSER` or system opener); the session URL is still printed.
 * `BROWSER` is shared with other tools and set by hosts (Claude Code's agent view sets `BROWSER=true`): its no-op values are ignored and the default chain runs.
 */

export const BROWSER_NONE_VALUES: readonly string[] = ["none", "false", "0", "off", "no", "true", "1", ":"];

const BROWSER_ENV_NOOP_VALUES: ReadonlySet<string> = new Set(["true", "false", "none", ":", "0", "1"]);

const NONE_VALUES: ReadonlySet<string> = new Set(BROWSER_NONE_VALUES);

export function isBrowserNoneValue(value: string | undefined): boolean {
  if (!value) return false;
  return NONE_VALUES.has(value.trim().toLowerCase());
}

export function isNoOpBrowserSentinel(value: string | undefined): boolean {
  if (!value) return false;
  return BROWSER_ENV_NOOP_VALUES.has(value.trim().toLowerCase());
}

export type BrowserIntent =
  | { kind: "none"; value: string }
  /** Run the default chain: IPC (remote), Glimpse (local), the system opener. */
  | { kind: "default" }
  /** Launch this handler. `source` names the variable it came from. */
  | { kind: "explicit"; browser: string; source: "PLANNOTATOR_BROWSER" | "BROWSER" };

export function resolveBrowserIntent(
  env: Record<string, string | undefined> = process.env,
): BrowserIntent {
  const plannotatorBrowser = env.PLANNOTATOR_BROWSER;
  if (plannotatorBrowser && plannotatorBrowser.trim()) {
    if (isBrowserNoneValue(plannotatorBrowser)) {
      return { kind: "none", value: plannotatorBrowser.trim() };
    }
    return { kind: "explicit", browser: plannotatorBrowser, source: "PLANNOTATOR_BROWSER" };
  }
  const browser = env.BROWSER;
  if (browser && browser.trim() && !isNoOpBrowserSentinel(browser)) {
    return { kind: "explicit", browser, source: "BROWSER" };
  }
  return { kind: "default" };
}

export function browserNoneReason(intent: { value: string }): string {
  return `Not opening a browser (PLANNOTATOR_BROWSER=${intent.value}).`;
}
