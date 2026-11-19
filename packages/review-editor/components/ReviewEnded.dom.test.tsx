/**
 * A local code review whose agent is gone and whose server is quitting
 * (ReviewEnded.tsx): the page saves its last edits, then shows the ended
 * screen with Copy feedback.
 *
 * What regresses if this fails: the ended screen covers the page before the
 * last edits are saved (a lost comment), or an edit made during that save is
 * dropped; text typed but not added is not kept before the save, or a box
 * that held text from the start (a settings field) is taken for a comment;
 * the screen claims comments were saved when there were none; Copy feedback
 * copies something other than what Send would have sent.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewEndedCopy, reviewEndedSubtitle, useAgentGoneEnding, useTypedTextBoxes } from './ReviewEnded';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
const hosts: HTMLElement[] = [];

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  for (const host of hosts.splice(0)) host.remove();
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

describe('the ending', () => {
  test.skipIf(!hasDom)('saves the draft (twice) before the ended screen shows, then reports how many comments it holds', async () => {
    const events: string[] = [];
    let release: () => void = () => {};
    let ending: ReturnType<typeof useAgentGoneEnding> | null = null;
    function Probe() {
      ending = useAgentGoneEnding({
        unfinishedTexts: () => ['Half-typed'],
        keepUnfinished: (texts) => {
          events.push(`keep:${texts.join('|')}`);
          return texts.length;
        },
        flushDraft: () => {
          events.push('flush');
          return events.length === 2 ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
        },
        savedComments: () => 2,
      });
      if (ending.ended) events.push(`ended:${ending.ended.savedComments}:${ending.ended.keptUnfinished}`);
      return null;
    }
    await render(<Probe />);
    await act(async () => { void ending!.onGone(); await new Promise((resolve) => setTimeout(resolve, 60)); });
    // The send guard flips at once; unfinished text is kept first; the screen waits for the save.
    expect(ending!.gone.current).toBe(true);
    expect(events).toEqual(['keep:Half-typed', 'flush']);
    await act(async () => { release(); await Promise.resolve(); });
    expect(events).toEqual(['keep:Half-typed', 'flush', 'flush', 'ended:2:1']);
    // A second event changes nothing.
    await act(async () => { await ending!.onGone(); });
    expect(events.filter((e) => e === 'flush')).toHaveLength(2);
  });

  test.skipIf(!hasDom)('takes only text boxes the person typed in, and never the AI question boxes', async () => {
    let read: (() => string[]) | null = null;
    function Probe() {
      read = useTypedTextBoxes();
      return null;
    }
    await render(<Probe />);
    const prefilled = document.createElement('textarea');
    prefilled.value = 'A saved setting';
    const typed = document.createElement('textarea');
    const ai = document.createElement('textarea');
    ai.setAttribute('data-not-a-comment', '');
    const emptied = document.createElement('textarea');
    for (const box of [prefilled, typed, ai, emptied]) {
      document.body.appendChild(box);
      hosts.push(box);
    }
    for (const [box, text] of [[typed, ' Why 2? '], [ai, 'What is this?'], [emptied, '  ']] as const) {
      box.value = text;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(read!()).toEqual(['Why 2?']);
  });

  test('says comments were saved only when there are some', () => {
    expect(reviewEndedSubtitle(0)).not.toContain('saved');
    expect(reviewEndedSubtitle(3)).toContain('saved as a draft');
    expect(reviewEndedSubtitle(3).startsWith(reviewEndedSubtitle(0))).toBe(true);
  });

  test.skipIf(!hasDom)('Copy feedback copies what Send would have sent', async () => {
    const written: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text); } },
    });
    try {
      const host = await render(<ReviewEndedCopy copyText={() => '## app.ts\nWhy 2?'} />);
      const copy = host.querySelector<HTMLButtonElement>('[data-review-ended-copy]')!;
      expect(copy.textContent).toBe('Copy feedback');
      await act(async () => {
        copy.click();
        await Promise.resolve();
      });
      expect(written).toEqual(['## app.ts\nWhy 2?']);
      expect(copy.textContent).toBe('Copied');
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});
