/**
 * Change lines (approval "before-after", the Versions card): `Where:`,
 * `Before:`, `After:` and `Source:` in a question block, and `Before:` /
 * `After:` under a `- [ ]` choice, read only when a host asks (`changeLines`,
 * the Inbox's cards).
 *
 * What regresses if this fails: a question that proposes a change loses its
 * place or one side of its comparison; a second place merges into the first;
 * a choice's own version is lost; adding the lines changes the question's key
 * (answers, Replaces / supersedes and drafts stop matching) or a choice's
 * label (the Inbox refuses the person's pick); or an older reader (plan
 * review, the Inbox's server record, an Inbox before this) stops showing the
 * lines as readable text.
 */
import { describe, expect, test } from 'bun:test';
import { parseQuestionBlock, type ParsedQuestion } from './question-block';
import { parseInboxQuestionBlocks } from './inbox-questions';

const ON = { optionLines: true, changeLines: true } as const;
const read = (body: string, kind = 'question') => parseQuestionBlock(kind, body, ON)!;
const plain = (body: string, kind = 'question') => parseQuestionBlock(kind, body, { optionLines: true })!;

/** The question without its change lines: what an agent would have sent before. */
const AGENT_LINE = [
  'Let the review agent flag missing tests when behaviour changes?',
  '',
  'Where: The rules Claude follows when you press Review with agent, in classic review and the Reviews page.',
  'Shows: ![The rules, the line circled](review.png)',
  'Source: packages/server/claude-review.ts:180',
  'Before:',
  '> - Never comment on formatting unless guidance files say to',
  '> - Never flag missing test coverage unless guidance files say to',
  '',
  '- [ ] Narrow it',
  '    After:',
  '    > - Never comment on formatting unless guidance files say to',
  '    > - Flag missing tests only when the change alters behaviour and nothing tests it',
  '- [ ] Leave it',
  '',
  'Recommended: Narrow it',
  'Why: a typo fix still gets no test request.',
].join('\n');

const WITHOUT_LINES = [
  'Let the review agent flag missing tests when behaviour changes?',
  '',
  'Shows: ![The rules, the line circled](review.png)',
  '',
  '- [ ] Narrow it',
  '- [ ] Leave it',
  '',
  'Recommended: Narrow it',
  'Why: a typo fix still gets no test request.',
].join('\n');

const sameIdentity = (a: ParsedQuestion, b: ParsedQuestion) => {
  expect(a.key).toBe(b.key);
  expect(a.prompt).toBe(b.prompt);
  expect(a.kind).toBe(b.kind);
  expect(a.choices.map((c) => c.label)).toEqual(b.choices.map((c) => c.label));
  expect(a.choices.map((c) => c.recommended)).toEqual(b.choices.map((c) => c.recommended));
};

describe('change lines: the forms', () => {
  test('one place: Where and its Source leave the context, a quoted Before keeps its lines, a choice carries its own quoted After', () => {
    const q = read(AGENT_LINE);
    expect(q.change).toEqual({
      where: 'The rules Claude follows when you press Review with agent, in classic review and the Reviews page.',
      source: 'packages/server/claude-review.ts:180',
      groups: [{
        before: { kind: 'text', text: '- Never comment on formatting unless guidance files say to\n- Never flag missing test coverage unless guidance files say to' },
      }],
    });
    expect(q.choices[0].after).toEqual({
      kind: 'text',
      text: '- Never comment on formatting unless guidance files say to\n- Flag missing tests only when the change alters behaviour and nothing tests it',
    });
    expect(q.choices[0].description).toBeUndefined();
    expect(q.choices[1].after).toBeUndefined();
    expect(q.context).toBe('');
    // The contract lines around them are read as before.
    expect(q.shows).toEqual({ kind: 'image', label: 'The rules, the line circled', src: 'review.png' });
    expect(q.why).toBe('a typo fix still gets no test request.');
  });

  test('one-line values, a picture on either side (a GIF too, words after it its caption), and `none` for nothing there', () => {
    const q = read([
      'Update a row where it is when a reply arrives?',
      'Where: The thread list while you read one.',
      'Before: ![Now: the row jumps to the top](today.gif)',
      'After: ![After: the row changes in place](after.gif)',
      'Where: The toast after you turn Plans on',
      'Before: none',
      'After: Plans is on. [Open Plans](#)',
      '- [ ] Yes',
      '- [ ] No',
    ].join('\n'));
    expect(q.change).toEqual({
      groups: [
        { where: 'The thread list while you read one.', before: { kind: 'image', alt: 'Now: the row jumps to the top', src: 'today.gif' }, after: { kind: 'image', alt: 'After: the row changes in place', src: 'after.gif' } },
        { where: 'The toast after you turn Plans on', before: { kind: 'none' }, after: { kind: 'text', text: 'Plans is on. [Open Plans](#)' } },
      ],
    });
    // A picture with words after it on its line: the words are its caption.
    expect(read(['Which?', 'Before: ![Toolbar today](today.png) Button "Sync" · tooltip "Syncs your stuff."', 'After: ![Toolbar after](after.png)', '- [ ] A', '- [ ] B'].join('\n')).change?.groups[0]?.before)
      .toEqual({ kind: 'image', alt: 'Toolbar today', src: 'today.png', caption: 'Button "Sync" · tooltip "Syncs your stuff."' });
  });

  test('groups: a first Where with nothing under it is the question\'s own; each later Where starts a place; a repeated Before or After starts one too', () => {
    const q = read([
      'Reword the line above a file that changed after it was sent?',
      'Where: The line above a file you open from a thread.',
      'Where: When you open the file',
      'Before: Changed since it was sent.',
      'After: You are viewing the file as it is now.',
      'Where: After you press Open the version it sent',
      'Before: The version it sent.',
      'After: You are viewing the version it sent.',
      'Before: A third, with no Where.',
      'After: Its after.',
      '- [ ] Yes, both',
      '- [ ] Leave both',
    ].join('\n'));
    expect(q.change?.where).toBe('The line above a file you open from a thread.');
    expect(q.change?.groups.map((g) => g.where)).toEqual(['When you open the file', 'After you press Open the version it sent', undefined]);
    expect(q.change?.groups.map((g) => (g.before?.kind === 'text' ? g.before.text : null))).toEqual(['Changed since it was sent.', 'The version it sent.', 'A third, with no Where.']);
    expect(q.change?.groups.map((g) => (g.after?.kind === 'text' ? g.after.text : null))).toEqual(['You are viewing the file as it is now.', 'You are viewing the version it sent.', 'Its after.']);
  });

  test('several places that each carry their own Where keep them on the places (no question-level Where)', () => {
    const q = read([
      'Three new lines for Plans?',
      'Where: The Plans page, under its title',
      'Before: none',
      'After: Every plan you review lands here.',
      'Where: The terminal, after plannotator plans',
      'Before: none',
      'After: Plans is on.',
    ].join('\n'));
    expect(q.change?.where).toBeUndefined();
    expect(q.change?.groups.map((g) => g.where)).toEqual(['The Plans page, under its title', 'The terminal, after plannotator plans']);
  });

  test('pick any: a choice with its own Before and After pictures; a second After under it starts its next place', () => {
    const q = read([
      'Which of these contrast fixes go in?',
      'Where: Four themes, each in the place the problem shows.',
      '- [ ] Tags on dark themes',
      '    Before: ![Now](tags-now.png)',
      '    After: ![After](tags-after.png)',
      '    After: its second place',
      '- [ ] Links in Dracula',
      '    Before: ![Now](links-now.png)',
      '    After: ![After](links-after.png)',
      'Recommended: Tags on dark themes, Links in Dracula',
    ].join('\n'), 'question-multi');
    expect(q.kind).toBe('multi');
    expect(q.choices[0]).toMatchObject({
      label: 'Tags on dark themes',
      before: { kind: 'image', alt: 'Now', src: 'tags-now.png' },
      after: { kind: 'image', alt: 'After', src: 'tags-after.png' },
      places: [
        { before: { kind: 'image', alt: 'Now', src: 'tags-now.png' }, after: { kind: 'image', alt: 'After', src: 'tags-after.png' } },
        { after: { kind: 'text', text: 'its second place' } },
      ],
      recommended: true,
    });
    expect(q.choices[0].description).toBeUndefined();
    expect(q.choices[1].places).toBeUndefined();
    // A choice's own pictures never turn it into a picture choice: the change draws them.
    expect(q.choices.every((c) => c.image === undefined)).toBe(true);
    expect(q.change).toEqual({ where: 'Four themes, each in the place the problem shows.', groups: [] });
  });

  test('versions over several places: each choice names its places (Where, Before, After under it), or gives one After per question place in order', () => {
    const q = read([
      'What should the Sync button and its tooltip say?',
      '- [ ] Sync with team',
      '  Where: the button at the top right of the toolbar',
      '  Before: Sync',
      '  After: Sync with team',
      '  Where: the tooltip under that button',
      '  Before: Syncs your stuff.',
      '  After: Sends your edits to the team server.',
      '- [ ] Leave them',
      'Recommended: Sync with team',
    ].join('\n'));
    expect(q.choices[0]).toMatchObject({
      label: 'Sync with team',
      before: { kind: 'text', text: 'Sync' },
      after: { kind: 'text', text: 'Sync with team' },
      places: [
        { where: 'the button at the top right of the toolbar', before: { kind: 'text', text: 'Sync' }, after: { kind: 'text', text: 'Sync with team' } },
        { where: 'the tooltip under that button', before: { kind: 'text', text: 'Syncs your stuff.' }, after: { kind: 'text', text: 'Sends your edits to the team server.' } },
      ],
      recommended: true,
    });
    expect(q.choices[0].description).toBeUndefined();
    expect(q.change).toEqual({ groups: [] });

    const ordered = read([
      'What should the Sync button and its tooltip say?',
      'Where: the button at the top right of the toolbar',
      'Before: Sync',
      'Where: the tooltip under that button',
      'Before: Syncs your stuff.',
      '- [ ] Sync with team',
      '    After: Sync with team',
      '    After: Sends your edits to the team server.',
      '- [ ] Leave them',
    ].join('\n'));
    expect(ordered.change?.groups.map((g) => g.where)).toEqual(['the button at the top right of the toolbar', 'the tooltip under that button']);
    expect(ordered.choices[0].places).toEqual([{ after: { kind: 'text', text: 'Sync with team' } }, { after: { kind: 'text', text: 'Sends your edits to the team server.' } }]);
  });

  test('emphasis around a label and any case are read, as for the contract lines', () => {
    const q = read(['Rename it?', '**Where:** Settings, the heading', '*before*: Old heading', 'AFTER: New heading'].join('\n'));
    expect(q.change).toEqual({ where: 'Settings, the heading', groups: [{ before: { kind: 'text', text: 'Old heading' }, after: { kind: 'text', text: 'New heading' } }] });
  });
});

describe('change lines: what stays text', () => {
  test('an empty value with no quoted line under it, a Source with nothing to show, and lines inside a code fence stay context, as written', () => {
    const q = read([
      'Which?',
      'Before:',
      'Plain words, not a quoted value.',
      'Where:',
      '```',
      'Where: in a fence',
      'After: code',
      '```',
      '- [ ] A',
      '    After:',
      '    not quoted either',
    ].join('\n'));
    expect(q.change).toBeUndefined();
    expect(q.context).toBe(['Before:', 'Plain words, not a quoted value.', 'Where:', '```', 'Where: in a fence', 'After: code', '```'].join('\n'));
    expect(q.choices[0].description).toBe('After: not quoted either');

    const sourceOnly = read(['Which?', 'Source: packages/x.ts:1', '- [ ] A'].join('\n'));
    expect(sourceOnly.change).toBeUndefined();
    expect(sourceOnly.context).toBe('Source: packages/x.ts:1');
  });

  test('a line that continues a plain bullet or wraps a recommendation stays with it (the default parse\'s choices and recommendation)', () => {
    const bullets = ['Pick one?', '- Yes', 'where: the banner', '- No'].join('\n');
    const q = read(bullets);
    sameIdentity(q, plain(bullets));
    expect(q.change).toBeUndefined();
    const rec = ['Pick one?', '- [ ] Keep it going', '- [ ] Stop', 'Recommended: Keep it', 'going'].join('\n');
    sameIdentity(read(rec), plain(rec));
  });

  test('a Before or After under a plain bullet is the bullet\'s', () => {
    const bullets = ['Which?', '- A', '    After: joins the bullet', '- B'].join('\n');
    expect(read(bullets).choices.map((c) => c.label)).toEqual(plain(bullets).choices.map((c) => c.label));
    expect(read(bullets).choices[0].after).toBeUndefined();
  });

  test('two choices that read the same apart from their After keep the default parse\'s whole-text labels', () => {
    const body = ['Which wording?', '- [ ] Change it', '    After: First words', '- [ ] Change it', '    After: Second words'].join('\n');
    expect(read(body).choices.map((c) => c.label)).toEqual(plain(body).choices.map((c) => c.label));
    expect(read(body).choices.map((c) => c.label)).toEqual(['Change it After: First words', 'Change it After: Second words']);
  });

  /** Nothing is drawn: the question reads exactly as the default parse has it. */
  const asWritten = (body: string) => {
    const q = read(body);
    const p = plain(body);
    expect(q.change).toBeUndefined();
    expect(q.context).toBe(p.context);
    expect(q.choices.map((c) => [c.label, c.description, c.before, c.after, c.places])).toEqual(p.choices.map((c) => [c.label, c.description, undefined, undefined, undefined]));
    return q;
  };

  test('a shape the card does not draw whole stays as written, in place: a Where, a Before or an After alone, under a choice or at the block\'s indent', () => {
    // Prose a stored thread already holds: the words stay where they were.
    expect(asWritten([
      'Where should the nightly export run?',
      '- [ ] Host it ourselves',
      '    Where: our own box in a rented rack',
      '- [ ] Migrate now',
      '    Before: the Friday freeze',
      '- [ ] Use the hosted runner',
    ].join('\n')).choices.map((c) => c.description)).toEqual(['Where: our own box in a rented rack', 'Before: the Friday freeze', undefined]);
    expect(asWritten([
      'Keep the retry loop?',
      'Before: we used cron, which missed runs.',
      'The loop has run for a month with no misses.',
      '- [ ] Keep it',
      '- [ ] Go back',
    ].join('\n')).context).toBe('Before: we used cron, which missed runs.\nThe loop has run for a month with no misses.');
    asWritten(['Ship the new export?', 'After: lunch, once the build is green.', '- [ ] Yes', '- [ ] No'].join('\n'));
    asWritten(['Add a banner?', 'Before: none', '- [ ] Yes', '- [ ] No'].join('\n'));
    asWritten(['Which host?', 'Where: the settings page', 'Source: packages/x.ts:1', '- [ ] A', '- [ ] B'].join('\n'));
  });

  test('a drawn place takes only its own lines: a Where written after its place, a lone line under a choice and a Source with no place picture stay as written', () => {
    const q = read([
      'Reword the toast?',
      'Before: Saved.',
      'After: Saved to your drafts.',
      'Where: the toast after you save',
      'Source: packages/x.ts:12',
      '- [ ] Reword it',
      '    Where: only on phones',
      '- [ ] Leave it',
    ].join('\n'));
    expect(q.change).toEqual({ groups: [{ before: { kind: 'text', text: 'Saved.' }, after: { kind: 'text', text: 'Saved to your drafts.' } }] });
    expect(q.context).toBe('Where: the toast after you save\nSource: packages/x.ts:12');
    expect(q.choices[0].description).toBe('Where: only on phones');
    // A choice with a drawn After and a second place with no After: the After is drawn, the rest stays.
    const choice = read(['Which?', '- [ ] A', '    After: New words', '    Where: the footer', '    Before: Old footer', '- [ ] B'].join('\n'));
    expect(choice.choices[0].after).toEqual({ kind: 'text', text: 'New words' });
    expect(choice.choices[0].description).toBe('Where: the footer Before: Old footer');
  });

  test('picture choices keep their own After (the card draws it in the tile), and their description keeps what is not drawn', () => {
    const body = [
      'Which toolbar?',
      '- [ ] A · Sync with team — ![Sync A](sync-a.png) Keeps the word',
      '    After: Button "Sync with team" · tooltip "Sends your edits to the team."',
      '- [ ] B · Share — ![Share B](share-b.png) Shorter',
      '    After: Button "Share"',
    ].join('\n');
    const q = read(body);
    expect(q.choices.map((c) => c.after)).toEqual([
      { kind: 'text', text: 'Button "Sync with team" · tooltip "Sends your edits to the team."' },
      { kind: 'text', text: 'Button "Share"' },
    ]);
    expect(q.choices.every((c) => !c.description?.includes('After:'))).toBe(true);
    sameIdentity(q, plain(body));
  });

  test('a recommended marker reads as the default parse reads it, with a choice\'s own After under it', () => {
    const body = ['Narrow the rule?', '- [ ] Narrow it — recommended', '    After: Flag missing tests only when behaviour changes.', '- [ ] Leave it'].join('\n');
    expect(read(body).choices.map((c) => c.recommended)).toEqual(plain(body).choices.map((c) => c.recommended));
    expect(read(body).recommendedMarker).toBe(plain(body).recommendedMarker);
    const marked = ['Narrow the rule?', '- [ ] Narrow it (recommended)', '    After: Flag missing tests only when behaviour changes.', '- [ ] Leave it'].join('\n');
    expect(read(marked).choices.map((c) => [c.label, c.recommended])).toEqual(plain(marked).choices.map((c) => [c.label, c.recommended]));
  });
});

describe('change lines: one line, or quoted lines; a choice\'s lines indented under it', () => {
  test('a value written after its label is that one line: the plain line under it stays the agent\'s own words', () => {
    const q = read([
      'Keep the systemd timers?',
      'Before: we used cron.',
      'After: we use systemd timers.',
      'That cut missed runs to zero.',
      '- [ ] Keep them',
      '- [ ] Go back',
    ].join('\n'));
    expect(q.change?.groups).toEqual([{ before: { kind: 'text', text: 'we used cron.' }, after: { kind: 'text', text: 'we use systemd timers.' } }]);
    expect(q.context).toBe('That cut missed runs to zero.');
    // Under a choice too: the line under its After stays in its description.
    const choice = read(['Which?', '- [ ] A', '    After: One line', '    and why I like it', '- [ ] B'].join('\n'));
    expect(choice.choices[0].after).toEqual({ kind: 'text', text: 'One line' });
    expect(choice.choices[0].description).toBe('and why I like it');
  });

  test('lines written at the block\'s indent right after the choices are the question\'s, never the last choice\'s', () => {
    const body = [
      'Rename the Settings heading?',
      '- [ ] Rename it',
      '- [ ] Leave it',
      'Before: When an agent asks you',
      'After: When an agent sends you something',
    ].join('\n');
    const q = read(body);
    expect(q.change?.groups).toEqual([{ before: { kind: 'text', text: 'When an agent asks you' }, after: { kind: 'text', text: 'When an agent sends you something' } }]);
    expect(q.choices.map((c) => [c.label, c.description, c.before, c.after])).toEqual([['Rename it', undefined, undefined, undefined], ['Leave it', undefined, undefined, undefined]]);
    sameIdentity(q, plain(body));
    // Old prose after the last choice stays prose, in the question's context.
    const prose = ['Ship it now?', '- [ ] Yes', '- [ ] No', 'After: the freeze lifts we can revisit.'].join('\n');
    const old = read(prose);
    expect(old.change).toBeUndefined();
    expect(old.choices.map((c) => [c.label, c.description, c.after])).toEqual([['Yes', undefined, undefined], ['No', undefined, undefined]]);
    expect(old.context).toBe(plain(prose).context);
    expect(old.context).toBe('After: the freeze lifts we can revisit.');
  });

  test('a picture written with a title loads: the title is not part of its address', () => {
    const q = read([
      'Change the toolbar?',
      'Shows: ![The toolbar](shots/bar.png "The toolbar today")',
      'Where: the toolbar',
      "Before: ![Now](shots/now.png 'Today')",
      'After: ![After](shots/after.png "The new toolbar") One button fewer.',
      '- [ ] Yes',
      '- [ ] No',
    ].join('\n'), 'question');
    expect(parseQuestionBlock('question', 'Which?\nShows: ![The toolbar](shots/bar.png "The toolbar today")\n- [ ] A', { contractLines: true })!.shows)
      .toMatchObject({ kind: 'image', src: 'shots/bar.png' });
    expect(q.change?.groups[0]?.before).toEqual({ kind: 'image', alt: 'Now', src: 'shots/now.png' });
    expect(q.change?.groups[0]?.after).toEqual({ kind: 'image', alt: 'After', src: 'shots/after.png', caption: 'One button fewer.' });
  });

});

describe('change lines: identity and older readers', () => {
  test('adding the lines never changes the key, the prompt, the labels or the recommendation', () => {
    const before = read(WITHOUT_LINES);
    const after = read(AGENT_LINE);
    sameIdentity(after, before);
    // Whether or not a reader reads them.
    sameIdentity(after, plain(AGENT_LINE));
    sameIdentity(after, parseQuestionBlock('question', AGENT_LINE)!);
    sameIdentity(after, parseQuestionBlock('question', AGENT_LINE, { contractLines: false })!);
  });

  test('a reader without change lines (plan review, an older Inbox) keeps every line as readable text: context lines, a quote, and the choice\'s description', () => {
    const q = plain(AGENT_LINE);
    expect(q.change).toBeUndefined();
    expect(q.context.split('\n')).toEqual([
      'Where: The rules Claude follows when you press Review with agent, in classic review and the Reviews page.',
      'Source: packages/server/claude-review.ts:180',
      'Before:',
      '> - Never comment on formatting unless guidance files say to',
      '> - Never flag missing test coverage unless guidance files say to',
    ]);
    expect(q.choices[0].description).toBe('After: > - Never comment on formatting unless guidance files say to > - Flag missing tests only when the change alters behaviour and nothing tests it');
    expect(q.choices[0].after).toBeUndefined();
  });

  test('the Inbox\'s stored record is the default parse: the lines stay in its context and descriptions, the key and labels unchanged', () => {
    const [record] = parseInboxQuestionBlocks(`:::question\n${AGENT_LINE}\n:::\n`);
    const [bare] = parseInboxQuestionBlocks(`:::question\n${WITHOUT_LINES}\n:::\n`);
    expect(record.key).toBe(bare.key);
    expect(record.parsed.choices.map((c) => c.label)).toEqual(['Narrow it', 'Leave it']);
    expect(record.parsed.context).toContain('Where: The rules Claude follows');
    expect(record.parsed.context).toContain('> - Never flag missing test coverage');
    expect(record.parsed.choices[0].description).toContain('After: > - Never comment');
    expect('change' in record.parsed).toBe(false);
  });
});
