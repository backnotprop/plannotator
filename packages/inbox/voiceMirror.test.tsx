/**
 * What voice dictation paints in the composer's mirror layer, and that with voice off the field is exactly what it was.
 * The mirror stands behind a transparent textarea, so a character out of place there is text the person can't line up
 * with their cursor. Also the insert: it must reach the host's `onChange` without the browser's own insert (a phone
 * goes this way, so its keyboard stays down).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { ComposerTokenTextarea } = (hasDom ? await import('@plannotator/ui/components/ComposerTokenTextarea') : {}) as typeof import('@plannotator/ui/components/ComposerTokenTextarea');
const { InboxComposerField } = (hasDom ? await import('./components/ComposerField') : {}) as typeof import('./components/ComposerField');
const { VoiceFoot } = (hasDom ? await import('./components/VoiceMic') : {}) as typeof import('./components/VoiceMic');
const { VoiceSettings } = (hasDom ? await import('./components/VoiceSettings') : {}) as typeof import('./components/VoiceSettings');
const { adoptVoiceSettings, useVoiceSession } = (hasDom ? await import('./voice') : {}) as typeof import('./voice');
const { textareaField } = (hasDom ? await import('./voiceField') : {}) as typeof import('./voiceField');

type Paint = import('@plannotator/ui/components/ComposerTokenTextarea').ComposerMirrorPaint;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  adoptVoiceSettings(null);
});

function draw(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const mirror = (value: string, paint?: Paint) => {
  const drawn = draw(
    <ComposerTokenTextarea
      textareaRef={() => {}}
      value={value}
      onChange={() => {}}
      onKeyDown={() => {}}
      onSelectCaret={() => {}}
      placeholder=""
      sizeClassName=""
      skillReferences
      tokens={[]}
      mentionChips={null}
      listboxId="list"
      listboxOpen={false}
      mirrorPaint={paint}
    />,
  );
  return drawn.querySelector('[data-pn-mobile-editable-mirror]') as HTMLElement;
};

describe.skipIf(!hasDom)('the mirror', () => {
  test('no paint: plain text and nothing else', () => {
    const shown = mirror('Some words');
    expect(shown.textContent).toBe('Some words\n');
    expect(shown.children).toHaveLength(0);
  });

  test('the caret sits at its offset, mid-text, and adds no text', () => {
    const shown = mirror('Cards and more', { at: 6, node: <span data-paint="" /> });
    const paint = shown.querySelector('[data-paint]')!;
    expect(paint.previousSibling?.textContent).toBe('Cards ');
    expect(paint.nextSibling?.textContent).toBe('and more');
    expect(shown.textContent).toBe('Cards and more\n');
  });

  test('at the end, and in an empty box', () => {
    expect(mirror('Cards', { at: 5, node: <span data-paint="" /> }).querySelector('[data-paint]')!.previousSibling?.textContent).toBe('Cards');
    act(() => root?.unmount());
    expect(mirror('', { at: 0, node: <span data-paint="" /> }).querySelector('[data-paint]')).not.toBeNull();
  });

  test('the wash marks exactly the words, and the text around it stands', () => {
    const shown = mirror('Cards. Keep the totals. and more', { wash: { start: 7, end: 23, className: 'wash' } });
    expect(shown.querySelector('mark.wash')!.textContent).toBe('Keep the totals.');
    expect(shown.textContent).toBe('Cards. Keep the totals. and more\n');
  });
});

function Composer({ phone = false }: { phone?: boolean }) {
  const voice = useVoiceSession();
  const [value, setValue] = useState('');
  return (
    <div>
      <InboxComposerField value={value} onChange={setValue} placeholder="Write a reply" ariaLabel="Reply" destination="your reply" voice={voice} />
      <VoiceFoot voice={voice} phone={phone} />
    </div>
  );
}

describe.skipIf(!hasDom)('off', () => {
  test('no mic, no note, and the status is never asked', () => {
    const asked: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return Response.json({});
    }) as typeof fetch;
    try {
      const drawn = draw(<Composer />);
      expect(drawn.querySelector('[data-voice-mic]')).toBeNull();
      expect(drawn.querySelector('[data-voice-note]')).toBeNull();
      expect(asked.filter((url) => url.includes('/voice/'))).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe.skipIf(!hasDom)('Settings for a tailnet guest', () => {
  test('no switch and no key field, only why, and the status is never asked', () => {
    const asked: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return Response.json({});
    }) as typeof fetch;
    try {
      adoptVoiceSettings({ on: false, phones_only: false, engine: 'codex', key: { source: null, last4: null }, computer: 'the Mac', intro_due: false, guest: true });
      const drawn = draw(<VoiceSettings />);
      expect(drawn.querySelector('[role="switch"]')).toBeNull();
      expect(drawn.querySelector('input')).toBeNull();
      expect(drawn.textContent).toContain('only its owner');
      expect(asked).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe.skipIf(!hasDom)('the insert without the browser’s own', () => {
  test('reaches a controlled field’s onChange, at the cursor, with its spaces', () => {
    let seen = '';
    function Field() {
      const [value, setValue] = useState('Cards and more');
      return (
        <textarea
          value={value}
          onChange={(event) => {
            seen = event.target.value;
            setValue(event.target.value);
          }}
        />
      );
    }
    const drawn = draw(<Field />);
    const textarea = drawn.querySelector('textarea')!;
    textarea.setSelectionRange(5, 5);
    let place = { start: 0, end: 0 };
    act(() => {
      place = textareaField(textarea, () => true).insert('with totals');
    });
    expect(seen).toBe('Cards with totals and more');
    expect(place).toEqual({ start: 5, end: 17 });
  });
});
