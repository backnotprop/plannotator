import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { liveMentionSource } from './LiveComposer';
import { setLiveCommentSource, takeCommentTags } from './commentTags';

const hasDom = typeof document !== 'undefined';
const AnnotationToolbar = hasDom ? (await import('../components/AnnotationToolbar')).AnnotationToolbar : (null as never);
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  setLiveCommentSource(undefined);
});

function Harness({ onSubmit }: { onSubmit: () => void }) {
  const [text, setText] = useState('');
  return (
    <AnnotationToolbar
      toolbarState={{ position: { top: 100, left: 300 }, range: { start: 4, end: 4, side: 'additions' } } as never}
      toolbarRef={React.createRef<HTMLDivElement>()}
      commentText={text}
      setCommentText={setText}
      suggestedCode=""
      setSuggestedCode={() => {}}
      showSuggestedCode={false}
      setShowSuggestedCode={() => {}}
      askAIMode={false}
      setAskAIMode={() => {}}
      setShowCodeModal={() => {}}
      setShowCommentModal={() => {}}
      onSubmit={onSubmit}
      onDismiss={() => {}}
      onCancel={() => {}}
      conventionalCommentsEnabled={false}
      conventionalLabel={null}
      onConventionalLabelChange={() => {}}
      decorations={[]}
      onDecorationsChange={() => {}}
    />
  );
}

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
  });
}
const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });

describe.skipIf(!hasDom)('the comment box with the Inbox running', () => {
  test('@ offers the connected agents and a saved comment carries the tag to send it now', async () => {
    setLiveCommentSource(liveMentionSource([{ host: 'pi', session: 'ses-pi', label: null, busy: false, project: 'billing', here: true }]));
    const onSubmit = mock(() => {});
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<Harness onSubmit={onSubmit} />));
    const box = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Leave feedback, or @ an agent to send it now"]')!;
    expect(box).not.toBeNull();
    await type(box, 'Why 5? @');
    expect(document.querySelector('[data-mention-picker]')?.textContent).toContain('Pi');
    await press(box, 'ArrowDown');
    await press(box, 'Enter');
    expect(box.value).toBe('Why 5? @Pi ');
    await press(box, 'Enter', { metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(takeCommentTags()).toEqual([{ host: 'pi', session: 'ses-pi', label: 'Pi' }]);
  });

  test('with no Inbox the box is as it was', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<Harness onSubmit={() => {}} />));
    expect(document.querySelector('textarea[placeholder="Leave feedback..."]')).not.toBeNull();
  });
});
