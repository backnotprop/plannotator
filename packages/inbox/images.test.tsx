/**
 * Images in a message (#1813): a message body drawn by ui's Viewer
 * the way the thread draws it (images based on the message) asks the Inbox's
 * per-message route for a relative or absolute image, markdown and HTML
 * alike, and never the bare `/api/image` the Inbox does not serve.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetImageSrcResolver, setImageSrcResolver } from '@plannotator/ui/components/ImageThumbnail';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { inboxImageSrcResolver, inboxMessageImageBase } from './images';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const Viewer = (hasDom ? (await import('@plannotator/ui/components/Viewer')).Viewer : null) as typeof import('@plannotator/ui/components/Viewer')['Viewer'];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetImageSrcResolver();
});

const ID = 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ';

test.skipIf(!hasDom)('a message image loads from /api/inbox/messages/<id>/image with the src as written', async () => {
  setImageSrcResolver(inboxImageSrcResolver);
  const body = [
    'The page after the fix:',
    '',
    '![after](.walkthrough/shots/after.png)',
    '',
    '<p><img src="/abs/shots/before.png" alt="before"></p>',
    '',
    '![remote](https://example.com/x.png)',
  ].join('\n');
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        blocks={parseMarkdownToBlocks(body, { frontmatter: false })}
        markdown={body}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        maxWidth={null}
        stickyActions={false}
        disableCodePathValidation
        imageBaseDir={inboxMessageImageBase(ID)}
        answerOnly
        readOnly
      />,
    );
  });
  const src = (alt: string) => host!.querySelector<HTMLImageElement>(`img[alt="${alt}"]`)?.getAttribute('src');
  expect(src('after')).toBe(`/api/inbox/messages/${ID}/image?path=${encodeURIComponent('.walkthrough/shots/after.png')}`);
  expect(src('before')).toBe(`/api/inbox/messages/${ID}/image?path=${encodeURIComponent('/abs/shots/before.png')}`);
  // Remote images keep their URL (the window's CSP does not load them).
  expect(src('remote')).toBe('https://example.com/x.png');
});

test('the resolver routes only a message marker; anything else keeps the default URL', () => {
  expect(inboxImageSrcResolver('a.png', inboxMessageImageBase(ID))).toBe(`/api/inbox/messages/${ID}/image?path=a.png`);
  expect(inboxImageSrcResolver('a.png', 'inbox-message:../../evil')).toBe('/api/image?path=a.png&base=inbox-message%3A..%2F..%2Fevil');
  expect(inboxImageSrcResolver('a.png')).toBe('/api/image?path=a.png');
});
