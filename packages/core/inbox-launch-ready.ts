import type { InboxLaunchNotReady } from "./inbox-types";

/** Plannotator's Claude Code plugin, as the connect steps install it. */
export const INBOX_CLAUDE_PLUGIN_INSTALL = "claude plugin marketplace add backnotprop/plannotator\nclaude plugin install plannotator@plannotator";

export interface InboxLaunchNotReadyWords {
  line: string;
  fix: string | null;
  command: string | null;
}

export function inboxLaunchNotReadyWords(input: { agent: string; code: InboxLaunchNotReady; machine: string | null; overSsh?: boolean }): InboxLaunchNotReadyWords {
  const { agent, machine } = input;
  const on = machine ? `on ${machine}` : "on this computer";
  switch (input.code) {
    case "missing":
      return { line: `${agent} isn't installed ${on}`, fix: null, command: null };
    case "too_old":
      return { line: `${agent} ${on} is too old to start from the Inbox`, fix: `Update ${agent} ${on}, then try again.`, command: null };
    case "plugin_off":
      return {
        line: `${agent} isn't ready ${on}: Plannotator's ${agent} plugin isn't installed or is turned off there`,
        fix: `Run \`${INBOX_CLAUDE_PLUGIN_INSTALL.split("\n").join(" && ")}\` ${on}, then try again.`,
        command: INBOX_CLAUDE_PLUGIN_INSTALL,
      };
    case "tool_off":
      return { line: `${agent} isn't ready ${on}: Plannotator's Inbox tool is off for it there`, fix: null, command: null };
    case "signed_out": {
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

export function inboxMachineLaunchWords(machine: string, state: "off" | "update"): string {
  return state === "off" ? `Starting agents is off on ${machine}` : `Update Plannotator on ${machine} to start agents there`;
}
