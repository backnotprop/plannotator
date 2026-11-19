// Every setup text the site serves (the setup script /inbox/prompt.md, the llms Inbox page's setup section and every
// /llms/agents/<slug>.md), walked as an agent walks it: the commands in order (src/lib/setup-texts.ts). A first
// setup broke when the script's first Inbox step was `--background` (refused while the Inbox is off) and the next
// was bare `plannotator inbox` (it served in the foreground and never returned), and when the Claude Code page
// restarted Claude Code before the Inbox was on (the restarted session never got the tool). So: the first Inbox
// command of each text is `plannotator inbox --open`, no text gives an agent `--background` or bare
// `plannotator inbox`, and on each agent page the turn-on step comes before any restart, new session, connection
// or tool to see. The compiled-binary walk of the same commands is in tests/e2e/inbox.spec.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { LISTED_AGENTS, type Step } from './src/lib/inbox-agents';
import { forbiddenCommand, inboxCommand, setupCommands, setupTexts, TURN_ON } from './src/lib/setup-texts';

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

  test('none gives an agent bare `plannotator inbox` or `--background`', () => {
    const found = texts.flatMap(({ name, text }) => setupCommands(text).flatMap((command) => (forbiddenCommand(command) ? [`${name}: ${command}`] : [])));
    expect(found).toEqual([]);
  });

  test('the first Inbox command of each is `plannotator inbox --open`', () => {
    // Step 1b's lines name the step each command belongs to ("In step 3"); the agent order test below holds them.
    for (const { name, text } of texts.filter((t) => t.name !== 'prompt-agents')) {
      const first = setupCommands(text).find(inboxCommand);
      if (first === undefined) continue;
      expect([name, first]).toEqual([name, TURN_ON]);
    }
    // The script and the llms page have it.
    for (const { name, text } of texts.filter((t) => t.name === 'prompt' || t.name === 'llms-inbox')) expect([name, setupCommands(text).includes(TURN_ON)]).toEqual([name, true]);
  });

  test('on each agent page the turn-on step comes before every step that needs the Inbox on', () => {
    for (const agent of LISTED_AGENTS) {
      const needing = agent.setup.findIndex(needsInboxOn);
      if (needing < 0) continue;
      const turnOn = agent.setup.findIndex((step) => step.code === TURN_ON);
      expect([agent.slug, turnOn >= 0 && turnOn < needing]).toEqual([agent.slug, true]);
    }
  });
});
