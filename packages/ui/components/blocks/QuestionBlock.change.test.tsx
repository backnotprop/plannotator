/**
 * A question that proposes a change, on its card (change lines, approval
 * "before-after", the Versions card).
 *
 * What regresses if this fails: a card without these lines changes at all;
 * the place (Where) or a side of the comparison goes missing; removed words
 * lose their strike or added words their mark (or a mostly rewritten line is
 * struck end to end); the Versions rule stops moving today's words onto the
 * choice that keeps them; a choice's own pictures stop opening, or opening one
 * picks the choice; a screen reader stops hearing "Where … Now … After …"
 * and which words change; an Inbox that does not read the lines stops showing
 * them as text; a line the card does not draw whole (a lone Where or
 * Before under a choice) disappears; a picture choice's own version is
 * dropped from its tile; a choice's version becomes part of its radio's name
 * (a screen reader reads the whole comparison on every arrow key).
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { indexQuestionBlocks, type QuestionAnswer } from '@plannotator/core/question-block';
import type { Annotation } from '../../types';
import { parseMarkdownToBlocks } from '../../utils/parser';
import { collectQuestionAnswers, upsertQuestionAnswerAnnotation } from '../../utils/questionAnswers';
import { BlockRenderer } from '../BlockRenderer';
import { ImageResolverContext, type ImageResolver } from '../ImageResolverContext';

const hasDom = typeof document !== 'undefined';

const AGENT_LINE = `:::question
Let the review agent flag missing tests when behaviour changes?

Where: The rules Claude follows when you press Review with agent.
Shows: ![The rules, the line circled](review.png)
Source: packages/server/claude-review.ts:180
Before:
> - Never comment on formatting unless guidance files say to
> - Never flag missing test coverage unless guidance files say to

- [ ] Narrow it
    After:
    > - Never comment on formatting unless guidance files say to
    > - Flag missing tests only when the change alters behaviour and nothing tests it
- [ ] Leave it

Recommended: Narrow it
:::`;

const BANNER = `:::question
Reword the line above a file that changed after it was sent?

Where: The line above a file you open from a thread.
Where: When you open the file
Before: Changed since Claude Code sent it at 5:40 PM. Edited 5:51 PM. [Open the version it sent](#)
After: You are viewing the file as it is now, edited 5:51 PM. [Open the version Claude Code sent](#)
Where: After you press Open the version it sent
Before: The version Claude Code sent at 5:40 PM. [Open the file as it is now](#)
After: You are viewing the version Claude Code sent at 5:40 PM. [Open the file as it is now](#)

- [ ] Yes, both
- [ ] Leave both

Recommended: Yes, both
:::`;

const CONTRAST = `:::question-multi
Which of these contrast fixes go in?

Where: Four themes, each in the place the problem shows.

- [ ] Tags on dark themes
    Before: ![Now](tags-now.png)
    After: ![After](tags-after.png)
- [ ] Links in Dracula
    Before: ![Now](links-now.png)
    After: ![After](links-after.png)

Recommended: Tags on dark themes
:::`;

const PLAIN = `:::question
Which checkout drawer should ship?
Stakes: ships to all of checkout on Thursday.
Shows: ![Both drawers](nav.png)

Context in a sentence.

- [ ] A · Total on top — closest to today
- [ ] B · Total pinned

Recommended: B · Total pinned
Why: only B keeps the total next to Pay.
:::`;

// happy-dom fires `error` for a URL it cannot fetch: hand the card data URLs.
const loads: ImageResolver = (src) => ({ kind: 'src', src: `data:image/gif;name=${encodeURIComponent(src)};base64,R0lGODlhAQABAAAAACw=` });

let latest: Annotation[] = [];
const opened: Array<[string, string]> = [];

function Harness({ markdown, changeLines = true, opens = true }: { markdown: string; changeLines?: boolean; opens?: boolean }) {
  const blocks = parseMarkdownToBlocks(markdown);
  const index = indexQuestionBlocks(blocks, { contractLines: true, optionLines: true, ...(changeLines ? { changeLines: true } : {}) });
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  latest = annotations;
  const answers = collectQuestionAnswers(annotations);
  return (
    <ImageResolverContext.Provider value={loads}>
      <div>
        {blocks.map((block) => {
          const question = index.find((q) => q.blockId === block.id);
          return (
            <BlockRenderer
              key={block.id}
              block={block}
              question={question}
              questionTotal={index.length}
              questionAnswer={question ? answers.get(question.question.key) : undefined}
              onAnswerQuestion={(blockId, answer, key) => setAnnotations((current) => upsertQuestionAnswerAnnotation(current, blockId, answer, key))}
              onImageClick={opens ? (src, alt) => opened.push([src, alt]) : undefined}
              questionPictureChoices
            />
          );
        })}
      </div>
    </ImageResolverContext.Provider>
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

async function unmount() {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(async () => {
  await unmount();
  latest = [];
  opened.length = 0;
});

const answer = (): QuestionAnswer | undefined => latest.find((a) => a.questionAnswer)?.questionAnswer;
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const srText = (el: Element) => [...el.querySelectorAll('.qc-sr')].map(text).join(' ');
/** A choice's row with its own change under it, by its label. */
const changeRow = (el: Element, label: string) =>
  [...el.querySelectorAll('[data-question-option-with-change]')].find((r) => text(r.querySelector('label [data-question-part="choice"] > span')) === label)!;
/** What a choice's input is described by. */
const description = (el: Element, input: Element) =>
  (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => text(el.ownerDocument.getElementById(id))).join(' ');
// React's useId differs between two mounts: compare markup with its ids folded.
const markup = (el: Element) => el.innerHTML.replace(/«[^»]*»|:r[0-9a-z]+:|_r_[0-9a-z]+_/g, 'ID');

describe('a card without change lines', () => {
  test.skipIf(!hasDom)('draws exactly as it does when the host does not read change lines', async () => {
    const off = markup(await mount(<Harness markdown={PLAIN} changeLines={false} />));
    await unmount();
    const on = markup(await mount(<Harness markdown={PLAIN} />));
    expect(on).toBe(off);
    expect(on).toContain('data-question-shows');
    expect(on).not.toContain('qc-');
  });
});

describe('the Versions card', () => {
  test.skipIf(!hasDom)('the Where with a pin and See it (the place picture, with its Source); the Shows chip moves there', async () => {
    const el = await mount(<Harness markdown={AGENT_LINE} />);
    const where = el.querySelector('[data-question-part="where"]')!;
    expect(text(where)).toBe('Where: The rules Claude follows when you press Review with agent.See it: The rules, the line circled · packages/server/claude-review.ts:180');
    expect(where.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('[data-question-shows]')).toBeNull();
    // The fieldset is described by the place.
    const fieldset = el.querySelector('fieldset')!;
    expect(fieldset.getAttribute('aria-describedby')?.split(' ')).toContain(where.id);
    await act(async () => (where.querySelector('[data-question-see-it]') as HTMLElement).click());
    expect(opened).toHaveLength(1);
    expect(opened[0]![0]).toContain('review.png');
    expect(opened[0]![1]).toBe('The rules, the line circled · packages/server/claude-review.ts:180');
    // The Source shows nowhere else on the card.
    expect(text(fieldset).replace(text(where), '')).not.toContain('claude-review.ts');
  });

  test.skipIf(!hasDom)('the choice without its own After carries today\'s words, so the separate Now line goes; the version shows its changed line', async () => {
    const el = await mount(<Harness markdown={AGENT_LINE} />);
    expect(el.querySelector('[data-question-change-now]')).toBeNull();
    const narrow = changeRow(el, 'Narrow it');
    const leave = changeRow(el, 'Leave it');
    const version = narrow.querySelector('[data-question-choice-change]')!;
    expect(text(version.querySelector('[aria-hidden="true"]'))).toBe('•Flag missing tests only when the change alters behaviour and nothing tests it');
    // "Leave it" shows today's words in full, so each version can be compared with today.
    const kept = leave.querySelector('[data-question-choice-keeps]')!;
    expect([...kept.querySelectorAll('.qc-line')].map(text)).toEqual(['•Never comment on formatting unless guidance files say to', '•Never flag missing test coverage unless guidance files say to']);
    // The radio is named by its label alone; the version is its description.
    for (const row of [narrow, leave]) {
      const label = row.querySelector('label')!;
      expect(label.querySelector('[data-question-choice-change], .qc-sr')).toBeNull();
    }
    const narrowInput = narrow.querySelector('input')!;
    expect(description(el, narrowInput)).toContain('After: Never comment on formatting unless guidance files say to. Flag missing tests only when');
    expect(description(el, leave.querySelector('input')!)).toBe('Now: Never comment on formatting unless guidance files say to. Never flag missing test coverage unless guidance files say to.');
    // The words are the choice's: a click on them still picks it, and the row and its version take the picked tint as one.
    await act(async () => (version.querySelector('[data-question-choice-words]') as HTMLElement).click());
    expect(answer()?.selected).toEqual(['Narrow it']);
    const picked = changeRow(el, 'Narrow it');
    expect(picked.className).toContain('bg-primary/12');
    expect(picked.querySelector('label')!.className).not.toContain('bg-primary/12');
    expect(changeRow(el, 'Leave it').className).not.toContain('bg-primary/12');
  });

  test.skipIf(!hasDom)('removed words are struck on a red tint in Now, added words marked in After; a mostly rewritten line is unmarked; each place under its own heading', async () => {
    const el = await mount(<Harness markdown={BANNER} />);
    const groups = [...el.querySelectorAll('[data-question-change-group]')];
    expect(groups.map((g) => text(g.querySelector('.qc-gh')))).toEqual(['When you open the file', 'After you press Open the version it sent']);
    // Mostly rewritten: plain on both sides.
    expect(groups[0]!.querySelectorAll('del, ins')).toHaveLength(0);
    expect(text(groups[0]!.querySelector('[data-question-change-now]'))).toBe('Changed since Claude Code sent it at 5:40 PM. Edited 5:51 PM. Open the version it sent');
    // A small edit: the removed word struck, the added words marked, and the screen reader told which.
    expect([...groups[1]!.querySelectorAll('[data-question-change-now] del.qc-del')].map(text)).toEqual(['The']);
    expect([...groups[1]!.querySelectorAll('[data-question-change-after] ins.qc-ins')].map(text)).toEqual(['You are viewing the']);
    expect(groups[1]!.querySelector('.qc-grid')!.getAttribute('aria-hidden')).toBe('true');
    expect(srText(groups[1]!)).toBe('Where: After you press Open the version it sent. Now: The version Claude Code sent at 5:40 PM. Open the file as it is now. After: You are viewing the version Claude Code sent at 5:40 PM. Open the file as it is now. Removed: “The”. Added: “You are viewing the”.');
    // A link in the words shows as one, never as a live link.
    expect(groups[1]!.querySelector('a')).toBeNull();
    expect(text(groups[1]!.querySelector('.qc-link'))).toBe('Open the file as it is now');
  });

  test.skipIf(!hasDom)('pick any: each choice\'s own Now and After pictures sit under its row, outside its label; a picture opens and never picks', async () => {
    const el = await mount(<Harness markdown={CONTRAST} />);
    expect(el.querySelector('[data-question-tiles]')).toBeNull();
    const rows = [...el.querySelectorAll('[data-question-option-with-change]')];
    expect(rows).toHaveLength(2);
    const pictures = rows[0]!.querySelector('[data-question-choice-pictures]')!;
    expect(pictures.closest('label')).toBeNull();
    expect([...pictures.querySelectorAll('figcaption')].map(text)).toEqual(['Now', 'After']);
    // Each picture button is told apart by its choice.
    const open = [...pictures.querySelectorAll<HTMLButtonElement>('button')];
    expect(open.map((b) => b.getAttribute('aria-label'))).toEqual(['Open the picture: Now, Tags on dark themes', 'Open the picture: After, Tags on dark themes']);
    expect([...rows[1]!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Open the picture: Now, Links in Dracula', 'Open the picture: After, Links in Dracula']);
    await act(async () => open[1]!.click());
    expect(opened[0]![0]).toContain('tags-after.png');
    expect(answer()).toBeUndefined();
    // A caption or the gap between the pictures never picks either.
    await act(async () => (pictures.querySelector('figcaption') as HTMLElement).click());
    await act(async () => (pictures.querySelector('.qc-pair') as HTMLElement).click());
    expect(answer()).toBeUndefined();
    await act(async () => (rows[0]!.querySelector('input') as HTMLInputElement).click());
    expect(answer()?.selected).toEqual(['Tags on dark themes']);
  });
});

describe('versions over several places', () => {
  test.skipIf(!hasDom)('each choice shows its places under their names, each with Now and After marked; the screen reader hears each place', async () => {
    const el = await mount(<Harness markdown={`:::question
What should the Sync button and its tooltip say?

- [ ] Sync with team
  Where: the button at the top right of the toolbar
  Before: Sync
  After: Sync with team
  Where: the tooltip under that button
  Before: Syncs your stuff.
  After: Syncs your stuff with the team.
- [ ] Leave them

Recommended: Sync with team
:::`} />);
    const first = changeRow(el, 'Sync with team');
    const leave = [...el.querySelectorAll('label[data-question-option]')][1]!;
    expect([...first.querySelectorAll('.qc-cw')].map(text)).toEqual(['the button at the top right of the toolbar', 'the tooltip under that button']);
    // "Sync" → "Sync with team" keeps one word in three: mostly new, so unmarked. The tooltip is a small edit: marked.
    expect([...first.querySelectorAll('ins.qc-ins')].map(text)).toEqual(['with the team']);
    expect(description(el, first.querySelector('input')!)).toBe('Where: the button at the top right of the toolbar. Now: Sync. After: Sync with team. Where: the tooltip under that button. Now: Syncs your stuff. After: Syncs your stuff with the team. Added: “with the team”.');
    expect(leave.querySelector('[data-question-choice-change]')).toBeNull();
    expect(leave.closest('[data-question-option-with-change]')).toBeNull();
  });
});

describe('what the card does not draw whole stays as written', () => {
  test.skipIf(!hasDom)('a lone Where or Before under a choice stays in its description, and a lone Before at the block\'s indent in the context', async () => {
    const el = await mount(<Harness markdown={`:::question
Where should the nightly export run?

Before: we used cron, which missed runs.

- [ ] Host it ourselves
    Where: our own box in a rented rack
- [ ] Migrate now
    Before: the Friday freeze
- [ ] Use the hosted runner
:::`} />);
    expect(el.querySelector('[data-question-choice-change], [data-question-part="change"], [data-question-part="where"]')).toBeNull();
    const labels = [...el.querySelectorAll('label[data-question-option]')].map(text);
    expect(labels).toEqual(['Host it ourselves — Where: our own box in a rented rack', 'Migrate now — Before: the Friday freeze', 'Use the hosted runner']);
    expect(text(el.querySelector('[data-question-part="context"]'))).toBe('Before: we used cron, which missed runs.');
  });

  test.skipIf(!hasDom)('a Source with no place picture to open shows as written under the Where', async () => {
    const el = await mount(<Harness opens={false} markdown={AGENT_LINE} />);
    expect(text(el.querySelector('[data-question-change-source]'))).toBe('Source: packages/server/claude-review.ts:180');
  });
});

describe('picture choices', () => {
  test.skipIf(!hasDom)('a picture choice\'s own After is drawn in its tile, under its words; it describes the tile\'s input and a click on it picks', async () => {
    const el = await mount(<Harness markdown={`:::question
Which toolbar button?

Before: Button "Sync" · tooltip "Syncs your stuff."

- [ ] A · Sync with team — ![Sync A](sync-a.png) Keeps the word
    After: Button "Sync with team" · tooltip "Sends your edits to the team."
- [ ] B · Share — ![Share B](share-b.png) Shorter
    After: Button "Share" · tooltip "Syncs your stuff."
- [ ] Leave it

Recommended: A · Sync with team
:::`} />);
    const tiles = [...el.querySelectorAll('[data-question-tile]')];
    expect(tiles).toHaveLength(3);
    const version = tiles[0]!.querySelector('[data-question-choice-change]')!;
    expect(version.closest('label')).toBeNull();
    expect(text(version.querySelector('[aria-hidden="true"]'))).toBe('Button "Sync with team" · tooltip "Sends your edits to the team."');
    expect(text(tiles[1]!.querySelector('[data-question-choice-change] [aria-hidden="true"]'))).toBe('Button "Share" · tooltip "Syncs your stuff."');
    expect([...tiles[1]!.querySelectorAll('ins.qc-ins')].map(text)).toEqual(['Share']);
    // The third keeps today's words.
    expect(text(tiles[2]!.querySelector('[data-question-choice-keeps] [aria-hidden="true"]'))).toBe('Button "Sync" · tooltip "Syncs your stuff."');
    const input = tiles[0]!.querySelector('input')!;
    expect(description(el, input)).toContain('After: Button "Sync with team"');
    await act(async () => (version.querySelector('[data-question-choice-words]') as HTMLElement).click());
    expect(answer()?.selected).toEqual(['A · Sync with team']);
  });
});

describe('long values', () => {
  const list = (n: number, changed: number) => Array.from({ length: n }, (_, i) => `> - Rule ${i + 1}${i === changed ? ' now changed' : ''}`).join('\n');
  test.skipIf(!hasDom)('unchanged lines show one on each side of a change, a longer run a quiet "…"', async () => {
    const el = await mount(<Harness markdown={`:::question
Change the rule?

Before:
${list(6, -1)}
After:
${list(6, 1)}

- [ ] Yes
- [ ] No
:::`} />);
    const now = el.querySelector('[data-question-change-now]')!;
    expect([...now.querySelectorAll('.qc-line')].map(text)).toEqual(['•Rule 1', '•Rule 2', '•Rule 3', '…']);
    const after = el.querySelector('[data-question-change-after]')!;
    expect([...after.querySelectorAll('.qc-line')].map(text)).toEqual(['•Rule 1', '•Rule 2 now changed', '•Rule 3', '…']);
  });

  test.skipIf(!hasDom)('a value over twelve lines shows its first twelve and "Show more"', async () => {
    const el = await mount(<Harness markdown={`:::question
Add these rules?

Before: none
After:
${list(20, -1)}

- [ ] Yes
- [ ] No
:::`} />);
    const after = () => el.querySelector('[data-question-change-after]')!;
    expect(after().querySelectorAll('.qc-line')).toHaveLength(12);
    const more = el.querySelector<HTMLButtonElement>('[data-question-change-more]')!;
    expect(text(more)).toBe('Show more');
    await act(async () => more.click());
    expect(after().querySelectorAll('.qc-line')).toHaveLength(20);
    expect(text(more)).toBe('Show less');
    // The screen reader hears every line either way.
    expect(srText(el.querySelector('[data-question-change-group]')!)).toContain('Rule 20.');
  });

  test.skipIf(!hasDom)('under a choice: a long version and the choice keeping today\'s words are capped too, and "Show more" is never hidden from the screen reader', async () => {
    const el = await mount(<Harness markdown={`:::question
Which rules?

Before:
${list(20, -1)}

- [ ] Change one
    After:
${list(20, 3).split('\n').map((l) => `    ${l}`).join('\n')}
- [ ] Leave them
:::`} />);
    const keep = changeRow(el, 'Leave them');
    expect(keep.querySelectorAll('[data-question-choice-keeps] .qc-line')).toHaveLength(12);
    const more = keep.querySelector<HTMLButtonElement>('[data-question-change-more]')!;
    expect(more.closest('[aria-hidden="true"]')).toBeNull();
    await act(async () => more.click());
    expect(keep.querySelectorAll('[data-question-choice-keeps] .qc-line')).toHaveLength(20);
    // Show more never picks the choice it sits under.
    expect(answer()).toBeUndefined();
    for (const button of el.querySelectorAll('[data-question-change-more]')) expect(button.closest('[aria-hidden="true"]')).toBeNull();
  });
});

describe('new strings', () => {
  test.skipIf(!hasDom)('each place leads with its own pin and reads New with its words plain, never dimmed like a neighbour line', async () => {
    const el = await mount(<Harness markdown={`:::question
Use these strings for Shared folders?

Where: The Shared page, under its title, when nothing is shared yet
Before: none
After: Nothing shared yet.
Where: The toast after a folder is shared
Before: none
After: Folder shared.

- [ ] Use both
- [ ] Change some
:::`} />);
    const groups = [...el.querySelectorAll('[data-question-change-group]')];
    expect(groups.map((g) => text(g.querySelector('[data-question-part="where"]')))).toEqual(['Where: The Shared page, under its title, when nothing is shared yet', 'Where: The toast after a folder is shared']);
    expect(groups.map((g) => text(g.querySelector('.qc-k')))).toEqual(['New', 'New']);
    expect(el.querySelectorAll('[data-question-change-after] .qc-dim')).toHaveLength(0);
  });
});

describe('an Inbox that does not read change lines', () => {
  test.skipIf(!hasDom)('shows every line as text: the place, the Before, and the choice\'s After in its description', async () => {
    const el = await mount(<Harness markdown={AGENT_LINE} changeLines={false} />);
    expect(el.querySelector('[data-question-part="where"]')).toBeNull();
    const context = text(el.querySelector('[data-question-part="context"]'));
    expect(context).toContain('Where: The rules Claude follows when you press Review with agent.');
    expect(context).toContain('Never flag missing test coverage unless guidance files say to');
    expect(text(el.querySelector('label[data-question-option]'))).toContain('After: > - Never comment on formatting');
  });
});
