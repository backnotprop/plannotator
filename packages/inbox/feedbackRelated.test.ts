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
    { title: 'Archive', phrases: ['done button', 'mark as done', 'delete thread', 'move to trash'], reason: 'Already there.', url: DOC },
    { title: 'Dictate your replies', phrases: ['by voice', 'use microphone'], reason: 'Already there.', url: DOC },
    { title: 'Settings, Rows', phrases: ['compact row', 'row too cramped'], reason: 'Already there.', url: DOC },
    { title: 'Over your tailnet', phrases: ['use on my phone', 'mobile app'], reason: 'Already there.', url: DOC },
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

  test('a feature stays out of a message with more than a few real words, even when it says the phrase', () => {
    expect(titles('love everything about this tool except the missing done button honestly')).toEqual([]);
    expect(titles('this tool lacks a done button')).toEqual(['Archive']);
  });

  test('only the start of a huge paste is read', () => {
    expect(titles(`${'lorem '.repeat(700)}need a done button`)).toEqual([]);
    expect(titles(`${'lorem '.repeat(600)}need a done button`)).toEqual(['Archive']);
  });

  test('words in nearly every title carry too little to show one', () => {
    expect(titles('something quite different')).toEqual([]);
  });

  test('a title that says one word twice is not "fully matched" by that word', () => {
    const stopped = relatedIndex({ ...FROZEN, releases: [release('Stopped: no is not a stop.'), ...FROZEN.releases] });
    const said = (text: string) => relatedLinks(stopped, text).map((link) => link.title);
    expect(said('stop spying on me')).toEqual([]);
    expect(said('way too many notifications, please stop')).toEqual([]);
    expect(said('closing a browser tab should stop the session from running in the background')).toEqual([]);
  });

  test('two common words shared with a title score too low to draw it', () => {
    // As in the shipped file, where titles say "open" and "inbox" often: common words weigh little.
    const common = Array.from({ length: 150 }, (_, n) => release(`Open a thing number ${n} from the Inbox`));
    const open = relatedIndex({ ...FROZEN, releases: [release('Open the Inbox over your tailnet'), ...common, ...FROZEN.releases] });
    expect(relatedLinks(open, 'I want the inbox to open automatically when I log in').map((link) => link.title)).toEqual([]);
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

  test('notes, issues and features each have their limit: two, one and one', () => {
    const many: RelatedData = {
      features: [
        { title: 'One feature', phrases: ['snooze a thread'], reason: 'Already there.', url: DOC },
        { title: 'Another feature', phrases: ['snooze a thread'], reason: 'Already there.', url: DOC },
      ],
      releases: [...Array.from({ length: 9 }, (_, n) => release(`Snooze a thread ${n + 10}`)), ...FROZEN.releases],
      issues: Array.from({ length: 9 }, (_, n) => ({ title: `Snooze a thread ${n + 20}`, number: n + 20 })),
    };
    const kinds = (data: RelatedData) => relatedLinks(relatedIndex(data), 'snooze a thread please').map((link) => link.kind);
    expect(kinds({ ...many, features: [] })).toEqual(['release', 'release', 'issue']);
    expect(kinds(many)).toEqual(['feature', 'issue']);
  });

  test('never more than three lines', () => {
    const many: RelatedData = {
      features: [],
      releases: [...Array.from({ length: 9 }, (_, n) => release(`Snooze a thread ${n + 10}`)), ...FROZEN.releases],
      issues: Array.from({ length: 9 }, (_, n) => ({ title: `Snooze a thread ${n + 20}`, number: n + 20 })),
    };
    expect(relatedLinks(relatedIndex(many), 'snooze a thread please').length).toBe(3);
  });

  test('a long title stays whole, so the window can offer all of it', () => {
    const long = 'A notification for every new thread an agent starts, even with the Inbox in front; the "Click to turn on sound" nudge goes away on the first click';
    const [link] = relatedLinks(relatedIndex({ ...FROZEN, features: [], releases: [release(long), ...FROZEN.releases] }), 'a notification for every new thread an agent starts');
    expect(link!.title).toBe(long);
  });

  test('each line knows its kind, which picks its mark', () => {
    expect(relatedLinks(index, 'need a done button')[0]!.kind).toBe('feature');
    expect(relatedLinks(index, 'snooze a thread until tomorrow')[0]!.kind).toBe('release');
    expect(relatedLinks(index, 'blank page after update')[0]!.kind).toBe('issue');
  });
});

describe('the opening decides', () => {
  // Made-up messages, in the shapes real long messages take. Public titles that a looser reading drew from their tails.
  const LOOSE: RelatedData = {
    ...FROZEN,
    features: [
      ...FROZEN.features,
      { title: 'Mark unread', phrases: ['mark unread', 'mark as unread', 'mark thread unread', 'thread as unread'], reason: 'Already there.', url: DOC },
    ],
    releases: [
      release('Snoozing the thread you have open moves its row out of the list right away.'),
      release('Mark read, and replies that do not leave the thread at the top'),
      release('Skip questions from the open-questions list'),
      release('Re-ask from the open-questions list'),
      release('Question cards'),
      release('Jira links on Board cards'),
      release('Click Inbox to refresh'),
      release('Right-click a thread'),
      release('Start a Grok Build session from the Inbox'),
      release('Thread names for threads you start'),
      release('One project per Claude Code session'),
      release('Code Tour on Linux when Claude Code sandbox cannot start'),
      release('Large messages through plannotator inbox mcp'),
      release('Replying when the agent session has ended'),
      ...FROZEN.releases,
    ],
  };
  const loose = relatedIndex(LOOSE);
  const said = (text: string) => relatedLinks(loose, text).map((link) => link.title);

  const ASK = 'Please let threads be marked as unread, or set aside as waiting on me. I read through plenty of threads each morning and by noon I no longer know which replies I owe. Replies staying at the top is fine and snoozing is close, but picking a time is too much, and the thread you have open should stay in the list too.';
  const DONE = 'I need a done button on each thread. My agents leave questions open and the open-questions list keeps growing, so I skip questions or ask again later. I only want to say that I am finished from my side.';
  const BUG = 'A thread left open stops refreshing when something new comes in. Going back to the list and in again brings it up. Seen with question cards and with large messages through the mcp, after the window has been idle for a while. A right-click on the thread does not help.';

  test('a long ask keeps the answer in its opening line, whatever follows', () => {
    expect(said(ASK)).toEqual(['Mark unread']);
    expect(said(DONE)).toEqual(['Archive']);
  });

  test('a long bug report with an unhelpful tail draws nothing from the tail', () => {
    expect(said(BUG)).toEqual([]);
  });

  test('a long message does at least as well as its opening: nothing it found is lost', () => {
    for (const text of [ASK, DONE, BUG]) {
      const opening = text.slice(0, text.indexOf('. ') + 1);
      expect(said(text).slice(0, said(opening).length)).toEqual(said(opening));
    }
  });

  test('word by word the list settles: past the opening it may only grow, and by one line at most', () => {
    for (const text of [ASK, DONE, BUG]) {
      const opening = text.slice(0, text.indexOf('. ') + 1);
      const settled = said(opening);
      const all = text.split(' ');
      for (let end = opening.split(' ').length; end <= all.length; end++) {
        const now = said(all.slice(0, end).join(' '));
        expect(now.slice(0, settled.length)).toEqual(settled);
        expect(now.length).toBeLessThanOrEqual(settled.length + 1);
      }
    }
  });

  test('a run-on with no sentence ends: the opening is its first words', () => {
    const tail = ' and then the open questions list and skip questions and ask again '.repeat(4);
    expect(said(`I need a done button on each thread${tail}`)).toEqual(['Archive']);
    expect(said('we keep talking about this every week and nobody here remembers what happened before the last release went out the door and then someone said need a done button please')).toEqual([]);
  });

  test('a greeting is not the opening: the ask after it counts as one', () => {
    expect(said('Hi team,\nCould you add a done button for threads? I keep them around too long.')).toEqual(['Archive']);
  });

  test('a clause after a comma cannot take away what the first one asked', () => {
    expect(said('let me mark a thread as unread, or put it aside as something that waits on me for later')).toEqual(['Mark unread']);
  });

  test('a later part adds a line only by naming a long title, or asking for a feature in a few words', () => {
    expect(said('The list gets busy during the day. It would help with replying when the agent session has ended.')).toEqual(['Replying when the agent session has ended']);
    expect(said('The list gets busy during the day. Is there a way to mark as unread?')).toEqual(['Mark unread']);
    // In passing: a short title, or a feature inside a longer sentence.
    expect(said('The list gets busy during the day. It happens with question cards.')).toEqual([]);
    expect(said('The list gets busy during the day. I opened a thread yesterday and tried marking it unread, then wrote the same reply from another agent again.')).toEqual([]);
  });

  test('a feature mentioned in a clause of a later sentence is a mention, not an ask', () => {
    expect(said('The list gets busy during the day. I went through them all yesterday, tried marking it unread, then wrote the same reply from another agent again.')).toEqual([]);
  });

  test('past its first words a run-on is a later part: it can still name a long title', () => {
    expect(said('my agents write all day and by the evening I have lost track of who asked what and it would help with replying when the agent session has ended')).toEqual(['Replying when the agent session has ended']);
  });

  test('a title named whole holds however long its line gets', () => {
    const message = 'Support Jira links on Board cards as references so the planning stays in one place and I can follow my tickets from there';
    const typed = message.split(' ');
    const shown = typed.map((_, n) => said(typed.slice(0, n + 1).join(' ')).includes('Jira links on Board cards'));
    expect(shown.indexOf(true)).toBeGreaterThan(-1);
    expect(shown.slice(shown.indexOf(true)).every(Boolean)).toBe(true);
  });

  test('nothing draws on the product name and a word that says nothing yet', () => {
    // As in the shipped file, where titles say "show" and "start" often.
    const common = Array.from({ length: 11 }, (_, n) => [release(`The thread list shows number ${n}`), release(`Start an agent number ${n} from the Inbox`)]).flat();
    const index = relatedIndex({ ...LOOSE, releases: [...LOOSE.releases, ...common] });
    for (const text of ['Inbox: show', 'Inbox show', 'Inbox: start', 'Inbox start', 'Inbox: show me which threads']) expect(relatedLinks(index, text).map((link) => link.title)).toEqual([]);
  });

  test('the product name does not make up the words a title needs', () => {
    expect(said('The Inbox page does not refresh on its own')).toEqual([]);
    expect(said('Inbox: start a new claude session')).toEqual([]);
    expect(said('Inbox: start a new claude session when I start a new thread')).toEqual([]);
  });

  test('a rare word is enough beside the product name, and the asks still come early', () => {
    expect(said('the inbox uses too much memory')).toHaveLength(1);
    expect(said('Inbox: mark a thread')).toEqual([]);
    expect(said('Inbox: mark a thread unread')).toEqual(['Mark unread']);
    expect(said('Inbox: a Done button')).toEqual(['Archive']);
  });

  test('a later part names a title without saying the product', () => {
    expect(said('The sidebar is fine and works well. Is there a way to start a Grok Build session')).toEqual(['Start a Grok Build session from the Inbox']);
  });

  test('past its first words, a run-on can still ask for a feature in a few words', () => {
    expect(said('my agents write all day and by the evening I have lost track of what they wanted and mark unread')).toEqual(['Mark unread']);
  });

  test('a later part never replaces, and never adds a second line', () => {
    const text = 'I need a done button on each thread. It would help with replying when the agent session has ended. And a code tour on linux when claude code sandbox cannot start.';
    expect(said(text)).toEqual(['Archive']);
    const two = 'The list gets busy during the day. It would help with replying when the agent session has ended. And a code tour on linux when claude code sandbox cannot start.';
    expect(said(two)).toEqual(['Replying when the agent session has ended']);
  });

  test('common words spread through a title do not draw it, even in the opening', () => {
    const titles = said('start a new claude session when I start a new thread');
    expect(titles).not.toContain('Code Tour on Linux when Claude Code sandbox cannot start');
  });

  test('a title must hold about half of what was asked, not just most of its own words', () => {
    expect(said('Inbox: start a fresh claude session whenever I start a thread')).toEqual([]);
  });

  test('the same text gives the same lines, typed or pasted', () => {
    expect(said(ASK)).toEqual(said(ASK));
    const typed = ASK.split(' ').reduce((text, word) => {
      said(text);
      return `${text} ${word}`;
    });
    expect(said(typed)).toEqual(said(ASK));
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
    expect(text).not.toMatch(/\/Users\/|\/home\/|C:\\\\Users|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });

  // The shipped hand list over the frozen titles: a new release's title must not fail a tagged build.
  const shippedList = relatedIndex({ ...FROZEN, features: shipped.features });
  const shippedTitles = (text: string) => relatedLinks(shippedList, text).map((link) => link.title);

  test('a hand-list phrase is never one word: one word fires under praise and bug reports', () => {
    for (const feature of shipped.features) for (const phrase of feature.phrases) expect(phrase).toContain(' ');
  });

  test.each([
    'this is my favorite tool',
    'this tool is trash',
    'docker compose fails on startup',
    'please pin the version in the installer',
    'this reminds me of linear',
    'the plan page is broken on my phone',
    'new message sound is too loud',
  ])('the hand list says nothing under: %s', (text) => {
    expect(shippedTitles(text)).toEqual([]);
  });

  test.each([
    ['need a done button', 'Archive'],
    ['close a thread when I am finished', 'Archive'],
    ['mark as unread', 'Mark unread'],
    ['mark a thread as unread', 'Mark unread'],
    ['pin a thread', 'Pin a thread'],
    ['remind me later', 'Snooze a thread'],
    ['reply by voice', 'Voice'],
    ['compose a message', 'New message'],
    ['please add dark mode', 'Settings, Appearance'],
    ['can I use this on my phone', 'Over your tailnet'],
  ])('the hand list answers: %s', (text, title) => {
    expect(shippedTitles(text)).toContain(title);
  });
});
