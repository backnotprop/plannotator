// Every setup text the site serves (the setup script /inbox/prompt.md, the llms Inbox page's setup section and every
// /llms/agents/<slug>.md), walked in order (tests/helpers/setup-texts.ts, which states the rule). A first setup broke
// when the script's first Inbox step was `--background` (refused while the Inbox is off) and the next was bare
// `plannotator inbox` (it served in the foreground and never returned), and when the Claude Code page restarted
// Claude Code before the Inbox was on (the restarted session never got the tool). So: in a text an agent runs for the
// first setup, the first Inbox command is `plannotator inbox --open`, never bare or `--background`; the pages a person
// follows open the Inbox with bare `plannotator inbox`, as before the mark (an existing user adding an agent gets
// what they got), never `--background`; and on each agent page the open step comes before any restart, new
// session, connection or tool to see. The compiled-binary walk of the same commands is in
// tests/e2e/inbox-turned-on.cases.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { LISTED_AGENTS, type Step } from './src/lib/inbox-agents';
import { forbiddenCommand, inboxCommand, OPEN_INBOX, setupCommands, setupTexts, TURN_ON } from '../../tests/helpers/setup-texts';

const promptSource = readFileSync(new URL('./src/lib/inbox-prompt.md', import.meta.url), 'utf8');
const texts = setupTexts(promptSource);

/** A step that needs the Inbox on: a restart or new session (the tool is decided at start), a connection, a tool to see. */
const needsInboxOn = (step: Step) =>
  step.prompt === 'after' ||
  /(?<!without a )\b(?:restart|reload|quit|new [\w ]*(?:session|thread|message)|start (?:kiro|it again))\b/i.test(step.do) ||
  /plannotator_inbox/.test(step.see ?? '') ||
  /\bmcp\b/.test(step.code ?? '');

describe('the setup texts', () => {
  test('there is one for the script, the llms page and every listed agent', () => {
    expect(texts.map((t) => t.name)).toEqual(['prompt', 'prompt-agents', 'llms-inbox', ...LISTED_AGENTS.map((a) => a.slug)]);
  });

  test('none gives `--background`, and none an agent runs gives bare `plannotator inbox`', () => {
    const found = texts.flatMap(({ name, by, text }) => setupCommands(text).flatMap((command) => (forbiddenCommand(command, by) ? [`${name}: ${command}`] : [])));
    expect(found).toEqual([]);
  });

  test('the first Inbox command is `plannotator inbox --open` where an agent runs it, bare `plannotator inbox` on a page a person follows', () => {
    // Step 1b's lines name the step each command belongs to ("In step 3"); the agent order test below holds them.
    for (const { name, by, text } of texts.filter((t) => t.name !== 'prompt-agents')) {
      const first = setupCommands(text).find(inboxCommand);
      if (first === undefined) continue;
      expect([name, first]).toEqual([name, by === 'agent' ? TURN_ON : OPEN_INBOX]);
    }
    // The script and the llms page have it.
    for (const { name, text } of texts.filter((t) => t.name === 'prompt' || t.name === 'llms-inbox')) expect([name, setupCommands(text).includes(TURN_ON)]).toEqual([name, true]);
  });

  test('on each agent page the open step comes before every step that needs the Inbox on', () => {
    for (const agent of LISTED_AGENTS) {
      const needing = agent.setup.findIndex(needsInboxOn);
      if (needing < 0) continue;
      const turnOn = agent.setup.findIndex((step) => step.code === OPEN_INBOX);
      expect([agent.slug, turnOn >= 0 && turnOn < needing]).toEqual([agent.slug, true]);
    }
  });
});
