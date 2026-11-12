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

  test('a host that tags agents says so with `kinds` (the Inbox), and may match on names only', () => {
    const pi = person({ id: 'pi-1', label: 'Pi', detail: 'infra · idle', kind: 'agent' });
    expect(mentionMatches([marcus, bot, pi], trigger(''), new Set(), ['agent']).map((p) => p.id)).toEqual(['cred_1', 'pi-1']);
    expect(mentionMatches([marcus, bot, pi], trigger(''), new Set(), ['user', 'agent']).map((p) => p.id)).toEqual(['user_1', 'cred_1', 'pi-1']);
    expect(mentionMatches([bot, pi], trigger('infra'), new Set(), ['agent']).map((p) => p.id)).toEqual(['pi-1']);
    expect(mentionMatches([bot, pi], trigger('infra'), new Set(), ['agent'], false).map((p) => p.id)).toEqual([]);
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

  test('a longer tagged token owns its start: deleting @Fix untags it while @Fix login stays', () => {
    const fix = person({ id: 'a', label: 'Fix' });
    const fixLogin = person({ id: 'b', label: 'Fix login' });
    const tagged = [fix, fixLogin];
    expect(survivingMentions('@Fix and @Fix login', tagged).map((p) => p.id)).toEqual(['a', 'b']);
    expect(survivingMentions('only @Fix login now', tagged).map((p) => p.id)).toEqual(['b']);
    expect(survivingMentions('@Fix login @Fix', tagged).map((p) => p.id)).toEqual(['a', 'b']);
  });

  test('with no longer tagged token, a tag survives exactly as the substring rule kept it', () => {
    const before = (text: string, tagged: readonly MentionPerson[]) => tagged.filter((p) => text.includes(mentionToken(p)));
    const ann = person({ id: 'ann', label: 'Ann' });
    const paren = person({ id: 'p', label: 'Review (Claude Code)' });
    const texts = ['@Ann你好', '@Annさん', '@Anns', '@Ann2', '@Ann, hi', '(@Ann).', 'cc @Ann', '@Ann🎉', '🎉@Ann🎉', '@Ann_x', 'no tag here', '@Review (Claude Code)x', '@Review (Claude Code).'];
    for (const text of texts) {
      for (const tagged of [[ann], [paren], [ann, paren]]) {
        expect(survivingMentions(text, tagged).map((p) => p.id), text).toEqual(before(text, tagged).map((p) => p.id));
      }
    }
    expect(survivingMentions('@Ann你好', [ann]).map((p) => p.id)).toEqual(['ann']);
    expect(survivingMentions('@Review (Claude Code)x', [paren]).map((p) => p.id)).toEqual(['p']);
  });
});
