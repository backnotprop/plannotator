/**
 * The `@` grammar as pure functions. These guard the three rules a host's
 * mention source depends on and that a refactor could silently break:
 * the word-boundary email guard, the users-only / not-already-tagged filter,
 * and the surviving-token rule that keeps the body and the reported ids from
 * ever disagreeing about who was named.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyMentionPick,
  mentionMatches,
  mentionToken,
  mentionTrigger,
  sanitizeMentionLabel,
  survivingMentions,
  type MentionPerson,
} from './mentions';

const person = (over: Partial<MentionPerson> & { id: string; label: string }): MentionPerson => ({
  kind: 'user',
  detail: null,
  canOpen: true,
  ...over,
});

const marcus = person({ id: 'user_1', label: 'Marcus Chen', detail: 'marcus@example.com' });
const dana = person({ id: 'user_2', label: 'Dana Ruiz', detail: 'dana@example.com' });
const bot = person({ id: 'cred_1', label: 'Reviewer Agent', detail: 'Agent', kind: 'agent' });

describe('mentionTrigger', () => {
  test('an email never opens the picker (the word-boundary guard)', () => {
    expect(mentionTrigger('write to a@b.com', 'write to a@'.length)).toBeNull();
  });

  test('a bare @ after whitespace triggers with an empty query', () => {
    const t = mentionTrigger('ping @', 6);
    expect(t).toEqual({ query: '', from: 5, to: 6 });
  });

  test('@ at the start of the body triggers', () => {
    expect(mentionTrigger('@ma', 3)?.query).toBe('ma');
  });

  test('the query is lowercased and trimmed, and the caret bounds it', () => {
    // The caret, not the end of the text, is what the trigger reads.
    expect(mentionTrigger('hey @Mar cus and more', 'hey @Mar'.length)?.query).toBe('mar');
  });
});

describe('mentionMatches', () => {
  const trigger = (query: string) => ({ query, from: 0, to: query.length + 1 });

  test('an empty query offers every user', () => {
    expect(mentionMatches([marcus, dana], trigger(''), new Set()).map((p) => p.id))
      .toEqual(['user_1', 'user_2']);
  });

  test('agents are never taggable in a comment', () => {
    expect(mentionMatches([marcus, bot], trigger(''), new Set()).map((p) => p.id))
      .toEqual(['user_1']);
  });

  test('a query filters on label OR detail', () => {
    expect(mentionMatches([marcus, dana], trigger('chen'), new Set()).map((p) => p.id))
      .toEqual(['user_1']);
    expect(mentionMatches([marcus, dana], trigger('dana@'), new Set()).map((p) => p.id))
      .toEqual(['user_2']);
  });

  test('someone already tagged in this draft is not offered again', () => {
    expect(mentionMatches([marcus, dana], trigger(''), new Set(['user_1'])).map((p) => p.id))
      .toEqual(['user_2']);
  });
});

describe('applyMentionPick', () => {
  test('replaces the typed query with the readable token plus one space', () => {
    const text = 'ping @mar please';
    const t = mentionTrigger(text, 'ping @mar'.length)!;
    expect(applyMentionPick(text, t, marcus)).toEqual({
      text: 'ping @Marcus Chen  please',
      caret: 'ping @Marcus Chen '.length,
    });
  });

  test('a label carrying link-grammar bytes is sanitized into the token', () => {
    expect(mentionToken(person({ id: 'u', label: 'A [weird]\nname' }))).toBe('@A weird name');
    expect(sanitizeMentionLabel('  spaced   out  ')).toBe('spaced out');
  });
});

describe('survivingMentions', () => {
  test('deleting a token untags that person', () => {
    const tagged = [marcus, dana];
    expect(survivingMentions('hi @Dana Ruiz', tagged).map((p) => p.id)).toEqual(['user_2']);
    expect(survivingMentions('nobody here', tagged)).toEqual([]);
  });
});
