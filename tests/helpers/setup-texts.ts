/**
 * The setup texts an agent follows to set up the Plannotator Inbox for a person, cut to their setup sections, and
 * the `plannotator` commands each one gives, in the order it gives them. Two tests walk them:
 * apps/marketing/setup-order.test.ts (every page: the turn-on comes first, and no step an agent runs is refused or
 * holds its shell) and the compiled-binary walk in tests/e2e/inbox-turned-on.cases.ts (the commands run against the binary
 * with the real rule).
 *
 * The rule they hold (2026-11-19, after a first setup broke): the first Inbox step is always `plannotator inbox
 * --open` (TURN_ON: it turns the Inbox on, starts it detached, opens it, prints the URL, then connects the agents it
 * finds and returns, with or without a screen), before any connection, config edit, restart or "you should see". No
 * setup text gives an agent `--background` (refused while the Inbox is off) or bare `plannotator inbox` (it serves
 * in the foreground when no Inbox runs, so it never returns in an agent's shell).
 */
import { LISTED_AGENTS, TURN_ON, type Agent } from '../../apps/marketing/src/lib/inbox-agents';
import { buildInboxPrompt, buildLlmsAgent, buildLlmsInbox } from '../../apps/marketing/src/lib/llms';

export { TURN_ON };

export interface SetupText {
  /** `prompt` (/inbox/prompt.md), `llms-inbox` (/llms/inbox.md) or the agent's slug (/llms/agents/<slug>.md). */
  name: string;
  /** The part of the page an agent follows to set the Inbox up. */
  text: string;
}

/** `text` from the line `from` starts to the first line after it that starts with one of `to` (or the end). */
function between(text: string, from: string, to: string[]): string {
  const start = text.indexOf(from);
  if (start < 0) throw new Error(`no "${from}" in the page`);
  const rest = text.slice(start + from.length);
  const ends = to.map((t) => rest.indexOf(`\n${t}`)).filter((i) => i >= 0);
  return from + (ends.length ? rest.slice(0, Math.min(...ends)) : rest);
}

/**
 * The setup script's steps 1 to 5 (step 6 is what the agent tells the person), less step 1b: its per-agent lines
 * say which step each of their commands belongs to ("Before step 2", "In step 3"), so they are `promptAgentSteps`.
 */
export function promptSetup(promptSource: string): SetupText {
  const text = between(buildInboxPrompt(promptSource), '# Set up the Plannotator Inbox', ['## 6.']);
  const agents = between(text, '## 1b.', ['## 2.']);
  return { name: 'prompt', text: text.replace(agents, '') };
}

/** The setup script's step 1b: what each host does around step 2. */
export function promptAgentSteps(promptSource: string): SetupText {
  return { name: 'prompt-agents', text: between(buildInboxPrompt(promptSource), '## 1b.', ['## 2.']) };
}

/** The llms Inbox page's "Set up the Inbox for your person". */
export function llmsInboxSetup(): SetupText {
  return { name: 'llms-inbox', text: between(buildLlmsInbox(), '## Set up the Inbox for your person', ['## Agents']) };
}

/** An agent page's Setup, Other ways and Check that it works. */
export function agentSetup(agent: Agent): SetupText {
  return { name: agent.slug, text: between(buildLlmsAgent(agent), '## Setup', ['## Troubleshooting', '## Limits', 'The full guide for people:']) };
}

/** Every setup text the site serves. */
export function setupTexts(promptSource: string): SetupText[] {
  return [promptSetup(promptSource), promptAgentSteps(promptSource), llmsInboxSetup(), ...LISTED_AGENTS.map(agentSetup)];
}

/**
 * The `plannotator` commands a text gives, in order: its code spans and the lines of its fenced blocks that start
 * with `plannotator`, an environment assignment first allowed (`PLANNOTATOR_INBOX_CONNECT=0 plannotator inbox --open`).
 * A span its sentence forbids before it ("Never run `plannotator inbox stop`") is not given.
 */
export function setupCommands(text: string): string[] {
  const found: { at: number; command: string }[] = [];
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    let at = match.index ?? 0;
    for (const line of match[1]!.split('\n')) {
      at += line.length + 1;
      if (/^\s*(?:[A-Z_]+=\S+\s+)*plannotator(?:\s|$)/.test(line)) found.push({ at, command: line.trim() });
    }
  }
  const fences = [...text.matchAll(/```[^\n]*\n[\s\S]*?```/g)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const at = match.index ?? 0;
    if (fences.some(([a, b]) => at >= a! && at < b!)) continue;
    const sentenceStart = Math.max(text.lastIndexOf('. ', at), text.lastIndexOf('\n', at));
    if (/\bnever run\b/i.test(text.slice(sentenceStart + 1, at))) continue;
    if (/^(?:[A-Z_]+=\S+\s+)*plannotator(?:\s|$)/.test(match[1]!)) found.push({ at, command: match[1]!.trim() });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.command);
}

/** A command without its environment assignments. */
export const bareCommand = (command: string) => command.replace(/^(?:[A-Z_]+=\S+\s+)*/, '');

/** An Inbox command that reads only: it needs the Inbox neither on nor off. */
export const readsOnly = (command: string) => /^plannotator inbox (?:call )?--help$/.test(bareCommand(command)) || /^plannotator (?:--version|--help)$/.test(bareCommand(command));

/** An Inbox command (anything under `plannotator inbox`) that is not read-only. */
export const inboxCommand = (command: string) => /^plannotator inbox(?:\s|$)/.test(bareCommand(command)) && !readsOnly(command);

/** What a setup text must never give an agent to run: bare `plannotator inbox` or `--background`. */
export function forbiddenCommand(command: string): string | null {
  const bare = bareCommand(command);
  if (bare === 'plannotator inbox') return 'bare `plannotator inbox` serves in the foreground when no Inbox runs: it never returns in an agent\'s shell';
  if (/^plannotator inbox\b.*\s--background(?:\s|$)/.test(bare)) return '`--background` is refused while the Inbox is off';
  return null;
}
