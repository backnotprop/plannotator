/**
 * `plannotator sessions` output: the table people read (stderr, as before)
 * and the `--json` form scripts and agents read (stdout).
 *
 * Every row names its full target (absolute path, URL, PR URL or reviewed
 * directory) and, when a host started it, the review's `pn-` id: two sessions
 * on files that share a name must be told apart here too.
 *
 * Over SSH, a session another computer must bring this machine's key to
 * (packages/shared/network-key.ts) gets its "From another computer" link,
 * with the key, under its row: only for a person at a terminal
 * (`isPersonAtTerminal`), never in `--json`, never when the output is piped.
 */

import type { SessionInfo } from "@plannotator/server/sessions";
import { withNetworkKey } from "@plannotator/shared/network-key";

function ageText(startedAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 60000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Whether `plannotator sessions` is talking to a person at a terminal, so it
 * may print the network key: stdout and stderr both a terminal (an agent's
 * shell, a hook or a script pipes them) and no agent's mark on the shell
 * (an agent that gives its commands a terminal still marks them).
 */
export function isPersonAtTerminal(stdoutIsTTY: boolean | undefined, stderrIsTTY: boolean | undefined, env: Record<string, string | undefined>): boolean {
  if (!stdoutIsTTY || !stderrIsTTY) return false;
  return !AGENT_SHELL_MARKERS.some((name) => !!env[name]);
}

/** What agents set in the shells they run commands in (detect-origin.ts names them). */
const AGENT_SHELL_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "PLANNOTATOR_SESSION_TAG",
  "CODEX_THREAD_ID",
  "COPILOT_CLI",
  "OPENCODE",
  "GEMINI_CLI",
  "QWEN_CODE",
  "QWEN_CODE_SESSION_ID",
  "OMPCODE",
  "DSH_SHELL",
  "PI_SESSION_ID",
  "CURSOR_AGENT",
] as const;

/** A session's "From another computer" link with the key, or null when it asks for none. */
function anotherComputerLine(session: SessionInfo, key: string): string | null {
  if (session.anotherComputerUrl === undefined) return null;
  return session.anotherComputerUrl
    ? `From another computer: ${withNetworkKey(session.anotherComputerUrl, key)}`
    : `From another computer: add ?key=${key} to this machine's address`;
}

/**
 * The human table, one line per session, newest first (the registry's order).
 * `networkKey`: this machine's key, only for a person at a terminal; each
 * session that needs it gets its link on the next line.
 */
export function formatSessionsTable(sessions: readonly SessionInfo[], now: number = Date.now(), networkKey?: string): string {
  const lines = ["Active Plannotator sessions:", ""];
  sessions.forEach((session, index) => {
    const cells = [
      `#${index + 1}`.padEnd(4),
      session.mode.padEnd(10),
      (session.reviewId ?? "-").padEnd(10),
      session.project.padEnd(20),
      session.url.padEnd(28),
      `${ageText(session.startedAt, now)} ago`.padEnd(10),
      session.target ?? "-",
      session.host === "opencode" ? "(in OpenCode)" : "",
    ];
    lines.push(`  ${cells.join(" ")}`.trimEnd());
    const another = networkKey ? anotherComputerLine(session, networkKey) : null;
    if (another) lines.push(`       ${another}`);
  });
  lines.push("", "Reopen with: plannotator sessions --open [N]");
  return lines.join("\n");
}

/** `--json`: the sessions as one JSON array; `index` is the N `--open` takes. */
export function formatSessionsJson(sessions: readonly SessionInfo[]): string {
  return JSON.stringify(
    sessions.map((session, index) => ({
      index: index + 1,
      mode: session.mode,
      ...(session.reviewId ? { reviewId: session.reviewId } : {}),
      ...(session.target ? { target: session.target } : {}),
      url: session.url,
      port: session.port,
      pid: session.pid,
      project: session.project,
      label: session.label,
      startedAt: session.startedAt,
      ...(session.hostSession ? { hostSession: session.hostSession } : {}),
      ...(session.host ? { host: session.host } : {}),
    })),
  );
}
