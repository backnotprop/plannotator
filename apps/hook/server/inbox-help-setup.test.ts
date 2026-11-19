/**
 * The words an agent acts on when it sets the Inbox up, held to what the CLI does now that the Inbox is off until
 * it is turned on (packages/shared/inbox/inbox-on.ts):
 *
 *   - `plannotator inbox --help`'s usage lists only subcommands the CLI has (it listed `inbox on`, which is
 *     "Unknown inbox option");
 *   - the guide's "Connecting yourself" gives `plannotator inbox --open` as its first Inbox step and never tells an
 *     agent to run `--background` (refused while off) or bare `plannotator inbox` (it holds the shell when no Inbox
 *     runs); no sentence of it says a call starts the Inbox without saying "while the Inbox is on";
 *   - the plannotator skill's Inbox section does the same.
 *
 * Checked against the source of each rule (the dispatcher, the turn-on command), never against a copy of the prose.
 * Nothing here starts an Inbox.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentEnvironmentFor } from "@plannotator/server/inbox-agents";
import { forbiddenCommand, inboxCommand, setupCommands, TURN_ON } from "../../marketing/src/lib/setup-texts";
import { INBOX_COMMAND_USAGE } from "./cli";
import { formatInboxHelp } from "./inbox-help";

const here = import.meta.dir;
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-help-setup-home-")));
const help = formatInboxHelp({
  command: ["plannotator"],
  dataDir: "/home/someone/.plannotator",
  platform: "linux",
  agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: HOME, env: { HOME, PATH: "" } }),
});

/** The text from `heading` to the next heading of the same level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = heading.match(/^#+/)![0];
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`\\n${level} `));
  return end < 0 ? rest : rest.slice(0, end);
}

/** Sentences that tell the reader to run a command setup must never give an agent (a "never run" is not one). */
function forbiddenRuns(text: string): string[] {
  return text
    .split(/(?<=[.:])\s+(?=[A-Z`])/)
    .filter((sentence) => !/\bnever\b/i.test(sentence))
    .flatMap((sentence) => [...sentence.matchAll(/\brun\b[^`]*`([^`]+)`/gi)].map((m) => m[1]!).filter((command) => forbiddenCommand(command)).map((command) => `${command}: ${sentence}`));
}

/** The first Inbox command of a text that is not read-only, else null. */
const firstInboxCommand = (text: string) => setupCommands(text).find(inboxCommand) ?? null;

describe("plannotator inbox --help", () => {
  test("its usage lists only inbox subcommands the CLI dispatches", () => {
    const sources = readFileSync(join(here, "inbox-command.ts"), "utf8") + readFileSync(join(here, "index.ts"), "utf8");
    const subs = [...new Set([...String(INBOX_COMMAND_USAGE).matchAll(/plannotator inbox ([a-z][a-z-]*)/g)].map((m) => m[1]!))];
    expect(subs.length).toBeGreaterThan(5);
    for (const sub of subs) {
      const dispatched = sources.includes(`args[0] === "${sub}"`) || sources.includes(`args[0] === "inbox" && args[1] === "${sub}"`);
      expect(dispatched, `plannotator inbox ${sub}`).toBe(true);
    }
  });

  test("Connecting yourself: the turn-on comes first, and nothing it gives an agent is refused or holds its shell", () => {
    const connecting = section(help, "## Connecting yourself");
    expect(firstInboxCommand(connecting)).toBe(TURN_ON);
    expect(forbiddenRuns(connecting)).toEqual([]);
    expect(connecting).not.toContain("--background");
  });

  test("no sentence says a call or a host starts or registers the Inbox without saying it must be on", () => {
    const sentences = help.split(/(?<=[.!?])\s+/);
    const claims = sentences.filter((s) => /\b(?:every call|first call|calls?)\b[^.]*\bstarts?\b[^.]*\bInbox\b/i.test(s) || /registers it anyway/.test(s));
    for (const claim of claims) expect(claim).toMatch(/Inbox is on/);
    expect(sentences.filter((s) => /has run once|if it never has/.test(s))).toEqual([]);
  });
});

describe("the plannotator skill", () => {
  const skill = readFileSync(resolve(here, "../../skills/core/plannotator/SKILL.md"), "utf8");

  test("its Inbox section gives the turn-on as the one way to set the Inbox up, and never a refused or blocking command", () => {
    const inbox = section(skill, "## plannotator inbox");
    expect(forbiddenRuns(inbox)).toEqual([]);
    const setUp = inbox.split(/(?<=[.:])\s+(?=[A-Z`])/).filter((sentence) => /\brun\b/i.test(sentence) && /\bset (?:it |the Inbox )?up\b/i.test(sentence));
    expect(setUp.length).toBeGreaterThan(0);
    for (const sentence of setUp) expect(sentence).toContain(`\`${TURN_ON}\``);
    expect(inbox).not.toMatch(/never turn it on yourself/i);
  });
});
