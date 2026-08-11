/**
 * DOM-gated tests (DOM_TESTS=1) for the experimental edit-to-suggestion
 * affordance in FileHeader. Registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 *
 * Flag-off invariant: when the feature is off, AllFilesCodeView passes no
 * onEditFile, so FileHeader must render ZERO edit UI (byte-identical header).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileHeader } from './FileHeader';
import { EditSessionHud } from './EditSessionHud';
// Relative import: the ui package exposes './config' (no ./config/settings
// subpath), and the registry itself is not re-exported from the barrel.
import { SETTINGS } from '../../ui/config/settings';

const hasDom = typeof document !== 'undefined';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: React.ReactElement): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  return host;
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
});

describe('edit-to-suggestion flag', () => {
  test('the editSuggestions setting defaults OFF', () => {
    expect(SETTINGS.editSuggestions.defaultValue).toBe(false);
    // Cookie-only while experimental: never synced to server config.
    expect(SETTINGS.editSuggestions.serverKey).toBeUndefined();
  });
});

describe.if(hasDom)('FileHeader edit affordance (DOM)', () => {
  const baseProps = { filePath: 'src/calc.ts', patch: '@@ -1 +1 @@\n-a\n+b\n' };

  test('renders no edit UI when the feature is off (no onEditFile)', async () => {
    const el = await mount(<FileHeader {...baseProps} />);
    expect(el.querySelector('[data-testid="edit-session-start"]')).toBeNull();
    expect(el.querySelector('[data-testid="edit-session-badge"]')).toBeNull();
    expect(el.querySelector('[data-testid="edit-session-complete"]')).toBeNull();
    expect(el.querySelector('[data-testid="edit-session-cancel"]')).toBeNull();
  });

  test('renders the Edit entry button when enabled and idle', async () => {
    let started = 0;
    const el = await mount(<FileHeader {...baseProps} onEditFile={() => started++} />);
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="edit-session-start"]');
    expect(btn).not.toBeNull();
    await act(async () => btn!.click());
    expect(started).toBe(1);
    expect(el.querySelector('[data-testid="edit-session-badge"]')).toBeNull();
  });

  test('Edit entry renders at the far right of the action row, after other buttons', async () => {
    const el = await mount(
      <FileHeader
        {...baseProps}
        onEditFile={() => {}}
        onToggleViewed={() => {}}
        onFileComment={() => {}}
      />,
    );
    const editBtn = el.querySelector<HTMLButtonElement>('[data-testid="edit-session-start"]');
    expect(editBtn).not.toBeNull();
    const buttons = Array.from(el.querySelectorAll('button'));
    // Viewed and Comment precede Edit; only the OpenInApp file-actions
    // dropdown may follow it (Edit sits adjacent to the dropdown/chevron).
    const viewedBtn = buttons.find((b) => b.title.includes('viewed'));
    const commentBtn = buttons.find((b) => b.title === 'Add file-scoped comment');
    expect(viewedBtn).not.toBeUndefined();
    expect(commentBtn).not.toBeUndefined();
    for (const btn of [viewedBtn!, commentBtn!]) {
      expect(
        btn.compareDocumentPosition(editBtn!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    const after = buttons.slice(buttons.indexOf(editBtn!) + 1);
    for (const btn of after) {
      const label = btn.getAttribute('aria-label') ?? btn.title;
      expect(/open in|file actions|choose app/i.test(label)).toBe(true);
    }
  });

  test('disabled reason blocks entry and surfaces as tooltip', async () => {
    let started = 0;
    const el = await mount(
      <FileHeader
        {...baseProps}
        onEditFile={() => started++}
        editDisabledReason="Full file content unavailable"
      />,
    );
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="edit-session-start"]');
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
    expect(btn!.title).toBe('Full file content unavailable');
    await act(async () => btn!.click());
    expect(started).toBe(0);
  });

  test('editing state hides the entry button and renders NO session controls (the HUD owns them)', async () => {
    const el = await mount(<FileHeader {...baseProps} onEditFile={() => {}} isEditing />);
    expect(el.querySelector('[data-testid="edit-session-start"]')).toBeNull();
    expect(el.querySelector('[data-testid="edit-session-badge"]')).toBeNull();
    expect(el.querySelector('[data-testid="edit-session-complete"]')).toBeNull();
    expect(el.querySelector('[data-testid="edit-session-cancel"]')).toBeNull();
  });
});

describe.if(hasDom)('EditSessionHud (DOM)', () => {
  function makeStore(initial: number) {
    let count = initial;
    const listeners = new Set<() => void>();
    return {
      store: {
        subscribe: (cb: () => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        getSnapshot: () => count,
      },
      set(next: number) {
        count = next;
        listeners.forEach((cb) => cb());
      },
    };
  }

  test('renders session controls, dirty indicator, and the experimental label', async () => {
    let completed = 0;
    let cancelled = 0;
    const { store, set } = makeStore(0);
    const el = await mount(
      <EditSessionHud onComplete={() => completed++} onCancel={() => cancelled++} dirtyStore={store} />,
    );
    expect(el.querySelector('[data-testid="edit-session-hud"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="edit-session-badge"]')).not.toBeNull();
    expect(el.textContent).toContain('Experimental');
    expect(el.querySelector('[data-testid="edit-session-dirty"]')!.textContent).toBe('No changes yet');

    await act(async () => set(1));
    expect(el.querySelector('[data-testid="edit-session-dirty"]')!.textContent).toBe('1 change');
    await act(async () => set(3));
    expect(el.querySelector('[data-testid="edit-session-dirty"]')!.textContent).toBe('3 changes');

    const complete = el.querySelector<HTMLButtonElement>('[data-testid="edit-session-complete"]');
    const cancel = el.querySelector<HTMLButtonElement>('[data-testid="edit-session-cancel"]');
    expect(complete).not.toBeNull();
    expect(cancel).not.toBeNull();
    await act(async () => complete!.click());
    await act(async () => cancel!.click());
    expect(completed).toBe(1);
    expect(cancelled).toBe(1);
  });
});
