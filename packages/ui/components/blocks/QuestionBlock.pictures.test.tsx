/**
 * Picture choices and the contract lines on the question card (approval
 * "inbox-decision-mode", agent contract lines; onboarding AUDIT finding 10).
 *
 * What regresses if this fails: a picture choice's picture no longer picks it
 * (or picks AND zooms on one click, the old bug), the zoom button picks, a
 * tile has no real radio/checkbox to reach by keyboard, the answer carries
 * raw markdown instead of the label, a host that cannot show images gets
 * broken tiles instead of text rows, or Stakes / Why / Shows / Reversible
 * stop showing.
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

const SINGLE = `:::question
Which checkout drawer should ship?
Stakes: ships to all of checkout on Thursday.
Shows: ![Both drawers](nav.png)
Reversible: no — the old drawer is deleted

- [ ] A · Total on top — ![Drawer A](drawer-a.png) closest to today
- [ ] B · Total pinned — ![Drawer B](drawer-b.png)
- [ ] ![C](c.png) C

Recommended: B · Total pinned

Why: only B keeps the total next to Pay.
:::`;

const MULTI = `:::question-multi
Which layouts?

- Tabs — ![Tabs layout](tabs.png)
- Sidebar — ![Sidebar layout](side.png)

Recommended: Sidebar, a split view
:::`;

// happy-dom fires `error` for a URL it cannot fetch, which the card reads as a
// picture that cannot be shown: the default resolver hands it data URLs.
const loads: ImageResolver = (src) => ({ kind: 'src', src: `data:image/gif;name=${encodeURIComponent(src)};base64,R0lGODlhAQABAAAAACw=` });

let latest: Annotation[] = [];
const zoomed: Array<[string, string]> = [];

function Harness({ markdown, resolver = loads, readOnly = false, badge }: { markdown: string; resolver?: ImageResolver; readOnly?: boolean; badge?: (choice: { label: string; image: { alt: string; src: string } }) => string | null }) {
  const blocks = parseMarkdownToBlocks(markdown);
  const index = indexQuestionBlocks(blocks);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  latest = annotations;
  const answers = collectQuestionAnswers(annotations);
  const body = (
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
            onAnswerQuestion={readOnly ? undefined : (blockId, answer, key) => setAnnotations((current) => upsertQuestionAnswerAnnotation(current, blockId, answer, key))}
            onImageClick={(src, alt) => zoomed.push([src, alt])}
            questionPictureBadge={badge}
          />
        );
      })}
    </div>
  );
  return <ImageResolverContext.Provider value={resolver}>{body}</ImageResolverContext.Provider>;
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

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = [];
  zoomed.length = 0;
});

const answer = (): QuestionAnswer | undefined => latest.find((a) => a.questionAnswer)?.questionAnswer;
const tiles = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[data-question-tile]'));

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

describe('picture choices', () => {
  test.skipIf(!hasDom)('a host may label each picture (pictureBadge); without one no tile has a label, and the label never picks or answers', async () => {
    const plain = await mount(<Harness markdown={SINGLE} />);
    expect(plain.querySelectorAll('[data-question-picture-badge]')).toHaveLength(0);
    await act(async () => root!.unmount());
    host?.remove();
    const el = await mount(<Harness markdown={SINGLE} badge={(choice) => (choice.image.src === 'c.png' ? null : 'Mockup · VS Code')} />);
    const badges = [...el.querySelectorAll<HTMLElement>('[data-question-picture-badge]')];
    expect(badges.map((b) => b.textContent)).toEqual(['Mockup · VS Code', 'Mockup · VS Code']);
    // Over the picture, inside its tile.
    expect(badges[0]!.closest('[data-question-tile]') === tiles(el)[0]).toBe(true);
    await click(tiles(el)[0]!.querySelector('img[data-question-picture]')!);
    expect(answer()?.selected).toEqual(['A · Total on top']);
  });

  test.skipIf(!hasDom)('draw as tiles; the picture picks, and the answer is the plain label', async () => {
    const el = await mount(<Harness markdown={SINGLE} />);
    const all = tiles(el);
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.querySelector('[data-question-part="choice"] > span')!.textContent)).toEqual(['A · Total on top', 'B · Total pinned', 'C']);
    expect(all.map((t) => t.querySelector('img')!.getAttribute('data-image-src'))).toEqual(['drawer-a.png', 'drawer-b.png', 'c.png']);
    expect(all[0].textContent).toContain('closest to today');
    expect(all[1].textContent).toContain('Recommended');
    await click(all[1].querySelector('img[data-question-picture]')!);
    expect(answer()?.selected).toEqual(['B · Total pinned']);
    expect(zoomed).toHaveLength(0);
    expect(tiles(el)[1].hasAttribute('data-question-tile-checked')).toBe(true);
    expect(latest.find((a) => a.questionAnswer)!.text).toBe('Answer: B · Total pinned');
  });

  test.skipIf(!hasDom)('zoom is a separate button: it opens the picture and never picks', async () => {
    const el = await mount(<Harness markdown={SINGLE} />);
    const zoom = tiles(el)[0].querySelector<HTMLButtonElement>('button[data-question-zoom]')!;
    expect(zoom.closest('label')).toBeNull();
    expect(zoom.getAttribute('aria-label')).toBe('Zoom: Drawer A');
    await click(zoom);
    expect(zoomed).toEqual([[tiles(el)[0].querySelector('img')!.getAttribute('src')!, 'Drawer A']]);
    expect(answer()).toBeUndefined();
  });

  test.skipIf(!hasDom)('each tile holds a real radio (checkbox on pick any) in one group, reachable and pickable by keyboard', async () => {
    const el = await mount(<Harness markdown={SINGLE} />);
    const inputs = tiles(el).map((t) => t.querySelector<HTMLInputElement>('input[data-question-control]')!);
    expect(inputs.map((i) => i.type)).toEqual(['radio', 'radio', 'radio']);
    expect(new Set(inputs.map((i) => i.name)).size).toBe(1);
    expect(inputs[0].closest('[role="radiogroup"]')).not.toBeNull();
    inputs[2].focus();
    expect(document.activeElement).toBe(inputs[2]);
    // Space on a focused radio is a click.
    await click(inputs[2]);
    expect(answer()?.selected).toEqual(['C']);
    // The alt text names the picture; one that only repeats the label is decorative.
    expect(tiles(el)[0].querySelector('img')!.getAttribute('alt')).toBe('Drawer A');
    expect(tiles(el)[2].querySelector('img')!.getAttribute('alt')).toBe('');
  });

  test.skipIf(!hasDom)('pick any: checkboxes; the extra Recommended row stays a text row below the tiles', async () => {
    const el = await mount(<Harness markdown={MULTI} />);
    const all = tiles(el);
    expect(all.map((t) => t.querySelector('input')!.type)).toEqual(['checkbox', 'checkbox']);
    await click(all[0].querySelector('img')!);
    await click(tiles(el)[1].querySelector('img')!);
    expect(answer()?.selected).toEqual(['Tabs', 'Sidebar']);
    const row = el.querySelector<HTMLElement>('label[data-question-suggested]')!;
    expect(row.closest('[data-question-tile]')).toBeNull();
    expect(row.textContent).toContain('a split view');
  });

  test.skipIf(!hasDom)('a host whose resolver cannot show the pictures gets text rows with plain labels', async () => {
    const el = await mount(<Harness markdown={SINGLE} resolver={() => ({ kind: 'unavailable', title: 'no images here' })} />);
    expect(tiles(el)).toHaveLength(0);
    const rows = Array.from(el.querySelectorAll('label[data-question-option]'));
    expect(rows.map((r) => r.querySelector('[data-question-part="choice"] > span')!.textContent)).toEqual(['A · Total on top', 'B · Total pinned', 'C']);
    expect(el.querySelector('fieldset')!.textContent).not.toContain('![');
    await click(rows[0].querySelector('span')!);
    expect(answer()?.selected).toEqual(['A · Total on top']);
  });

  test.skipIf(!hasDom)('pictures that fail to load fall back to text rows', async () => {
    const el = await mount(<Harness markdown={MULTI} />);
    for (const img of el.querySelectorAll('img[data-question-picture]')) {
      await act(async () => {
        img.dispatchEvent(new Event('error'));
      });
    }
    expect(tiles(el)).toHaveLength(0);
    expect(el.querySelectorAll('label[data-question-option]').length).toBe(3);
  });
});

/**
 * Move every text node under `el` into its own <mark>, as the annotation
 * highlighter does for a restored comment. React no longer finds those text
 * nodes where it put them; a placeholder that React inserts before one of
 * them throws, and the whole tree unmounts.
 */
function wrapEveryText(el: HTMLElement) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if ((node as Text).data.trim()) texts.push(node as Text);
  for (const text of texts) {
    const mark = document.createElement('mark');
    text.parentNode!.insertBefore(mark, text);
    mark.appendChild(text);
  }
}

describe('a picture that fails to load after the highlighter moved the text beside it', () => {
  // What regresses if this fails: an image that fails after a restored comment
  // wrapped the words next to it makes React throw in insertBefore, and the
  // whole document goes blank (review of #2177).
  test.skipIf(!hasDom)('an inline image: the placeholder shows and the words stay', async () => {
    const el = await mount(<Harness markdown={'![gone](x.png)words after it'} />);
    const img = el.querySelector<HTMLImageElement>('img')!;
    const words = img.nextSibling as Text;
    expect(words.nodeType).toBe(Node.TEXT_NODE);
    const mark = document.createElement('mark');
    words.parentNode!.insertBefore(mark, words);
    mark.appendChild(words);
    await act(async () => {
      img.dispatchEvent(new Event('error'));
    });
    expect(el.textContent).toContain('words after it');
    expect(el.querySelector('mark')!.textContent).toBe('words after it');
    const chip = el.querySelector<HTMLElement>('[data-image-unavailable]')!;
    expect(chip.textContent).toBe('gone');
    // Never quoted by a text comment.
    expect(chip.classList.contains('annotation-exclude')).toBe(true);
    // No broken image is drawn: the <img> stays in place, hidden and unnamed.
    expect([...el.querySelectorAll('img')].every((i) => i.hidden && i.alt === '')).toBe(true);
  });

  test.skipIf(!hasDom)('a Shows picture and picture tiles: the card falls back and keeps its text', async () => {
    const el = await mount(<Harness markdown={SINGLE} />);
    wrapEveryText(el);
    for (const img of [...el.querySelectorAll('img[data-question-picture]')]) {
      await act(async () => {
        img.dispatchEvent(new Event('error'));
      });
    }
    const card = el.querySelector<HTMLElement>('fieldset')!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Which checkout drawer should ship?');
    expect(card.querySelector('[data-question-shows]')!.textContent).toContain('Both drawers');
    expect(tiles(el)).toHaveLength(0);
    expect(el.querySelectorAll('label[data-question-option]').length).toBe(3);
  });
});

describe('contract lines on the card', () => {
  test.skipIf(!hasDom)('Stakes under the prompt, Shows as a chip that opens the picture, Why under the choices, the Can\'t be undone tag', async () => {
    const el = await mount(<Harness markdown={SINGLE} />);
    const card = el.querySelector<HTMLElement>('fieldset')!;
    const prompt = card.querySelector('[data-question-part="prompt"]')!;
    const stakes = card.querySelector('[data-question-part="stakes"]')!;
    expect(stakes.textContent).toBe('ships to all of checkout on Thursday.');
    expect(prompt.nextElementSibling).toBe(stakes);
    expect(card.getAttribute('aria-describedby')).toContain(stakes.id);
    expect(card.querySelector('[data-question-irreversible]')!.textContent).toContain('Can’t be undone');
    expect(card.querySelector('[data-question-irreversible]')!.textContent).toContain('the old drawer is deleted');
    expect(card.querySelector('[data-question-part="why"]')!.textContent).toBe('Why B · Total pinned: only B keeps the total next to Pay.');
    const shows = card.querySelector<HTMLButtonElement>('[data-question-shows-open]')!;
    expect(shows.textContent).toContain('Both drawers');
    await click(shows);
    expect(zoomed[0]![1]).toBe('Both drawers');
    expect(answer()).toBeUndefined();
    // None of the lines is context.
    expect(card.querySelector('[data-question-part="context"]')).toBeNull();
  });

  test.skipIf(!hasDom)('a Shows picture that fails to load is its label, never a broken image', async () => {
    const el = await mount(<Harness markdown={SINGLE} />);
    const thumb = el.querySelector<HTMLImageElement>('[data-question-shows] img')!;
    await act(async () => {
      thumb.dispatchEvent(new Event('error'));
    });
    const shows = el.querySelector<HTMLElement>('[data-question-shows]')!;
    expect(shows.querySelector('img')).toBeNull();
    expect(shows.querySelector('[data-question-shows-open]')).toBeNull();
    expect(shows.textContent).toContain('Both drawers');
    // The choices' own pictures still load as tiles.
    expect(tiles(el)).toHaveLength(3);
  });

  test.skipIf(!hasDom)('Shows as a file is a link', async () => {
    const el = await mount(<Harness markdown={`:::question\nRestructure the nav?\nShows: [the nav plan](docs-nav-plan.md)\n- [ ] Yes\n- [ ] No\n:::`} />);
    const shows = el.querySelector('[data-question-shows]')!;
    expect(shows.textContent).toContain('the nav plan');
    expect(shows.querySelector('a, button, [role="link"], span.text-primary')).not.toBeNull();
  });
});
