/**
 * What T3 Code says when it can't start a thread the Inbox asks for (issue #3590), and the one thing the Inbox clears by
 * itself: a folder T3 doesn't know ("No T3 Code project matches …") is added as a T3 project with T3's own command
 * (`t3 project add <folder>`, T3's apps/server/src/cli/project.ts), then the start runs again. A folder T3 already has
 * ("An active project already exists for …", a start racing another) counts as added.
 *
 * The Inbox never opens T3 Code: T3 Code not running, the agent starts in the background and its line says why.
 */

/** T3's words for a folder in no project it knows (cli/thread.ts `ThreadProjectNotFoundError`). */
export const T3_NO_PROJECT = /^No T3 Code project matches /;
/** T3's words when its app is not running: no server for this home, or a runtime file whose server does not answer. */
export const T3_NOT_RUNNING = /^(No running T3 Code server uses |Could not reach the T3 Code server)/;
/** T3's words when the folder is already one of its projects (cli/project.ts `ProjectAlreadyExistsError`). */
const T3_PROJECT_EXISTS = /^An active project already exists for /;

/** The last non-empty line of what T3 printed, spaces folded. */
export const t3LastLine = (text: string): string => text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).pop() ?? "";

/** Whether `t3 project add` left the folder a T3 project: added now, or one already. */
export function t3ProjectAdded(result: { exitCode: number | null; timedOut?: boolean; stdout: string; stderr: string }): boolean {
  if (result.timedOut) return false;
  return result.exitCode === 0 || T3_PROJECT_EXISTS.test(t3LastLine(`${result.stdout}\n${result.stderr}`));
}
