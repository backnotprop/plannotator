/**
 * `plannotator inbox capability [<capability> on|off] [--computer <name>] [--thread <id>]`: the Inbox's capability
 * switches from a shell (inbox-mcp-capability.ts in the server). Sugar over `plannotator inbox call capability`
 * (inbox-call-command.ts), so who is calling, the result on stdout and the exit codes are that command's: no switch
 * logic lives here. Works whatever is on: it is how a capability that is off gets turned on.
 */

import { INBOX_CAPABILITY_AGENT_IDS } from "@plannotator/core/inbox-capability-switches";
import { hasHelpFlag } from "./cli";
import { runInboxCallCommand, type CallCommandDeps } from "./inbox-call-command";
import { writeWholeToStdout } from "./write-whole-stdout";

export const INBOX_CAPABILITY_USAGE = [
  "Usage:",
  "  plannotator inbox capability [--computer <name>]",
  "  plannotator inbox capability <capability> on|off [--computer <name>] [--thread <id>]",
  "",
  "Lists the Inbox's capabilities (Settings → Capabilities) and whether each is on, or turns one on or off.",
  "Turn one on or off when the person asks you to; not on your own initiative.",
  `<capability>: ${INBOX_CAPABILITY_AGENT_IDS.join(", ")}.`,
  "--computer <name>: a linked computer's name, as the Inbox shows it. Default: this computer.",
  "--thread <id>: the thread you work in; the line for the person goes there.",
  "--session <id>: as for 'plannotator inbox call'.",
  "",
  "stdout is the result as one JSON value, and nothing on failure. Exit 0 ok, 1 refused or no Inbox, 2 bad usage.",
].join("\n");

export type ParsedCapabilityCommand = { ok: true; call: Record<string, unknown>; session: string | null } | { ok: false; error: string };

export function parseCapabilityCommand(argv: readonly string[]): ParsedCapabilityCommand {
  const positional: string[] = [];
  const call: Record<string, unknown> = {};
  let session: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const flag = arg === "--computer" ? "computer" : arg === "--thread" ? "thread_id" : arg === "--session" ? "session" : null;
    if (flag) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) return { ok: false, error: `${arg} takes a value.` };
      if (flag === "session") session = value;
      else call[flag] = value;
    } else if (arg.startsWith("--")) return { ok: false, error: `Unknown inbox capability option: ${arg}.` };
    else positional.push(arg);
  }
  if (positional.length === 0) return { ok: true, call, session };
  if (positional.length !== 2) return { ok: false, error: "inbox capability takes a capability and on or off, or nothing to list them." };
  const [name, state] = positional as [string, string];
  if (!(INBOX_CAPABILITY_AGENT_IDS as readonly string[]).includes(name)) return { ok: false, error: `Unknown capability ${name}: one of ${INBOX_CAPABILITY_AGENT_IDS.join(", ")}.` };
  if (state !== "on" && state !== "off") return { ok: false, error: `on or off, not ${state}.` };
  return { ok: true, call: { capability: name, on: state === "on", ...call }, session };
}

/** Run `plannotator inbox capability …`; resolves to the exit code. */
export async function runInboxCapabilityCommand(argv: readonly string[], deps: CallCommandDeps): Promise<number> {
  const out = deps.out ?? writeWholeToStdout;
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  if (hasHelpFlag([...argv])) {
    await out(`${INBOX_CAPABILITY_USAGE}\n`);
    return 0;
  }
  const parsed = parseCapabilityCommand(argv);
  if (!parsed.ok) {
    err(`usage: ${parsed.error}\n${INBOX_CAPABILITY_USAGE}\n`);
    return 2;
  }
  return runInboxCallCommand([...(parsed.session ? ["--session", parsed.session] : []), "capability", JSON.stringify(parsed.call)], { ...deps, out, err });
}
