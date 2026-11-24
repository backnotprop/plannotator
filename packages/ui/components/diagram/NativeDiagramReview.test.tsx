import { placeNativeNote } from './nativeNotePlacement';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderDiagram, type DiagramSpec } from '@plannotator/diagrams';
import { NativeDiagramReview, type NativeDiagramReviewProps, type NativeDiagramAnchor, type NativeDiagramAskContext } from './NativeDiagramReview';
import { partKey, placeCommentPins } from './nativeDiagramDrawing';
import { getRefCardTransport, setRefCardTransport } from '../../utils/refCard';

const file = { kind: 'file', title: 'Configuration', path: 'src/config.ts', start: 8, end: 12 } as const;
const link = { kind: 'link', title: 'Protocol', url: 'https://example.org/protocol' } as const;
const spec: DiagramSpec = {
  id: 'review', title: 'Service route', columns: [
    { id: 'client', title: 'Client', refs: [file, link], sections: [{ id: 'queue', title: 'Queue', content: 'Requests' }] },
    { id: 'server', title: 'Server', refs: [{ ...file, url: 'https://example.org/versions/a/src/config.ts' }] },
  ], groups: [{ id: 'cluster', label: 'Cluster', members: ['server'] }],
  links: [{ id: 'request', from: 'client', to: 'server', label: 'Request' }],
};
const source = JSON.stringify(spec);
const anchor: NativeDiagramAnchor = { kind: 'panel', id: 'client', title: 'Client', x: .25, y: .75 };

test('nearby comments remain reachable at every zoom and orphaned pins never land on a namesake of a different kind', async () => {
  const drawing = await renderDiagram(spec);
  const parts = new Map(drawing.parts.map(p => [partKey(p), p]));
  const comments = [
    { id: 'first', text: 'One', anchor }, { id: 'second', text: 'Two', anchor },
    { id: 'gone', text: 'Unresolved', anchor: { ...anchor, kind: 'section' as const } },
  ];
  for (const scale of [.1, 1, 3]) {
    const view = { x: 12, y: -2, scale };
    const pins = placeCommentPins(comments, parts, view);
    const part = parts.get(partKey(anchor))!;
    expect(pins.map(p => p.comment.id)).toEqual(['first', 'second']);
    expect(pins[0].x).toBeCloseTo(view.x + (part.x + .25 * part.w) * scale);
    expect(pins[0].y).toBeCloseTo(view.y + (part.y + .75 * part.h) * scale);
    expect(Math.abs(pins[1].x - pins[0].x)).toBeGreaterThanOrEqual(25);
  }
});

test('a saved note leaves clustered pins, zoom, Ask, and the historical-revision control reachable', () => {
  for (const [width, height, cardWidth] of [[1200, 700, 300], [390, 680, 374]] as const) {
    const pins = [0, 27, -27, 54].map(dx => ({ left: width / 2 + dx, top: 165, width: 32, height: 32 }));
    const boxes = [...pins, { left: 8, top: height - 54, width: 128, height: 46 },
      { left: width - 95, top: height - 54, width: 87, height: 46 }, { left: 8, top: 8, width: 110, height: 42 }];
    for (const pin of pins) {
      const note = placeNativeNote(pin, cardWidth, 96, width, height, boxes);
      expect(note.left).toBeGreaterThanOrEqual(8);
      expect(note.left + cardWidth).toBeLessThanOrEqual(width - 8);
      expect(note.top + 96).toBeLessThanOrEqual(height - 8);
      for (const box of boxes) {
        expect(note.left + cardWidth <= box.left || box.left + box.width <= note.left ||
          note.top + 96 <= box.top || box.top + box.height <= note.top).toBe(true);
      }
    }
  }
});

describe.if(typeof document !== 'undefined')('native diagram review', () => {
  let root: Root;
  let host: HTMLElement;
  afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); });
  async function show(props: Partial<NativeDiagramReviewProps> = {}) {
    if (!host?.isConnected) {
      host = document.createElement('div'); document.body.appendChild(host);
      root = createRoot(host);
    }
    await act(async () => { root.render(<NativeDiagramReview source={source} {...props} />); });
  }
  function button(text: string) {
    const found = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === text || b.textContent === text);
    if (!found) throw new Error(`Missing button "${text}" in ${host.textContent}`);
    return found;
  }
  async function click(text: string) { await act(async () => button(text).click()); }
  async function type(text: string) {
    const input = host.querySelector('textarea')!;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
  }
  function pointer(type: string, target: Element, x: number, y: number) {
    target.dispatchEvent(new PointerEvent(type, { pointerId: 5, pointerType: 'mouse', clientX: x, clientY: y, bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
  }

  test('dragging a part pans; a click there pins its real metadata. Comment replaces the card and reopens on the saved pin', async () => {
    const saved: { anchor: NativeDiagramAnchor; text: string }[] = [];
    const opened: typeof file[] = [];
    const props = { onCreateComment: (a: NativeDiagramAnchor, text: string) => { saved.push({ anchor: a, text }); }, onOpenFile: (ref: typeof file) => { opened.push(ref); } };
    await show(props);
    const hit = host.querySelector('[data-native-hit="'+button('panel Client').dataset.nativeFocus+'"]')!;
    hit.getBoundingClientRect = () => new DOMRect(100, 50, 400, 200);
    await act(async () => { pointer('pointerdown', hit, 195, 190); pointer('pointermove', hit, 214, 198); pointer('pointerup', hit, 214, 198); });
    expect(host.querySelector('[role=dialog]')).toBeNull();
    await act(async () => { pointer('pointerdown', hit, 200, 200); pointer('pointerup', hit, 200, 200); });
    expect(host.textContent).toContain('Lines 8–12');
    await click('Open file'); expect(opened).toEqual([file]);
    await click('Protocol'); expect(host.querySelector('a')?.href).toBe(link.url);
    await click('Comment');
    expect(host.querySelector('[role=dialog]')?.textContent).not.toContain('Protocol');
    expect(host.querySelector('textarea')?.closest('form')).toBeNull();
    await type('Rename this part'); await click('Add comment');
    expect(saved).toEqual([{ anchor, text: 'Rename this part' }]);
    expect(host.querySelector('textarea')).toBeNull();
    let edited = '';
    await show({ ...props, comments: [{ id: 'annotation', ...saved[0] }], onEditComment: (id, text) => { edited = id + text; } });
    expect(document.activeElement).toBe(button('Comment 1 on Client'));
    await click('Comment 1 on Client');
    expect(host.querySelector('[role=dialog]')?.textContent).toContain('Rename this part');
    await click('Edit'); await type('New label'); await click('Save');
    expect(edited).toBe('annotationNew label');
  });

  test('a rejected or failed delete keeps the saved note available to retry', async () => {
    const ids: string[] = [];
    await show({ comments: [{ id: 'saved', anchor, text: 'Keep this note' }], onEditComment: () => {},
      onDeleteComment: async id => {
        ids.push(id);
        if (ids.length === 1) return false;
        throw new Error('offline');
      } });
    await click('Comment 1 on Client');
    await click('Delete');
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Try again');
    expect(host.querySelector('[role=dialog]')?.textContent).toContain('Keep this note');
    await click('Delete');
    expect(ids).toEqual(['saved', 'saved']);
    expect(button('Edit').disabled).toBe(false);
    expect(button('Comment 1 on Client')).toBeDefined();
  });

  test('repaints the image when a scoped palette changes and retains the camera, pin, and editor', async () => {
    const revoke = spyOn(URL, 'revokeObjectURL');
    try {
      await show({ comments: [{ id: 'existing', anchor, text: 'Saved' }], onCreateComment: () => {} });
      const image = host.querySelector('[data-diagram-svg] image')!;
      const currentUrl = () => image.getAttribute('href');
      const oldUrl = currentUrl()!;
      await click('Zoom in');
      await click('panel Client');
      await click('Comment');
      await type('Unsaved review');
      const wrapper = host.querySelector<HTMLElement>('[data-diagram-svg]')!;
      const transform = wrapper.style.transform;
      const input = host.querySelector('textarea')!;
      const pin = button('Comment 1 on Client');
      const position = pin.getAttribute('style');
      const surface = host.querySelector<HTMLElement>('.ndr')!;
      await act(async () => {
        surface.style.setProperty('--background', '#101820');
        surface.style.setProperty('--foreground', '#eaf0fa');
        surface.style.setProperty('--primary', '#80aaff');
        for (let i = 0; i < 30 && currentUrl() === oldUrl; i++) await new Promise(resolve => setTimeout(resolve, 5));
      });
      expect(currentUrl()).not.toBe(oldUrl);
      expect(revoke).toHaveBeenCalledWith(oldUrl);
      expect(host.querySelector('[data-diagram-svg] image')).toBe(image);
      expect(wrapper.style.transform).toBe(transform);
      expect(button('Comment 1 on Client')).toBe(pin);
      expect(pin.getAttribute('style')).toBe(position);
      expect(host.querySelector('textarea')).toBe(input);
      expect(input.value).toBe('Unsaved review');
      const newUrl = currentUrl()!;
      await show({ source: '{' });
      expect(revoke).toHaveBeenCalledWith(newUrl);
      expect(host.querySelector('[role=alert]')?.textContent).toContain('Couldn’t draw the diagram');
    } finally { revoke.mockRestore(); }
  });

  test('a failed palette can retry and a superseded decode cannot replace the visible image', async () => {
    const revoke = spyOn(URL, 'revokeObjectURL');
    const decode = spyOn(HTMLImageElement.prototype, 'decode');
    async function until(check: () => boolean) {
      for (let i = 0; i < 40 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(check()).toBe(true);
    }
    try {
      await show();
      const surface = host.querySelector<HTMLElement>('.ndr')!;
      const image = surface.querySelector('image')!;
      const current = () => image.getAttribute('href');
      const first = current();
      let failed = '';
      decode.mockImplementationOnce(function (this: HTMLImageElement) {
        failed = this.src;
        return Promise.reject(new Error('Could not decode'));
      });
      await act(async () => {
        surface.style.setProperty('--background', '#101820');
        surface.style.setProperty('--foreground', '#eaf0fa');
        await until(() => failed !== '' && revoke.mock.calls.some(([url]) => url === failed));
      });
      expect(current()).toBe(first);
      const captures: string[] = [];
      let complete = () => {};
      decode.mockImplementation(function (this: HTMLImageElement) {
        captures.push(this.src);
        return new Promise<void>(resolve => { complete = resolve; });
      });
      await act(async () => {
        surface.classList.add('retry');
        await until(() => captures.length === 1);
      });
      const finishOlder = complete;
      expect(current()).toBe(first);
      await act(async () => {
        surface.style.setProperty('--background', '#172331');
        surface.style.setProperty('--background', '#26354a');
        await until(() => captures.length === 2);
        complete();
        await until(() => current() === captures[1]);
        finishOlder();
      });
      expect(current()).toBe(captures[1]!);
      expect(revoke).toHaveBeenCalledWith(captures[0]!);
      expect(revoke).toHaveBeenCalledWith(first!);
      await act(async () => {
        surface.style.setProperty('--background', '#28425b');
        await until(() => captures.length === 3);
      });
      const finishUnmounted = complete;
      await show({ source: '{' });
      expect(revoke).toHaveBeenCalledWith(captures[1]!);
      expect(revoke).toHaveBeenCalledWith(captures[2]!);
      await act(async () => { finishUnmounted(); });
      expect(host.querySelector('image')).toBeNull();
    } finally {
      decode.mockRestore();
      revoke.mockRestore();
    }
  });

  test('a native host composer takes the selected part without drawing a second editor', async () => {
    let request: NativeDiagramAnchor | undefined;
    await show({ onRequestComment: a => { request = a; } });
    await click('section Queue');
    await click('Comment');
    expect(request).toMatchObject({ kind: 'section', id: 'queue', title: 'Queue' });
    expect(host.querySelector('.ndr-card')).toBeNull();
  });

  test('scoped Ask AI carries both link endpoints; a failed dispatch keeps the question for retry', async () => {
    const asks: NativeDiagramAskContext[] = [];
    await show({ onAskAI: ctx => { asks.push(ctx); return asks.length > 1; } });
    await click('link Request');
    const dialog = host.querySelector('[role=dialog]')!;
    await act(async () => [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Ask AI')!.click());
    await type('What happens on a timeout?'); await click('Send question');
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Try again');
    expect(host.querySelector('textarea')?.value).toBe('What happens on a timeout?');
    await click('Send question');
    expect(asks[1]).toMatchObject({ assetId: 'review', question: 'What happens on a timeout?', part: { id: 'request', from: 'client', to: 'server' } });
    expect(host.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('Request');
  });

  test('the thread destination is explicit and a rejected or failed delivery preserves the question', async () => {
    const asks: NativeDiagramAskContext[] = [];
    await show({ askDestination: 'thread', onAskAI: async ctx => {
      asks.push(ctx);
      if (asks.length === 1) return false;
      if (asks.length === 2) throw new Error('offline');
    } });
    await click('Ask AI');
    expect(host.querySelector('[role=dialog]')?.textContent).not.toContain('Replies appear in this thread.');
    const question = 'Can the owner confirm this route?';
    await type(question);
    for (let attempt = 0; attempt < 2; attempt++) {
      await click('Send question to thread');
      expect(host.querySelector('[role=alert]')?.textContent).toContain('Try again');
      expect(host.querySelector('textarea')?.value).toBe(question);
    }
    await click('Send question to thread');
    expect(host.querySelector('textarea')).toBeNull();
    expect(asks.map(ctx => ctx.question)).toEqual([question, question, question]);
  });

  test('an unavailable provider leaves the authored link usable; an invalid edit reports the existing pin unresolved', async () => {
    const previous = getRefCardTransport();
    const url = 'https://github.com/example/project/pull/42';
    try {
      setRefCardTransport(async () => ({ ok: false, error: 'signed_out', fetchedAt: Date.now() }));
      let found: boolean | undefined;
      const props = { comments: [{ id: 'placed', text: 'Check this', anchor }], onResolutionChange: (m: ReadonlyMap<string, boolean>) => { found = m.get('placed'); } };
      await show({ ...props, source: JSON.stringify({ title: 'Review', columns: [{ id: 'client', title: 'Client', refs: [{ kind: 'link', title: 'Proposed fix', url }] }] }) });
      await click('panel Client');
      expect(host.querySelector('.ndr-references')?.textContent).toContain('Proposed fix');
      expect(host.querySelector('.ndr-references a')?.getAttribute('href')).toBe(url);
      expect(host.querySelector('.ndr-references code')).toBeNull();
      expect(found).toBe(true);
      await show({ ...props, source: '{' });
      expect(found).toBe(false);
    } finally {
      setRefCardTransport(previous);
    }
  });

  test('keyboard targets cover every kind; a revision permalink opens the exact file and unavailable parts stay unresolved', async () => {
    let resolution = new Map<string, boolean>();
    await show({ onOpenFile: () => { throw new Error('Unversioned file opened'); },
      comments: [{ id: 'removed', text: 'Still here', anchor: { ...anchor, id: 'removed' } }],
      onResolutionChange: m => { resolution = new Map(m); } });
    expect(resolution.get('removed')).toBe(false);
    expect(host.querySelectorAll('[data-native-focus]').length).toBe(5);
    await click('panel Server');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.org/versions/a/src/config.ts');
    expect(host.querySelector('[data-diagram-svg] image')?.getAttribute('href')).toMatch(/^blob:/);
    expect(host.querySelector('[data-diagram-svg] [data-panel]')).toBeNull();
    await show({ source: '{' });
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Couldn’t draw the diagram');
    expect(host.querySelector('[data-native-focus]')).toBeNull();
  });
});
