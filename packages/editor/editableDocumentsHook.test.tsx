import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import {
  useEditableDocuments,
  type EnabledSourceSaveCapability,
} from './editableDocuments';

const hasDom = typeof document !== 'undefined';

type EditableDocumentsApi = ReturnType<typeof useEditableDocuments>;

function sourceSave(hash: string, text: string): EnabledSourceSaveCapability {
  return {
    enabled: true,
    kind: 'local-text-file',
    scope: 'folder-file',
    path: '/repo/docs/a.md',
    basename: 'a.md',
    language: 'markdown',
    hash,
    mtimeMs: hash === 'sha256:a' ? 1000 : hash === 'sha256:b' ? 2000 : 3000,
    size: text.length,
    eol: 'lf',
  };
}

const KEY = 'file:/repo/docs/a.md';
const SOURCE_A = sourceSave('sha256:a', 'a\n');
const SOURCE_B = sourceSave('sha256:b', 'b\n');
const SOURCE_EXTERNAL = sourceSave('sha256:external', 'external\n');
const SOURCE_OVERWRITE = sourceSave('sha256:overwrite', 'local\n');

let roots: Root[] = [];
let containers: HTMLElement[] = [];

async function mountEditableDocuments(): Promise<{ current: () => EditableDocumentsApi; unmount: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);

  let latest: EditableDocumentsApi | null = null;
  function Harness() {
    latest = useEditableDocuments();
    return null;
  }

  await act(async () => {
    root.render(<Harness />);
  });

  return {
    current: () => {
      if (!latest) throw new Error('hook was not mounted');
      return latest;
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      roots = roots.filter((entry) => entry !== root);
      containers = containers.filter((entry) => entry !== container);
    },
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of containers.splice(0)) container.remove();
});

describe('useEditableDocuments conflict actions', () => {
  test.skipIf(!hasDom)('overwrite conflict records the diff from the latest disk version', async () => {
    const session = await mountEditableDocuments();

    await act(async () => {
      session.current().openDocument({ key: KEY, text: 'b\n', sourceSave: SOURCE_B });
      session.current().beginEdit('b\n');
      session.current().updateActiveText('local\n');
      session.current().reconcileDiskSnapshot({
        key: KEY,
        text: 'external\n',
        sourceSave: SOURCE_EXTERNAL,
      });
    });

    expect(session.current().getDocument(KEY)?.diskConflict?.sourceSave.hash).toBe('sha256:external');

    await act(async () => {
      session.current().markSaved({
        key: KEY,
        text: 'local\n',
        sourceSave: SOURCE_OVERWRITE,
        savedChangeBaseText: 'external\n',
        savedChangeBaseHash: 'sha256:external',
      });
    });

    const doc = session.current().getDocument(KEY);
    expect(doc?.diskConflict).toBeUndefined();
    expect(doc?.saveStatus).toBe('saved');
    expect(doc?.savedChange).toEqual({
      key: KEY,
      path: SOURCE_OVERWRITE.path,
      basename: SOURCE_OVERWRITE.basename,
      beforeText: 'external\n',
      afterText: 'local\n',
      beforeHash: 'sha256:external',
      afterHash: 'sha256:overwrite',
    });

    await session.unmount();
  });

  test.skipIf(!hasDom)('reload conflict discards the local buffer and adopts disk', async () => {
    const session = await mountEditableDocuments();

    await act(async () => {
      session.current().openDocument({ key: KEY, text: 'b\n', sourceSave: SOURCE_B });
      session.current().beginEdit('b\n');
      session.current().updateActiveText('local\n');
      session.current().reconcileDiskSnapshot({
        key: KEY,
        text: 'external\n',
        sourceSave: SOURCE_EXTERNAL,
      });
    });

    await act(async () => {
      session.current().reloadDiskConflict(KEY);
    });

    const doc = session.current().getDocument(KEY);
    expect(doc?.currentText).toBe('external\n');
    expect(doc?.diskBaseline).toBe('external\n');
    expect(doc?.sessionOpenText).toBe('external\n');
    expect(doc?.saveStatus).toBe('clean');
    expect(doc?.savedChange).toBeUndefined();
    expect(doc?.diskConflict).toBeUndefined();
    expect(session.current().getUnsavedDocuments()).toEqual([]);

    await session.unmount();
  });

  test.skipIf(!hasDom)('dirty saved-then-edited drafts keep saved context nested without duplicating it', async () => {
    const session = await mountEditableDocuments();

    await act(async () => {
      session.current().openDocument({ key: KEY, text: 'a\n', sourceSave: SOURCE_A });
      session.current().beginEdit('a\n');
      session.current().updateActiveText('b\n');
      session.current().markSaved({ key: KEY, text: 'b\n', sourceSave: SOURCE_B });
      session.current().updateActiveText('c\n');
    });

    expect(session.current().getDraftDocuments()).toEqual([{
      key: KEY,
      sourceSave: SOURCE_B,
      sessionOpenText: 'a\n',
      diskBaseline: 'b\n',
      currentText: 'c\n',
      savedChange: {
        key: KEY,
        path: SOURCE_B.path,
        basename: SOURCE_B.basename,
        beforeText: 'a\n',
        afterText: 'b\n',
        beforeHash: 'sha256:a',
        afterHash: 'sha256:b',
        sourceSave: SOURCE_B,
      },
    }]);
    expect(session.current().getDraftSavedFileChanges()).toEqual([]);

    await session.unmount();
  });
});
