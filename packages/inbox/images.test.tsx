/**
 * Images in a message (#1813): a message body drawn by ui's Viewer
 * the way the thread draws it (images based on the message) asks the Inbox's
 * per-message route for a relative or absolute image, markdown and HTML
 * alike, and never the bare `/api/image` the Inbox does not serve. A picture
 * from the web never loads in the window's own text ("Pages only", 2026-11-05):
 * the window's CSP allows web images for an attached HTML page, so the
 * renderers refuse them.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetImageSrcResolver, setImageSrcResolver } from '@plannotator/ui/components/ImageThumbnail';
import { ImageResolverContext } from '@plannotator/ui/components/ImageResolverContext';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { renderInlineMarkdown } from '@plannotator/guide-viewer/renderInlineMarkdown';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { InboxWebImagePolicy, inboxBodyImageResolver, inboxImageSrcResolver, inboxMarkdownImageBase, inboxMessageImageBase, isWebImageSrc, WEB_IMAGE_REFUSED } from './images';

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

/** Every URL an `<img>` or `<source>` in `host` would load. */
function loadedUrls(el: HTMLElement): string[] {
  const urls: string[] = [];
  for (const node of el.querySelectorAll('img, source')) {
    const src = node.getAttribute('src');
    if (src) urls.push(src);
    for (const part of (node.getAttribute('srcset') ?? '').split(',')) if (part.trim()) urls.push(part.trim().split(/\s+/)[0]!);
  }
  return urls;
}

const WEB = [
  '![remote](https://example.com/x.png)',
  '',
  '![protocol](//example.com/p.png)',
  '',
  '<p><img src="http://example.com/h.png" alt="raw"></p>',
  '',
  '<picture><source srcset="https://example.com/dark.png" media="(prefers-color-scheme: dark)"><img src="https://example.com/light.png" srcset="https://example.com/2x.png 2x" alt="picture"></picture>',
];

test.skipIf(!hasDom)('a message image loads from /api/inbox/messages/<id>/image with the src as written; a web picture loads nothing', async () => {
  setImageSrcResolver(inboxImageSrcResolver);
  const body = [
    'The page after the fix:',
    '',
    '![after](.walkthrough/shots/after.png)',
    '',
    '<p><img src="/abs/shots/before.png" alt="before"></p>',
    '',
    ...WEB,
  ].join('\n');
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      // As Thread.tsx draws a message body.
      <ImageResolverContext.Provider value={inboxBodyImageResolver(inboxMessageImageBase(ID))}>
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
        />
      </ImageResolverContext.Provider>,
    );
  });
  // (The markdown image is found by its src as written: with no server here it fails to load, and its alt moves to a chip.)
  expect(host!.querySelector('img[data-image-src=".walkthrough/shots/after.png"]')?.getAttribute('src')).toBe(`/api/inbox/messages/${ID}/image?path=${encodeURIComponent('.walkthrough/shots/after.png')}`);
  expect(host!.querySelector('img[alt="before"]')?.getAttribute('src')).toBe(`/api/inbox/messages/${ID}/image?path=${encodeURIComponent('/abs/shots/before.png')}`);
  // No web picture is asked for: not as a src, a srcset candidate or a <source>.
  expect(loadedUrls(host!).filter((url) => url.includes('example.com'))).toEqual([]);
  // Each is its alt text in a quiet chip.
  const chips = [...host!.querySelectorAll(`[data-image-unavailable][title="${WEB_IMAGE_REFUSED.title}"]`)].map((chip) => chip.textContent);
  expect(chips).toEqual(['remote', 'protocol', 'raw', 'picture']);
});

test.skipIf(!hasDom)('around the window, text drawn with no resolver of its own loads no web picture either: inline markdown and guides', async () => {
  setImageSrcResolver(inboxImageSrcResolver);
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <InboxWebImagePolicy>
        <p data-inline>
          <InlineMarkdown text="A card: ![badge](https://example.com/badge.png) and ![pixel](//example.com/t.gif)" />
        </p>
        <p data-guide>{renderInlineMarkdown('A guide: ![shot](https://example.com/shot.png)')}</p>
      </InboxWebImagePolicy>,
    );
  });
  expect(loadedUrls(host!)).toEqual([]);
  expect([...host!.querySelectorAll(`[data-inline] [data-image-unavailable][title="${WEB_IMAGE_REFUSED.title}"]`)].map((chip) => chip.textContent)).toEqual(['badge', 'pixel']);
  expect(host!.querySelector('[data-guide]')?.textContent).toBe('A guide: ');
});

test('a web picture is any http(s) or protocol-relative src, and the window resolver turns one into a URL that loads nothing', () => {
  for (const src of ['https://example.com/a.png', 'HTTP://example.com/a.png', 'https:example.com/a.png', '//example.com/a.png', '\\\\example.com/a.png', ' https://example.com/a.png']) {
    expect(isWebImageSrc(src)).toBe(true);
    expect(inboxImageSrcResolver(src, inboxMessageImageBase(ID))).toBe('data:,');
  }
  for (const src of ['a.png', '/abs/a.png', './https.png', 'data:image/png;base64,AA==', 'blob:http://localhost/1']) expect(isWebImageSrc(src)).toBe(false);
});

test('the resolver routes only a message or Markdown attachment marker; anything else keeps the default URL', () => {
  expect(inboxImageSrcResolver('a.png', inboxMessageImageBase(ID))).toBe(`/api/inbox/messages/${ID}/image?path=a.png`);
  // An image inside an attached Markdown file loads from that attachment's route, for the version on screen (#2228).
  expect(inboxImageSrcResolver('shots/a b.png', inboxMarkdownImageBase('att_01K7Z', 'sent'))).toBe('/api/inbox/attachments/att_01K7Z/markdown-image?path=shots%2Fa%20b.png&version=sent');
  // One in a Markdown file a link in it opened: that document's own images, named by its path in the folder (#2230).
  expect(inboxImageSrcResolver('../a.png', inboxMarkdownImageBase('att_01K7Z', 'current', 'sub/peer notes.md'))).toBe('/api/inbox/attachments/att_01K7Z/markdown-image?path=..%2Fa.png&version=current&document=sub%2Fpeer%20notes.md');
  expect(inboxImageSrcResolver('a.png', 'inbox-message:../../evil')).toBe('/api/image?path=a.png&base=inbox-message%3A..%2F..%2Fevil');
  expect(inboxImageSrcResolver('a.png')).toBe('/api/image?path=a.png');
});
