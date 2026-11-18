/**
 * Getting T3 Code ready for a start the Inbox makes (issue #3590), so the person never has to go and do it first:
 *
 * - T3 Code not running ("No running T3 Code server uses …"): on macOS the Inbox opens T3's desktop app in the
 *   background (`open -g -a`, the app's own name, never brought forward) and starts again once its server answers,
 *   within `T3_OPEN_WAIT_MS`. Elsewhere, or when the app can't be opened, the run line says T3 Code isn't open.
 * - A folder T3 doesn't know ("No T3 Code project matches …"): the Inbox adds it as a T3 project with T3's own
 *   command (`t3 project add <folder>`, T3's apps/server/src/cli/project.ts), then starts again. A folder T3 already
 *   has ("An active project already exists for …", a start racing another) counts as added.
 *
 * Each is done at most once per start. A test run (PLANNOTATOR_TEST_SANDBOX) never opens an app: the person's real
 * T3 Code is never reached from a test.
 */
import type { AgentEnvironment } from "./inbox-agents";

/** T3's words for a folder in no project it knows (cli/thread.ts `ThreadProjectNotFoundError`). */
export const T3_NO_PROJECT = /^No T3 Code project matches /;
/** T3's words when its app is not running: no server for this home, or a runtime file whose server does not answer. */
export const T3_NOT_RUNNING = /^(No running T3 Code server uses |Could not reach the T3 Code server)/;
/** T3's words when the folder is already one of its projects (cli/project.ts `ProjectAlreadyExistsError`). */
const T3_PROJECT_EXISTS = /^An active project already exists for /;
/** The desktop app's names on macOS (T3's apps/desktop `productName`), tried in order. */
export const T3_APP_NAMES = ["T3 Code (Beta)", "T3 Code"] as const;
/** How long after opening T3 Code the Inbox waits for its server to answer a start. */
export const T3_OPEN_WAIT_MS = 45_000;

/** The last non-empty line of what T3 printed, spaces folded. */
export const t3LastLine = (text: string): string => text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).pop() ?? "";

/** What a refused start needs before it can start again: T3's app opened, the folder added as a project, or nothing the Inbox can do. */
export function t3RemedyOf(text: string): "open" | "add" | null {
  const last = t3LastLine(text);
  if (T3_NOT_RUNNING.test(last)) return "open";
  if (T3_NO_PROJECT.test(last)) return "add";
  return null;
}

/** Whether `t3 project add` left the folder a T3 project: added now, or one already. */
export function t3ProjectAdded(result: { exitCode: number | null; timedOut?: boolean; stdout: string; stderr: string }): boolean {
  if (result.timedOut) return false;
  return result.exitCode === 0 || T3_PROJECT_EXISTS.test(t3LastLine(`${result.stdout}\n${result.stderr}`));
}

/**
 * Open T3 Code's desktop app in the background (macOS only), by its own name: true once `open` found one. Never under
 * the test sandbox, so no test can open the person's app.
 */
export async function openT3App(e: AgentEnvironment): Promise<boolean> {
  if (e.platform !== "darwin" || process.env.PLANNOTATOR_TEST_SANDBOX || e.env.PLANNOTATOR_TEST_SANDBOX) return false;
  for (const app of T3_APP_NAMES) {
    const result = await e.run(["/usr/bin/open", "-g", "-a", app], { timeoutMs: 10_000, env: { PATH: "/usr/bin:/bin" }, cleanEnv: true });
    if (!result.timedOut && result.exitCode === 0) return true;
  }
  return false;
}

/** Wait until `ready()` or `deadline` (a clock time), checking every `everyMs`. */
export async function waitUntil(ready: () => boolean, deadline: number, everyMs = 500): Promise<boolean> {
  for (;;) {
    if (ready()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(Math.min(everyMs, Math.max(1, deadline - Date.now())));
  }
}
