/**
 * The words for an agent that can't start on a machine (remote launch): compose's start row for a linked machine's
 * projects, and the refusal a Send gets when that machine says no. `machine`: that machine's name, or null for this
 * computer. One place, so the row and the refusal say the same thing.
 */
import type { InboxLaunchNotReady } from "./inbox-types";

/** Plannotator's Claude Code plugin, as the connect steps install it. */
export const INBOX_CLAUDE_PLUGIN_INSTALL = "claude plugin marketplace add backnotprop/plannotator\nclaude plugin install plannotator@plannotator";
export const INBOX_OPENCODE_PLUGIN_INSTALL = "opencode2 plugin add @plannotator/opencode";
export const INBOX_OPENCODE_PLUGIN_UPDATE = "opencode2 plugin update @plannotator/opencode";

export interface InboxLaunchNotReadyWords {
  /** What is wrong, one line with no full stop (the start row, disabled). */
  line: string;
  /** What to do, a sentence, or null when there is nothing to do from here. */
  fix: string | null;
  /** A command to copy and run on that machine, or null. */
  command: string | null;
}

export function inboxLaunchNotReadyWords(input: { agent: string; code: InboxLaunchNotReady; machine: string | null; overSsh?: boolean }): InboxLaunchNotReadyWords {
  const { agent, machine } = input;
  const on = machine ? `on ${machine}` : "on this computer";
  switch (input.code) {
    case "missing":
      return { line: `${agent} isn't installed ${on}`, fix: null, command: null };
    case "too_old":
      if (agent === "OpenCode") return { line: `${agent} ${on} is too old to start from the Inbox`, fix: `Update OpenCode and its Plannotator plugin (\`${INBOX_OPENCODE_PLUGIN_UPDATE}\`) ${on}, then try again.`, command: INBOX_OPENCODE_PLUGIN_UPDATE };
      return { line: `${agent} ${on} is too old to start from the Inbox`, fix: `Update ${agent} ${on}, then try again.`, command: null };
    case "plugin_off":
      if (agent === "OpenCode") return { line: `${agent} isn't ready ${on}: Plannotator's ${agent} plugin isn't installed there`, fix: `Run \`${INBOX_OPENCODE_PLUGIN_INSTALL}\` ${on}, then try again.`, command: INBOX_OPENCODE_PLUGIN_INSTALL };
      // The fix stands alone (a refusal shows no copy button): the command is in it, and in `command` to copy.
      return {
        line: `${agent} isn't ready ${on}: Plannotator's ${agent} plugin isn't installed or is turned off there`,
        fix: `Run \`${INBOX_CLAUDE_PLUGIN_INSTALL.split("\n").join(" && ")}\` ${on}, then try again.`,
        command: INBOX_CLAUDE_PLUGIN_INSTALL,
      };
    case "tool_off":
      return { line: `${agent} isn't ready ${on}: Plannotator's Inbox tool is off for it there`, fix: null, command: null };
    case "signed_out": {
      // The check can read "signed out" when it is not: an Inbox started where macOS keeps the login locked (an SSH
      // start not seen as one, a process started from one). A restart from that machine's own Terminal reads it again.
      const restart = `In Terminal ${on} itself, run \`plannotator inbox restart\``;
      return {
        line: `${agent} isn't signed in ${on}`,
        // Codex keeps its login in its own home (`codex login`), not the macOS keychain an SSH start can't open.
        fix: agent === "Codex"
          ? `Run \`codex login\` ${on}, then try again. Already signed in there? ${restart}.`
          : input.overSsh
          ? `Plannotator ${on} was started over SSH, and macOS keeps the login locked for SSH. ${restart}, then try again.`
          : `Run \`claude\` ${on} once to sign in, then try again. Already signed in there? ${restart}.`,
        command: null,
      };
    }
    case "unknown":
      return { line: `${agent} can't start ${on} right now`, fix: null, command: null };
  }
}

/**
 * A linked machine where no agent can start at all: launch is off there (its health says `launch_from_machines: 0`),
 * or its Plannotator is too old to say (no field).
 */
export function inboxMachineLaunchWords(machine: string, state: "off" | "update"): string {
  return state === "off" ? `Starting agents is off on ${machine}` : `Update Plannotator on ${machine} to start agents there`;
}
