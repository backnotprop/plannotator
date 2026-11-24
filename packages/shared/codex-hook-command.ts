/**
 * The command of Plannotator's Codex `PostToolUse` hook, as the installer writes it into the Codex `hooks.json` next to
 * the `Stop` hook (scripts/install.sh, "Codex CLI / Desktop app support"). Codex runs a hook command with the person's
 * own shell (`<shell> -c <command>`: zsh on a Mac, where a glob that matches nothing is an error), after every
 * successful tool call of every turn. So the command is `/bin/sh -c` around a POSIX gate that answers first:
 *
 *  - The binary is gone (Plannotator uninstalled, the hook left behind): exit 0, nothing said.
 *  - It notes that this Codex runs the hook (`codex-hook-ran` in the Inbox's folder, rewritten only when hooks.json
 *    changed after it): the Inbox holds a reply for the hook only once Codex has run it, since Codex skips a hook the
 *    person has not reviewed (packages/server/inbox-codex-steer.ts).
 *  - Nothing held in the Codex hook mailbox (packages/shared/inbox/codex-hook-mailbox.ts) of the data dirs the Inbox
 *    may use (`~/.plannotator`, `$XDG_DATA_HOME/plannotator`): exit 0. A tool call costs one `sh`, a few stats and a
 *    glob.
 *  - Something held: it reads the payload's first bytes for `session_id` (Codex writes it first) and starts the binary
 *    only when a reply is held for that thread; the bytes it read go to the binary in PLANNOTATOR_CODEX_HOOK_HEAD.
 *    When it cannot read the id, the binary decides.
 *  - PLANNOTATOR_DATA_DIR set (another data dir): the binary decides, every time.
 *
 * The hook writes nothing when it takes nothing, which Codex reads as no effect. Codex ignores a hook that leaves its
 * stdin unread (a broken pipe there is not a failure, codex-rs/hooks/src/engine/command_runner.rs).
 * scripts/install.sh builds the same string (packages/shared/codex-hook-command.test.ts holds them equal).
 */

import { basename, isAbsolute } from "node:path";

/** The subcommand the gate runs. */
export const CODEX_HOOK_SUBCOMMAND = "codex-hook";

/** The hook's time limit in Codex (seconds): it reads a few small files. */
export const CODEX_HOOK_TIMEOUT_S = 10;

/** The file in the Inbox's folder the gate rewrites when Codex runs the hook (its mtime: since when it is known to run). */
export const CODEX_HOOK_RAN_FILE = "codex-hook-ran";

/**
 * The installer's note, in the data dir, that it added the hook (scripts/install.sh): once there, an update never adds
 * back a hook the person removed from hooks.json. Uninstall removes the note with the hook.
 */
export const CODEX_HOOK_INSTALLED_FILE = "codex-hook-installed";

/** The env var the gate hands the payload's first bytes in (it read them from stdin to find the thread). */
export const CODEX_HOOK_HEAD_ENV = "PLANNOTATOR_CODEX_HOOK_HEAD";

/** How many bytes of the payload the gate reads for `session_id`. */
const HEAD_BYTES = 512;

/** What a path must not hold to sit in the gate's quotes as it is (the installer refuses the same). */
const UNQUOTABLE = /['"$`\\]/;

/** How the gate names the binary: how `parseCodexHookCommand` finds it. */
const GATE_OPEN = `/bin/sh -c 'B="`;
const GATE_RUN = `exec "$B" ${CODEX_HOOK_SUBCOMMAND}`;

/** The glob an earlier draft of this gate carried (never released): still read, so reinstall and uninstall clean it up. */
const OLD_MAILBOX_GLOB = "/plannotator/inbox/codex-hook/*.json";

/**
 * The hook command for this executable, written into `hooksFile` (the gate notes a run again once that file changed);
 * null for a path the gate cannot carry inside its quotes.
 */
export function codexHookCommand(executable: string, hooksFile: string): string | null {
  if (UNQUOTABLE.test(executable) || UNQUOTABLE.test(hooksFile)) return null;
  const gate = [
    `B="${executable}"`,
    `H="${hooksFile}"`,
    `[ -x "$B" ] || exit 0`,
    `[ -n "\${PLANNOTATOR_DATA_DIR:-}" ] && ${GATE_RUN}`,
    `for d in "$HOME/.plannotator/inbox" "\${XDG_DATA_HOME:-/nonexistent}/plannotator/inbox"; do [ -d "$d" ] || continue`,
    `m="$d/${CODEX_HOOK_RAN_FILE}"`,
    `[ -e "$m" ] && [ ! "$H" -nt "$m" ] || true 2>/dev/null >"$m"`,
    `for f in "$d"/codex-hook/*.json; do [ -e "$f" ] || break`,
    // One read of at most HEAD_BYTES (`head` reads ahead and drops what it does not print, which the binary needs).
    `p=$(dd bs=${HEAD_BYTES} count=1 2>/dev/null)`,
    `t=\${p#*session_id???}`,
    `t=\${t%%[!0-9a-f-]*}`,
    `export ${CODEX_HOOK_HEAD_ENV}="$p"`,
    `[ \${#t} -eq 36 ] || ${GATE_RUN}`,
    `for g in "$d/codex-hook/$t".*.json; do [ -e "$g" ] && ${GATE_RUN}; done`,
    `exit 0; done; done`,
    `exit 0`,
  ].join("; ");
  return `/bin/sh -c '${gate}'`;
}

/** The executable a hooks.json command of this hook runs (any path), or undefined when it is not this hook's. */
export function parseCodexHookCommand(command: string): { executable: string } | undefined {
  const trimmed = command.trim();
  let executable: string | undefined;
  if (trimmed.startsWith(GATE_OPEN) && trimmed.includes(GATE_RUN)) executable = trimmed.slice(GATE_OPEN.length).split('"', 1)[0];
  else if (trimmed.startsWith("/bin/sh -c '") && trimmed.includes(OLD_MAILBOX_GLOB)) executable = /exec "([^"]+)" codex-hook;/.exec(trimmed)?.[1];
  if (!executable) return undefined;
  const name = basename(executable).toLowerCase();
  if (executable === "plannotator" || (isAbsolute(executable) && (name === "plannotator" || name === "plannotator.exe"))) return { executable };
  return undefined;
}

/** Whether a hooks.json command is this hook's (any executable path), so a reinstall updates it in place. */
export function isCodexHookCommand(command: string): boolean {
  return parseCodexHookCommand(command) !== undefined;
}
