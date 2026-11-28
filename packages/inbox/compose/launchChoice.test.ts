import { describe, expect, test } from 'bun:test';
import type { InboxLaunchChoices } from '@plannotator/core/inbox-launch-choice';
import { launchChoiceButton, launchChoiceButtonParts, launchChoiceHasModels, launchChoiceNotice, launchDefaultRow } from './launchChoice';

const listed: InboxLaunchChoices = { models: ['opencode/big-pickle', 'ollama/qwen2.5-coder:32b'], efforts: ['low', 'high'], effort_word: 'Variant', primary_agents: ['build', 'plan'] };
const named: InboxLaunchChoices = { ...listed, default_model: 'opencode/big-pickle' };
const unread = (why: InboxLaunchChoices['unread']): InboxLaunchChoices => ({ models: [], efforts: [], effort_word: 'Variant', unread: why });

describe("the model button names OpenCode's default", () => {
  test('a known default reads "Default (big-pickle)", the name after the last slash, with the variant and agent after it', () => {
    expect(launchChoiceButton({}, named)).toBe('Default (big-pickle)');
    expect(launchChoiceButton({}, { ...listed, default_model: 'vercel/anthropic/claude-sonnet-4.5' })).toBe('Default (claude-sonnet-4.5)');
    expect(launchChoiceButton({ effort: 'high', primary_agent: 'build' }, named)).toBe('Default (big-pickle) · high · build');
  });

  test('only the name is the part that gives way: the brackets and " · variant · agent" are kept whole', () => {
    const long: InboxLaunchChoices = { ...listed, default_model: 'ollama/qwen2.5-coder:32b-instruct-q4_K_M' };
    expect(launchChoiceButtonParts({ primary_agent: 'build' }, long)).toEqual({ lead: 'Default (', name: 'qwen2.5-coder:32b-instruct-q4_K_M', tail: ') · build' });
  });

  test('a picked model shows itself, never the default', () => {
    expect(launchChoiceButtonParts({ model: 'ollama/qwen2.5-coder:32b' }, named)).toBeNull();
    expect(launchChoiceButton({ model: 'ollama/qwen2.5-coder:32b' }, named)).toBe('qwen2.5-coder:32b');
  });

  test("an unknown default reads exactly as before: \"Default model\"; a host with no models still reads its effort's word", () => {
    expect(launchChoiceButton({}, listed)).toBe('Default model');
    expect(launchChoiceButton({ effort: 'high' }, listed)).toBe('Default model · high');
    expect(launchChoiceButton({}, { models: [], efforts: ['low', 'high'], effort_word: 'Thinking' })).toBe('Default thinking');
  });

  test('a list being read or not readable still reads "Default model"', () => {
    expect(launchChoiceButton({}, unread('timeout'))).toBe('Default model');
    expect(launchChoiceButton({}, { models: [], efforts: [], effort_word: 'Variant', reading: true })).toBe('Default model');
    expect(launchChoiceHasModels(unread('exit'))).toBe(true);
    expect(launchChoiceHasModels({ models: [], efforts: ['low'], effort_word: 'Thinking' })).toBe(false);
  });

  test('the Default row: "Default (big-pickle)" and its provider; "Default" when unknown', () => {
    expect(launchDefaultRow(named)).toEqual({ name: 'Default (big-pickle)', provider: 'opencode' });
    expect(launchDefaultRow({ ...listed, default_model: 'vercel/anthropic/claude-sonnet-4.5' })).toEqual({ name: 'Default (claude-sonnet-4.5)', provider: 'vercel' });
    expect(launchDefaultRow(listed)).toEqual({ name: 'Default', provider: null });
  });
});

describe("the menu says why OpenCode's models are not there", () => {
  test('each reason has its own words; no models set up is a line of its own; a list that was read has none', () => {
    expect(launchChoiceNotice(unread('timeout'))).toBe("Couldn't read OpenCode's models: it took longer than 5 seconds.");
    expect(launchChoiceNotice(unread('exit'))).toBe("Couldn't read OpenCode's models: OpenCode stopped with an error.");
    expect(launchChoiceNotice(unread('unreadable'))).toBe("Couldn't read OpenCode's models: its answer wasn't readable.");
    expect(launchChoiceNotice(unread('missing'))).toBe("Couldn't read OpenCode's models: the Inbox can't find opencode2.");
    expect(launchChoiceNotice(unread('not_started'))).toBe("Couldn't read OpenCode's models: OpenCode didn't start.");
    expect(launchChoiceNotice(unread('empty'))).toBe('OpenCode has no models set up.');
    expect(launchChoiceNotice({ models: [], efforts: [], effort_word: 'Variant', reading: true })).toBe("Reading OpenCode's models…");
    expect(launchChoiceNotice(named)).toBeNull();
  });

  test('a reason a newer Inbox sends that this window does not know reads as an error, in the approved words', () => {
    expect(launchChoiceNotice(unread('later' as InboxLaunchChoices['unread']))).toBe("Couldn't read OpenCode's models: OpenCode stopped with an error.");
  });
});
