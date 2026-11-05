/**
 * "Might be related": what regresses is the gate going soft (a wrong link under
 * someone's words is worse than none), a link that can leave the public
 * addresses, and the shipped file carrying anything but public titles.
 *
 * The off-topic sentences run against a frozen list of real titles that the
 * looser gates misfired on, not against the shipped file: that file changes at
 * every release, and a new title must not fail a tagged build.
 */
import { describe, expect, test } from 'bun:test';
import { isPublicRelatedUrl, relatedIndex, relatedLinks, type RelatedData } from './feedbackRelated';
import shipped from './feedbackRelated.data.json';

const DOC = 'https://plannotator.ai/docs/reference/inbox/#what-you-see';
const release = (title: string, version = 'v0.28.40') => ({ title, version });
const FROZEN: RelatedData = {
  features: [
    { title: 'Archive', phrases: ['done button', 'mark as done', 'delete thread', 'trash'], reason: 'Already there.', url: DOC },
    { title: 'Dictate your replies', phrases: ['by voice', 'microphone'], reason: 'Already there.', url: DOC },
    { title: 'Settings, Rows', phrases: ['compact row', 'cramped'], reason: 'Already there.', url: DOC },
    { title: 'Over your tailnet', phrases: ['on my phone', 'mobile app'], reason: 'Already there.', url: DOC },
  ],
  releases: [
    release('Mark unread'),
    release('A thread you opened offers Mark unread at once, on its row and in the header.'),
    release('Session names in the To picker'),
    release('Snooze a thread'),
    release('Done says nothing was sent.'),
    release('Done with nothing to send starts no agent turn'),
    release('Your own messages keep their line breaks and blank lines.'),
    release('Board lanes: Backlog, Todo, In progress, In review, Done'),
    release('Built on Bun 1.4.4. It drops the compromised eMudhra root certificate, and the CLI uses less memory and starts faster.'),
    release('Share links stop serving stale snapshots'),
    release('Diagram files open in the diagram viewer'),
    release('Quiet projects in the sidebar look like projects again.'),
    release('The Inbox no longer starts Grok Build sessions.'),
    // About as many lines as the shipped file: word weights depend on it, and in a tiny list the score floor alone would silence everything.
    ...Array.from({ length: 900 }, (_, n) => release(`Unrelated heading number ${n} about something quite different`)),
  ],
  issues: [
    { title: 'Inbox: the browser tab uses 1.6 GB, even right after a reload, with a large store', number: 2593, prWords: 'Inbox: memory soak over a large store on the heavy tier (#2593)' },
    { title: 'Inbox: submitting a comment on an attachment blanks the entire page (0.28.48)', number: 2594 },
    { title: 'Execution progress ([DONE:n]) resets to 0/N after compaction or session fork', number: 1376 },
  ],
};
const index = relatedIndex(FROZEN);
const titles = (text: string) => relatedLinks(index, text).map((link) => link.title);

describe('the gate stays quiet', () => {
  // Each of these drew a link under a looser gate or a single-word list.
  test.each([
    "I'm done with this tool, it is too slow",
    'the review is done but nothing happened',
    'done with setup, nothing shows up',
    'talk to me about pricing',
    'the voice of the docs is a bit stiff',
    'my phone number should not be required',
    'mobile safari shows a scrollbar',
    'compact mode for the plan viewer',
    'please remove the telemetry',
    'can I clear my history',
    'can I share a plan with a teammate',
    'mermaid diagrams do not render',
    'works great, thank you',
    'this is awesome, keep it up',
    'translate the interface into Spanish',
  ])('%s', (text) => {
    expect(titles(text)).toEqual([]);
  });

  test('a long message with a stray word or two shows nothing', () => {
    expect(titles("I love the inbox but when I come back after lunch there are a lot of threads and I can't tell what needs me. It would be nice to see only the ones with questions.")).toEqual([]);
  });

  test('a few letters are not worth a line', () => {
    expect(titles('unread')).toEqual([]);
  });

  test('any text at all is safe to match', () => {
    for (const text of ['', '   ', '!!!???...', '🙂🙂🙂🙂🙂🙂🙂🙂🙂', 'x'.repeat(100_000), 'constructor __proto__ toString hasOwnProperty']) expect(() => relatedLinks(index, text)).not.toThrow();
  });
});

describe('it finds what it is for', () => {
  test('a feature by its own name; the hand list and the notes do not both answer', () => {
    expect(titles('snooze a thread until tomorrow')).toEqual(['Snooze a thread']);
    expect(titles('I wish I could mark a thread as unread')).toEqual(['Mark unread', 'A thread you opened offers Mark unread at once, on its row and in the header']);
  });

  test('a feature by another name, through the hand list only', () => {
    expect(titles('need a done button')).toEqual(['Archive']);
    expect(titles('reply by voice instead of typing')).toEqual(['Dictate your replies']);
    expect(relatedLinks(relatedIndex({ ...FROZEN, features: [] }), 'need a done button')).toEqual([]);
  });

  test('an open bug, also through the words of an open PR that cites it', () => {
    expect(relatedLinks(index, 'the inbox uses too much memory').map((link) => link.reason)).toEqual(['Open issue #2593']);
    expect(relatedLinks(index, 'blank page after update').map((link) => link.reason)).toEqual(['Open issue #2594']);
  });

  test('never more than three lines', () => {
    const many: RelatedData = {
      features: [],
      releases: [...Array.from({ length: 9 }, (_, n) => release(`Snooze a thread ${n + 10}`)), ...FROZEN.releases],
      issues: Array.from({ length: 9 }, (_, n) => ({ title: `Snooze a thread ${n + 20}`, number: n + 20 })),
    };
    expect(relatedLinks(relatedIndex(many), 'snooze a thread please').length).toBe(3);
  });

  test('a long title is cut so the reason still reads', () => {
    const long = 'A notification for every new thread an agent starts, even with the Inbox in front; the "Click to turn on sound" nudge goes away on the first click';
    const [link] = relatedLinks(relatedIndex({ ...FROZEN, features: [], releases: [release(long), ...FROZEN.releases] }), 'a notification for every new thread an agent starts');
    expect(link!.title).toBe('A notification for every new thread an agent starts, even with the Inbox in front');
  });
});

describe('a link goes only to a public address', () => {
  test.each([
    ['https://github.com/backnotprop/plannotator/issues/1', true],
    ['https://github.com/backnotprop/plannotator/releases/tag/v0.28.43', true],
    ['https://plannotator.ai/docs/reference/inbox/#what-you-see', true],
    ['http://github.com/backnotprop/plannotator/issues/1', false],
    ['https://github.com/someone-else/plannotator/issues/1', false],
    ['https://github.com.evil.example/backnotprop/plannotator/', false],
    ['https://user:secret@github.com/backnotprop/plannotator/', false],
    ['https://plannotator.ai/somewhere', false],
    ['http://localhost:59812/api/inbox', false],
    ['javascript:alert(1)', false],
    ['/api/inbox/feedback', false],
    ['not a url', false],
  ])('%s: %p', (url, allowed) => {
    expect(isPublicRelatedUrl(url)).toBe(allowed);
  });

  test('a bad address, version or number in the file draws no link at all', () => {
    const bad = relatedIndex({
      features: [{ title: 'Snooze a thread', phrases: ['snooze'], reason: 'x', url: 'https://evil.example/' }],
      releases: [{ title: 'Snooze a thread', version: '../../evil' }, ...FROZEN.releases.filter((line) => line.title !== 'Snooze a thread')],
      issues: [{ title: 'Snooze a thread', number: -1 }],
    });
    expect(relatedLinks(bad, 'snooze a thread please')).toEqual([]);
  });

  test('every line the shipped file can draw has a public address', () => {
    const data = shipped as RelatedData;
    for (const entry of relatedIndex(data).entries) expect(isPublicRelatedUrl(entry.link.href), entry.link.href).toBe(true);
    expect(relatedIndex(data).entries.length).toBe(data.features.length + data.releases.length + data.issues.length);
  });
});

describe('the shipped file holds public titles and nothing else', () => {
  const data = shipped as RelatedData;
  test('only these fields: no bodies, authors, dates or labels', () => {
    for (const row of data.features) expect(Object.keys(row).sort()).toEqual(['phrases', 'reason', 'title', 'url']);
    for (const row of data.releases) expect(Object.keys(row).sort()).toEqual(['title', 'version']);
    for (const row of data.issues) expect(Object.keys(row).sort().filter((key) => key !== 'prWords')).toEqual(['number', 'title']);
  });

  test('nothing in it reads like this computer or a credential', () => {
    const text = JSON.stringify(shipped);
    expect(text).not.toMatch(/\/Users\/|\/home\/|C:\\\\Users|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/);
  });

  test('a hand-list phrase is more than one common word, or a word no message says by chance', () => {
    // The first list fired on "done", "talk", "light", "clear" and "find": 9 of 20 off-topic sentences.
    for (const feature of data.features) for (const phrase of feature.phrases) expect(['done', 'talk', 'light', 'dark', 'clear', 'find', 'remove', 'close', 'delete', 'voice', 'phone', 'mobile', 'compact', 'start', 'theme']).not.toContain(phrase);
  });
});
