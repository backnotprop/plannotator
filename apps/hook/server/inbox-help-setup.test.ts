/**
 * The words an agent acts on when it sets the Inbox up, held to what the CLI does now that the Inbox is off until
 * the person turns it on (packages/shared/inbox/turned-on.ts):
 *
 *   - the guide's "Connecting yourself" gives `plannotator inbox --open` as its first Inbox step and never tells an
 *     agent to run `--background` (refused while off) or bare `plannotator inbox` (it holds the shell when no Inbox
 *     runs); no sentence of the guide says a call starts the Inbox, or a host registers the tool, without saying
 *     the person must have turned it on;
 *   - the plannotator skill's Inbox section never tells an agent to run either.
 *
 * Checked against the source of each rule (setup-texts.ts, the turn-on constant), never against a copy of the prose.
 * Nothing here starts an Inbox.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentEnvironmentFor } from "@plannotator/server/inbox-agents";
import { forbiddenCommand, inboxCommand, setupCommands, TURN_ON } from "../../../tests/helpers/setup-texts";
import { formatInboxHelp } from "./inbox-help";
import { INBOX_OFF_LINE } from "@plannotator/shared/inbox/connection";

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
  test("Connecting yourself: the turn-on comes first, and nothing it gives an agent is refused or holds its shell", () => {
    const connecting = section(help, "## Connecting yourself");
    expect(firstInboxCommand(connecting)).toBe(TURN_ON);
    expect(forbiddenRuns(connecting)).toEqual([]);
    expect(connecting).not.toContain("--background");
  });

  test("no sentence says a call or a host starts or registers the Inbox without saying it must be on", () => {
    const sentences = help.split(/(?<=[.!?])\s+/);
    const claims = sentences.filter((s) => /\b(?:every call|first call|calls?)\b[^.]*\bstarts?\b[^.]*\bInbox\b/i.test(s) || /registers it anyway/.test(s));
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) expect(claim).toMatch(/turned the Inbox on|Inbox is on/);
    expect(sentences.filter((s) => /has run once|if it never has/.test(s))).toEqual([]);
  });
});

describe("the off line", () => {
  // What regresses: the line an agent gets while the Inbox is off names a command that holds its shell (bare
  // `plannotator inbox` serves in the foreground when no Inbox runs) or that is refused while off.
  test("the command it names to turn the Inbox on is the setup's turn-on, and nothing it names is refused or blocking", () => {
    const named = setupCommands(INBOX_OFF_LINE);
    expect(named).toEqual([TURN_ON]);
    expect(named.filter((command) => forbiddenCommand(command))).toEqual([]);
  });
});

describe("the plannotator skill", () => {
  const skill = readFileSync(resolve(here, "../../skills/core/plannotator/SKILL.md"), "utf8");

  test("its Inbox section never tells an agent to run a refused or blocking command", () => {
    expect(forbiddenRuns(section(skill, "## plannotator inbox"))).toEqual([]);
  });
});
