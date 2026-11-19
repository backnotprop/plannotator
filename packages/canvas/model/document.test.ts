import { describe, expect, test } from 'bun:test';
import { checkObject, parseDocument, serializeDocument } from './codec';
import { isCustomColor, parseColor } from './color';
import { boundsOf, objectBounds, resolveArrow, selectionUnit } from './document';
import { HTML_ITEM_CSP, HTML_ITEM_MAX_LENGTH, HTML_ITEM_SANDBOX, htmlItemSrcdoc, isSafeImageSrc } from './html-item';
import { CANVAS_DOCUMENT_VERSION, type CanvasDocument } from './types';

const doc: CanvasDocument = {
  version: CANVAS_DOCUMENT_VERSION,
  id: 'board',
  title: 'Board',
  objects: {
    a: { id: 'a', type: 'box', x: 0, y: 0, w: 100, h: 40, text: 'A', group: 'g' },
    b: { id: 'b', type: 'box', x: 300, y: 0, w: 100, h: 40, text: 'B', group: 'g', color: { custom: '#c2410c' } },
    g: { id: 'g', type: 'group' },
    ab: { id: 'ab', type: 'arrow', from: { object: 'a' }, to: { object: 'b' } },
    lost: { id: 'lost', type: 'arrow', from: { object: 'a' }, to: { object: 'nowhere' } },
  },
  order: ['a', 'b', 'g', 'ab', 'lost'],
  snapshots: {
    s: {
      id: 's',
      title: 'Both',
      source: { kind: 'objects', objects: ['a', 'b'] },
      capture: { rect: { x: -24, y: -24, w: 448, h: 88 }, objects: [{ id: 'a', type: 'box', x: 0, y: 0, w: 100, h: 40, text: 'A as it was' }] },
    },
  },
};

/** The same document without the arrow that points at nothing: what a save may hold. */
const { lost: _lost, ...soundObjects } = doc.objects;
const sound: CanvasDocument = { ...doc, objects: soundObjects, order: doc.order.filter((id) => id !== 'lost') };

describe('reading a document', () => {
  test('an arrow between two objects runs edge to edge, not centre to centre', () => {
    expect(resolveArrow(doc, doc.objects.ab as never)).toEqual({ from: { x: 100, y: 20 }, to: { x: 300, y: 20 } });
  });

  test('an arrow whose end points at a missing object has no geometry and no bounds', () => {
    expect(resolveArrow(doc, doc.objects.lost as never)).toBeNull();
    expect(objectBounds(doc, 'lost')).toBeNull();
    expect(boundsOf(doc, ['lost', 'a'])).toEqual({ x: 0, y: 0, w: 100, h: 40 });
  });

  test('a group covers its members and is selected as one', () => {
    expect(objectBounds(doc, 'g')).toEqual({ x: 0, y: 0, w: 400, h: 40 });
    expect(selectionUnit(doc, 'a').sort()).toEqual(['a', 'b']);
    expect(selectionUnit(doc, 'ab')).toEqual(['ab']);
  });
});

describe('saving and loading', () => {
  test('a saved document loads back equal, and saving twice gives the same text', () => {
    const text = serializeDocument(sound);
    const loaded = parseDocument(text);
    expect(loaded.ok && loaded.value).toEqual(sound);
    expect(loaded.ok && serializeDocument(loaded.value)).toBe(text);
  });

  test('a document from a newer version is refused, not half-read', () => {
    const newer = parseDocument({ ...sound, version: CANVAS_DOCUMENT_VERSION + 1 });
    expect(newer.ok).toBe(false);
  });

  test('an arrow stuck to an object the file does not hold is refused', () => {
    expect(parseDocument(JSON.parse(JSON.stringify(doc))).ok).toBe(false);
  });

  test('order must hold every object exactly once', () => {
    expect(parseDocument({ ...sound, order: ['a', 'b', 'g'] }).ok).toBe(false);
    expect(parseDocument({ ...sound, order: ['a', 'a', 'b', 'g'] }).ok).toBe(false);
    expect(parseDocument({ ...sound, order: [...sound.order, 'ghost'] }).ok).toBe(false);
  });

  test('a snapshot keeps its capture through a save, and a capture is checked like any other objects', () => {
    const loaded = parseDocument(serializeDocument(sound));
    expect(loaded.ok && loaded.value.snapshots.s.capture.objects[0]).toMatchObject({ text: 'A as it was' });
    const hostile = { ...doc.snapshots.s, capture: { rect: doc.snapshots.s.capture.rect, objects: [{ id: 'p', type: 'image', x: 0, y: 0, w: 9, h: 9, src: 'javascript:1', alt: '' }] } };
    expect(parseDocument({ ...sound, snapshots: { s: hostile } }).ok).toBe(false);
    expect(parseDocument({ ...sound, snapshots: { s: { id: 's', title: '', source: doc.snapshots.s.source } } }).ok).toBe(false);
  });

  test('a field this version does not know is not carried through', () => {
    const loaded = parseDocument({ ...sound, objects: { ...sound.objects, a: { ...sound.objects.a, onclick: 'alert(1)', style: 'x' } } });
    expect(loaded.ok && Object.keys(loaded.value.objects.a).sort()).toEqual(['group', 'h', 'id', 'text', 'type', 'w', 'x', 'y']);
  });
});

describe('what an object may hold', () => {
  const placed = { id: 'x', x: 0, y: 0, w: 10, h: 10 };

  test('an unknown type, a bad id and a size of zero are refused', () => {
    expect(checkObject({ ...placed, type: 'script', text: '' }).ok).toBe(false);
    expect(checkObject({ ...placed, id: 'Has Space', type: 'note', text: '' }).ok).toBe(false);
    expect(checkObject({ ...placed, w: 0, type: 'note', text: '' }).ok).toBe(false);
    expect(checkObject({ ...placed, x: Number.NaN, type: 'note', text: '' }).ok).toBe(false);
  });

  test('a colour is a name or a plain CSS colour, never something that can load or run', () => {
    for (const good of ['#abc', '#A1B2C3D4', 'rgb(10 20 30 / 50%)', 'oklch(0.7 0.15 250)', 'hsl(120deg, 50%, 40%)']) expect(isCustomColor(good)).toBe(true);
    for (const bad of ['url(https://x.test/a.png)', 'var(--x)', 'red; background: url(x)', 'rgb(1 2 3); x', 'expression(alert(1))', '#12', 'blue']) {
      expect(isCustomColor(bad)).toBe(false);
    }
    expect(parseColor('blue')).toBe('blue');
    expect(parseColor({ custom: 'var(--x)' })).toBeNull();
    expect(checkObject({ ...placed, type: 'note', text: '', color: 'url(x)' }).ok).toBe(false);
  });

  test('a picture address is http(s), blob, an image data URL or a relative path', () => {
    for (const good of ['https://example.test/a.png', 'blob:https://example.test/1', 'data:image/png;base64,AAAA', 'data:image/svg+xml;charset=utf-8,%3Csvg%3E', 'shots/a.png']) {
      expect(isSafeImageSrc(good)).toBe(true);
    }
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'vbscript:x', '//example.test/a.png', '']) {
      expect(isSafeImageSrc(bad)).toBe(false);
    }
    expect(checkObject({ ...placed, type: 'image', src: 'javascript:alert(1)', alt: '' }).ok).toBe(false);
  });
});

describe('the sandbox contract for custom HTML', () => {
  test('the sandbox grants nothing: no scripts, no same origin, no navigation', () => {
    expect(HTML_ITEM_SANDBOX).toBe('');
  });

  test('the policy fetches nothing and allows no script', () => {
    const directives = Object.fromEntries(HTML_ITEM_CSP.split(';').map((part) => part.trim().split(/\s+(.*)/).slice(0, 2)));
    expect(directives['default-src']).toBe("'none'");
    expect(directives['script-src']).toBeUndefined();
    expect(directives['connect-src']).toBeUndefined();
    expect(directives['base-uri']).toBe("'none'");
    expect(directives['form-action']).toBe("'none'");
    // Nothing may be loaded from a network origin by any directive.
    expect(HTML_ITEM_CSP).not.toMatch(/https?:|\*|'unsafe-eval'|blob:/);
  });

  test('the policy comes before anything the item wrote', () => {
    const hostile = '<meta http-equiv="Content-Security-Policy" content="default-src *"><script>top.location="https://example.test"</script>';
    const page = htmlItemSrcdoc(hostile);
    expect(page.indexOf(HTML_ITEM_CSP)).toBeGreaterThan(-1);
    expect(page.indexOf(HTML_ITEM_CSP)).toBeLessThan(page.indexOf(hostile));
  });

  test('an item over the size limit is refused by the model and drawn as nothing', () => {
    const huge = 'x'.repeat(HTML_ITEM_MAX_LENGTH + 1);
    expect(checkObject({ id: 'h', type: 'html', x: 0, y: 0, w: 10, h: 10, html: huge }).ok).toBe(false);
    expect(htmlItemSrcdoc(huge)).not.toContain('xxxx');
  });
});
