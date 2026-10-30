/**
 * The Claude Code host for launch (PLAN "Claude: start, env, permissions").
 *
 * Claude's own supervisor keeps the session alive (`claude --bg`); this file
 * only asks it to start, stop, respawn and remove one, and reads its state
 * with `claude agents --json --all`. Contract recorded in
 * `.ops/work/bg-test/RESULTS.md` and `bg-perm-test/RESULTS.md`:
 *
 * - `--bg` takes no prompt here (the first turn is the Inbox's own wake) and
 *   ignores `--session-id`, so the short id comes from its stdout
 *   (`backgrounded · <8 hex> · <name> …`) and the full id from
 *   `agents --json --all --cwd <folder>`, matched as a prefix.
 * - Everything we pass lives in the per-launch settings FILE, never as a
 *   variadic flag (they swallow arguments) and never inline (values in `ps`).
 * - `stop` leaves `done` and drops the session from the list without `--all`.
 *
 * Every run goes through `AgentEnvironment` (packages/server/inbox-agents.ts):
 * its own process group, no stdin, a time limit. On the limit only the CLI
 * itself is killed, never its group: any of these calls may be the one that
 * starts the person's shared supervisor (`claude daemon run`), and killing
 * that would end every background session they have. Tests put a fake
 * `claude` first on PATH (tests/helpers/fake-claude/).
 */

import type { InboxLaunchRecord } from "@plannotator/core/inbox-types";
import type { AgentEnvironment, AgentRunResult } from "./inbox-agents";

/** The first Claude Code with `--bg`, `agents --json`, `respawn` as tested. Below it the To row is not offered. */
export const CLAUDE_LAUNCH_MIN_VERSION = "2.1.314";

const START_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 15_000;

/** The short id and name `claude --bg` printed, or null. */
export function parseBackgrounded(stdout: string): { short: string; name: string } | null {
  const match = /backgrounded · ([0-9a-f]{8}) · ([^\n]*?)(?: \(idle[^\n]*\))?\s*$/m.exec(stdout);
  return match ? { short: match[1]!, name: match[2]!.trim() } : null;
}

/** `2.1.314 (Claude Code)` → `2.1.314`. */
export function parseClaudeVersion(stdout: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(stdout)?.[0] ?? null;
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** One entry of `claude agents --json`, the fields we read. */
export interface ClaudeAgent {
  id: string;
  sessionId: string;
  status: string | null;
  state: string | null;
  waitingFor: string | null;
}

export function parseAgentsJson(stdout: string): ClaudeAgent[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const sessionId = text(e.sessionId);
    if (!sessionId) return [];
    return [{ id: text(e.id) ?? sessionId.slice(0, 8), sessionId, status: text(e.status), state: text(e.state), waitingFor: text(e.waitingFor) }];
  });
}

/** The entry whose short id is `short`: its `id`, else the one `sessionId` it prefixes. Null when none or ambiguous. */
export function agentByShort(agents: readonly ClaudeAgent[], short: string): ClaudeAgent | null {
  const exact = agents.filter((agent) => agent.id === short);
  if (exact.length === 1) return exact[0]!;
  const prefixed = agents.filter((agent) => agent.sessionId.startsWith(short));
  return prefixed.length === 1 ? prefixed[0]! : null;
}

export type ClaudeStartFailure = { code: "untrusted" | "failed"; text: string };

/** The permission mode a launch starts in: bypass (full permissions), auto, or null (the person's own `defaultMode`, no flag). */
export type ClaudeLaunchMode = "bypassPermissions" | "auto" | null;

/**
 * A start a CLI refused for `--permission-mode auto`: Claude's own refusal of the flag's value
 * (`error: option '--permission-mode <mode>' argument 'auto' is invalid.`), a CLI without auto mode.
 * Such a start is made again with no `--permission-mode`, in default mode.
 */
export function refusedForMode(result: Pick<AgentRunResult, "exitCode" | "timedOut" | "stdout" | "stderr">): boolean {
  if (result.exitCode === 0 || result.timedOut) return false;
  return /option '--permission-mode <mode>' argument 'auto' is invalid/.test(`${result.stderr}\n${result.stdout}`);
}

/** Why `claude --bg` did not start a session, in words for the run line (screen 14). */
export function startFailureOf(result: Pick<AgentRunResult, "exitCode" | "timedOut" | "stdout" | "stderr">, folder: string): ClaudeStartFailure {
  const output = `${result.stderr}\n${result.stdout}`;
  if (/workspace not trusted|not a trusted/i.test(output)) {
    return { code: "untrusted", text: `${folder} isn't a trusted folder yet. Open it once in Terminal and accept Claude Code's trust prompt, then try again.` };
  }
  if (result.timedOut) return { code: "failed", text: "Claude Code took too long to start." };
  const line = output.split("\n").map((l) => l.trim()).find((l) => l && !/^Starting background service/.test(l));
  return { code: "failed", text: line ? line.slice(0, 300) : `claude exited with code ${result.exitCode}.` };
}

/** POSIX single-quoted. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command that opens the session in a terminal (the ⋯ menu's Copy attach command). */
export function claudeAttachCommand(folder: string, short: string): string {
  return `cd ${shellQuote(folder)} && claude attach ${short}`;
}

/**
 * Claude Code 2.1.314 takes a PermissionRequest hook's allow only when the ask
 * lets hooks allow it; its own safety checks (removing the working folder, for
 * one) are for a person in Terminal: it ignores the hook's allow, keeps its
 * dialog up and blocks the call on its own after about 2 minutes. A deny always
 * counts. The hook's input marks nothing about this (tool_name, tool_input,
 * permission_suggestions and the base fields only), so the launch's mode
 * decides: in bypass mode (Full permissions) only such checks reach the hook.
 */
export const CLAUDE_TERMINAL_ONLY = "Claude Code only accepts this approval in Terminal.";
/** The follow-up when an allow from here did not take: the session still waits on its own dialog. */
export const CLAUDE_APPROVAL_NOT_TAKEN = "Claude Code didn't take the approval from here: approve it in Terminal.";

/** What a launch's permission card may offer: a full launch takes only a deny from here, and its card says why. */
export function claudePermissionTerms(launch: Pick<InboxLaunchRecord, "full_permissions">): { allowHere: boolean; note: string | null } {
  return launch.full_permissions === true ? { allowHere: false, note: CLAUDE_TERMINAL_ONLY } : { allowHere: true, note: null };
}

/** What Open in Terminal runs when no session exists yet (an untrusted folder): plain `claude`, so its trust prompt shows. */
export function claudeTrustCommand(folder: string): string {
  return `cd ${shellQuote(folder)} && claude`;
}

/**
 * `environment`: the plain env every call but the start runs with (status,
 * stop, respawn, rm). The start brings its own: the person's login shell,
 * read for that launch only.
 */
export function createClaudeHost(options: { environment: () => Promise<AgentEnvironment> }) {
  const run = async (argv: string[], cwd: string | undefined, timeoutMs = COMMAND_TIMEOUT_MS, environment?: AgentEnvironment) => {
    const e = environment ?? (await options.environment());
    const claude = e.which("claude");
    if (!claude) return { result: { exitCode: 127, timedOut: false, stdout: "", stderr: "claude is not on PATH" } as AgentRunResult, missing: true };
    return { result: await e.run([claude, ...argv], { timeoutMs, killGroup: false, ...(cwd ? { cwd } : {}) }), missing: false };
  };

  /** Every session Claude's supervisor knows (`--all`), or null when it could not be read. */
  const agents = async (cwd?: string): Promise<ClaudeAgent[] | null> => {
    const { result } = await run(["agents", "--json", "--all", ...(cwd ? ["--cwd", cwd] : [])], cwd);
    return result.exitCode === 0 ? parseAgentsJson(result.stdout) : null;
  };

  return {
    agents,
    /**
     * `claude --bg` in `folder` with the launch's settings file, then the full
     * session id. `allowBypass` (the person recorded bypass consent) adds
     * `--allow-dangerously-skip-permissions`, so the session may switch to
     * bypass later (the card's Full permissions); `mode` adds `--permission-mode`
     * (null: the person's own default mode). Nothing else goes on argv. Auto
     * mode refused (a CLI without it): started again with no mode (an auto
     * launch's settings file pins default mode), and `modeRefused` says why.
     * A failure names the folder as `shownFolder` (`~/…`).
     */
    async start(input: {
      folder: string;
      shownFolder: string;
      name: string;
      settingsPath: string;
      mode: ClaudeLaunchMode;
      allowBypass: boolean;
      environment: AgentEnvironment;
    }): Promise<({ ok: true; session: string; short: string } | ({ ok: false; missing: boolean } & ClaudeStartFailure)) & { output: string; modeRefused?: string }> {
      // A name that starts with "-" would read as a flag.
      const name = input.name.replace(/^-+/, "").trim() || "Inbox";
      const base = ["--bg", "--name", name, "--settings", input.settingsPath, ...(input.allowBypass ? ["--allow-dangerously-skip-permissions"] : [])];
      let { result, missing } = await run([...base, ...(input.mode ? ["--permission-mode", input.mode] : [])], input.folder, START_TIMEOUT_MS, input.environment);
      let output = `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
      let modeRefused: string | undefined;
      if (input.mode === "auto" && !missing && refusedForMode(result)) {
        modeRefused = startFailureOf(result, input.shownFolder).text;
        ({ result, missing } = await run(base, input.folder, START_TIMEOUT_MS, input.environment));
        output = `${output}\n[auto mode refused; started again with no --permission-mode]\n${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
      }
      const more = modeRefused ? { modeRefused } : {};
      const started = result.exitCode === 0 ? parseBackgrounded(result.stdout) : null;
      if (!started) return { ok: false, missing, ...startFailureOf(result, input.shownFolder), output, ...more };
      // The supervisor lists the session as soon as `--bg` returns; a short retry covers a busy one.
      for (let attempt = 0; attempt < 5; attempt++) {
        const found = agentByShort((await agents(input.folder)) ?? [], started.short);
        if (found) return { ok: true, session: found.sessionId, short: started.short, output, ...more };
        await Bun.sleep(400);
      }
      // Never leave it running unseen (Try again would start a second one): stop and remove it first.
      const stop = (await run(["stop", started.short], undefined)).result;
      const rm = (await run(["rm", started.short], undefined)).result;
      return {
        ok: false,
        missing: false,
        code: "failed",
        text: `Claude Code started ${started.short} but did not list it.`,
        output: `${output}\n[not listed: stop ${started.short} exit ${stop.exitCode}, rm exit ${rm.exitCode}]`,
      };
    },
    stop: async (short: string) => (await run(["stop", short], undefined)).result,
    respawn: async (short: string) => (await run(["respawn", short], undefined)).result,
    rm: async (short: string) => (await run(["rm", short], undefined)).result,
  };
}

export type ClaudeHost = ReturnType<typeof createClaudeHost>;
