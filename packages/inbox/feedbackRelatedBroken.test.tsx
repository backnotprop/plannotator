/**
 * The list's file cannot be read: the form must be exactly today's, with no
 * error thrown into the window. Its own file, because the file is read once a
 * page and the mock has to be in place first.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
mock.module('./feedbackRelated.data.json?raw', () => ({ default: 'this is not json' }));
const { FeedbackDialog } = (hasDom ? await import('./components/FeedbackDialog') : {}) as typeof import('./components/FeedbackDialog');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  if (hasDom) document.body.innerHTML = '';
});

describe.skipIf(!hasDom)('Might be related when its file cannot be read', () => {
  test('no lines, nothing thrown, and the form still takes words', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root!.render(<FeedbackDialog version="1.0.0" phone={false} onSend={async () => {}} onCopyPrompt={() => {}} onClose={() => {}} />));
    await act(async () => new Promise((done) => setTimeout(done, 30)));
    const box = document.querySelector<HTMLTextAreaElement>('[data-feedback-message]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'need a done button');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => new Promise((done) => setTimeout(done, 650)));
    expect(box.value).toBe('need a done button');
    expect(document.querySelector('[data-feedback-related]')!.childNodes.length).toBe(0);
    expect(document.querySelector('[data-feedback-send]')).not.toBeNull();
  });
});
