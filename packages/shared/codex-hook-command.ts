/**
 * The command of Plannotator's Codex `PostToolUse` hook, as the installer writes it into the Codex `hooks.json` next to
 * the `Stop` hook (scripts/install.sh, "Codex CLI / Desktop app support"). Codex runs a hook command with the person's
 * own shell (`<shell> -c <command>`: zsh on a Mac, where a glob that matches nothing is an error), after every
 * successful tool call of every turn. So the command is `/bin/sh -c` around a POSIX gate that answers first: the binary
 * starts only while the Codex hook mailbox holds a reply (packages/shared/inbox/codex-hook-mailbox.ts) in one of the
 * data dirs the Inbox may use (`~/.plannotator`, `$XDG_DATA_HOME/plannotator`), or when PLANNOTATOR_DATA_DIR names
 * another one. With nothing waiting, a tool call costs one `sh` and two globs; the hook writes nothing, which Codex
 * reads as no effect. Codex ignores a hook that leaves its stdin unread (a broken pipe there is not a failure,
 * codex-rs/hooks/src/engine/command_runner.rs). scripts/install.sh builds the same string (scripts/install.test.ts
 * holds them equal).
 */

/** The subcommand the gate runs. */
export const CODEX_HOOK_SUBCOMMAND = "codex-hook";

/** The hook's time limit in Codex (seconds): it reads a few small files. */
export const CODEX_HOOK_TIMEOUT_S = 10;

/** The marker the gate's glob carries: how `isCodexHookCommand` knows the entry, whatever the binary's path. */
const MAILBOX_GLOB = "/plannotator/inbox/codex-hook/*.json";

/** A word inside the gate's double quotes. */
const dq = (value: string) => `"${value.replace(/["$`\\]/g, (c) => `\\${c}`)}"`;

/** The hook command for this executable; null for a path the gate cannot carry inside its single quotes. */
export function codexHookCommand(executable: string): string | null {
  if (executable.includes("'")) return null;
  const run = `exec ${dq(executable)} ${CODEX_HOOK_SUBCOMMAND}`;
  const gate =
    `[ -n "\${PLANNOTATOR_DATA_DIR:-}" ] && ${run}; ` +
    `for f in "$HOME"/.plannotator/inbox/codex-hook/*.json "\${XDG_DATA_HOME:-/nonexistent}"${MAILBOX_GLOB}; ` +
    `do [ -e "$f" ] && ${run}; done; exit 0`;
  return `/bin/sh -c '${gate}'`;
}

/** Whether a hooks.json command is this hook's (any executable path), so a reinstall updates it in place. */
export function isCodexHookCommand(command: string): boolean {
  return command.startsWith("/bin/sh -c '") && command.includes(MAILBOX_GLOB) && command.includes(`" ${CODEX_HOOK_SUBCOMMAND};`);
}
