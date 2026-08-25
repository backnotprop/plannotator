/**
 * Regression coverage for the mount-scoped `/embed` picker.
 *
 * Requires DOM_TESTS=1 (happy-dom preload). Run:
 *   DOM_TESTS=1 bun test packages/ui/components/MarkdownEditor.embedPicker.test.ts
 */
import {
  CompletionContext,
  completionStatus,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  embedPicker,
  embedSlashItem,
  slashCommands,
  type EmbedPickerConfig,
  type EmbedTarget,
} from './MarkdownEditor';

const hasDom = typeof document !== 'undefined';
const REPORT: EmbedTarget = { kind: 'html', path: 'report.html', title: 'Report' };
const mountedViews: EditorView[] = [];

afterEach(() => {
  while (mountedViews.length > 0) {
    const view = mountedViews.pop();
    view?.destroy();
  }
});

function buildInsertLine(target: EmbedTarget): string {
  return `[${target.title ?? target.path}](${target.path}#embed)`;
}

function createView(doc: string, config: EmbedPickerConfig, includeSlashMenu = false): EditorView {
  const extensions = includeSlashMenu
    ? [slashCommands({ items: [embedSlashItem()] }), embedPicker(config)]
    : [embedPicker(config)];
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions,
  });
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state, parent });
  mountedViews.push(view);
  return view;
}

async function pickerResult(view: EditorView): Promise<CompletionResult | null> {
  const pos = view.state.selection.main.head;
  const sources = view.state.languageDataAt<CompletionSource>('autocomplete', pos);
  // `slashCommands()` may contribute the first source. The embed source is the
  // one whose completion range begins at the `/` for an `/embed` query.
  for (const source of sources) {
    const result = await source(new CompletionContext(view.state, pos, true, view));
    if (result?.filter === false) return result;
  }
  return null;
}

async function requirePickerResult(view: EditorView): Promise<CompletionResult> {
  const result = await pickerResult(view);
  if (result === null) throw new Error('Expected the embed picker to return completions');
  return result;
}

function requireOption(result: CompletionResult, label: string): Completion {
  const option = result.options.find((entry) => entry.label === label);
  if (option === undefined) throw new Error(`Expected completion option: ${label}`);
  return option;
}

function applyOption(view: EditorView, result: CompletionResult, option: Completion): void {
  if (typeof option.apply !== 'function') {
    throw new Error(`Expected ${option.label} to have an apply function`);
  }
  option.apply(
    view,
    option,
    result.from,
    result.to ?? view.state.selection.main.head,
  );
}

function hasSlashCommandIcon(
  completion: Completion,
): completion is Completion & { readonly slashCommandIcon: string } {
  return (
    'slashCommandIcon' in completion && typeof completion.slashCommandIcon === 'string'
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === null) throw new Error('Deferred promise was not initialized');
      resolvePromise(value);
    },
  };
}

async function settleUpload(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('embed picker: two-stage completion flow', () => {
  test.skipIf(!hasDom)('rewrites the static slash query and immediately reopens completion', async () => {
    const view = createView('/emb', { getTargets: () => [REPORT], buildInsertLine }, true);
    const item = embedSlashItem();
    if (item.apply === undefined) throw new Error('Expected Embed HTML to define apply');

    item.apply(view, { label: item.label }, 0, view.state.doc.length);
    await Promise.resolve();

    expect(view.state.doc.toString()).toBe('/embed ');
    expect(view.state.selection.main.head).toBe('/embed '.length);
    expect(completionStatus(view.state)).not.toBeNull();
  });

  test.skipIf(!hasDom)('does not answer an /embed query that starts after prose on a line', async () => {
    const view = createView('Prose /embed report', {
      getTargets: () => [REPORT],
      buildInsertLine,
    });
    expect(await pickerResult(view)).toBeNull();
  });
});

describe('embed picker: target rows and filtering', () => {
  test.skipIf(!hasDom)(
    'keeps multi-word title queries alive with filter false and matches title case-insensitively',
    async () => {
      const view = createView('/embed QUARTER PLAN', {
        getTargets: () => [
          { kind: 'html', path: 'reports/q1.html', title: 'Quarter Plan' },
          { kind: 'html', path: 'reports/q2.html', title: 'Roadmap' },
        ],
        buildInsertLine,
      });

      const result = await requirePickerResult(view);
      expect(result.filter).toBe(false);
      expect(result.options.map((option) => option.label)).toEqual(['Quarter Plan']);
    },
  );

  test.skipIf(!hasDom)('matches a query against target paths as well as titles', async () => {
    const view = createView('/embed LAUNCH-NOTES', {
      getTargets: () => [
        { kind: 'html', path: 'memos/launch-notes.html', title: 'Release brief' },
        REPORT,
      ],
      buildInsertLine,
    });

    const result = await requirePickerResult(view);
    expect(result.options.map((option) => option.label)).toEqual(['Release brief']);
  });

  test.skipIf(!hasDom)('reads target changes live without rebuilding the captured extension', async () => {
    let targets: readonly EmbedTarget[] = [];
    const view = createView('/embed ', {
      getTargets: () => targets,
      buildInsertLine,
    });
    expect((await requirePickerResult(view)).options.map((option) => option.label)).toEqual([
      'No HTML files in this workspace',
    ]);

    targets = [REPORT];
    expect((await requirePickerResult(view)).options.map((option) => option.label)).toEqual([
      'Report',
    ]);
  });

  test.skipIf(!hasDom)('inserts a picked target through the host builder and paragraph splice', async () => {
    const view = createView('Intro.\n/embed report', {
      getTargets: () => [REPORT],
      buildInsertLine,
    });
    const result = await requirePickerResult(view);
    applyOption(view, result, requireOption(result, 'Report'));

    expect(view.state.doc.toString()).toBe('Intro.\n\n[Report](report.html#embed)\n');
  });
});

describe('embed picker: empty states', () => {
  test.skipIf(!hasDom)('distinguishes no HTML targets from no query matches and clears either row', async () => {
    const noTargetsView = createView('/embed report', {
      getTargets: () => [],
      buildInsertLine,
    });
    const noTargets = await requirePickerResult(noTargetsView);
    // These labels are deliberate UX states from the design contract.
    const noTargetsRow = requireOption(noTargets, 'No HTML files in this workspace');
    applyOption(noTargetsView, noTargets, noTargetsRow);
    expect(noTargetsView.state.doc.toString()).toBe('');

    const noMatchesView = createView('/embed missing', {
      getTargets: () => [REPORT],
      buildInsertLine,
    });
    const noMatches = await requirePickerResult(noMatchesView);
    const noMatchesRow = requireOption(noMatches, 'No HTML files match “missing”');
    applyOption(noMatchesView, noMatches, noMatchesRow);
    expect(noMatchesView.state.doc.toString()).toBe('');
  });
});

describe('embed picker: upload row availability', () => {
  test.skipIf(!hasDom)('shows Upload HTML in populated and empty menus only when configured', async () => {
    const uploadTarget = async (): Promise<EmbedTarget | null> => null;
    const cases: ReadonlyArray<{
      readonly targets: readonly EmbedTarget[];
      readonly configured: boolean;
    }> = [
      { targets: [REPORT], configured: true },
      { targets: [], configured: true },
      { targets: [REPORT], configured: false },
      { targets: [], configured: false },
    ];

    for (const entry of cases) {
      const view = createView('/embed ', {
        getTargets: () => entry.targets,
        buildInsertLine,
        ...(entry.configured ? { uploadTarget } : {}),
      });
      const result = await requirePickerResult(view);
      // The explicit action label is part of the public picker contract.
      expect(result.options.some((option) => option.label === 'Upload HTML...')).toBe(
        entry.configured,
      );
    }
  });

  test.skipIf(!hasDom)('carries the package 16x16 icon on the ordinary upload completion', async () => {
    const view = createView('/embed ', {
      getTargets: () => [],
      buildInsertLine,
      uploadTarget: async () => null,
    });
    const result = await requirePickerResult(view);
    const uploadRow = requireOption(result, 'Upload HTML...');

    expect(hasSlashCommandIcon(uploadRow)).toBe(true);
    if (!hasSlashCommandIcon(uploadRow)) return;
    expect(uploadRow.slashCommandIcon).toContain('viewBox="0 0 16 16"');
    expect(uploadRow.slashCommandIcon).toContain('stroke-width="1.5"');
    expect(uploadRow.slashCommandIcon).toContain('stroke="currentColor"');
  });
});

describe('embed picker: upload lifecycle', () => {
  test.skipIf(!hasDom)('leaves the typed anchor visible, then inserts a resolved upload through the splice', async () => {
    const upload = deferred<EmbedTarget | null>();
    const view = createView('Intro.\n/embed report', {
      getTargets: () => [],
      buildInsertLine,
      uploadTarget: () => upload.promise,
    });
    const result = await requirePickerResult(view);
    applyOption(view, result, requireOption(result, 'Upload HTML...'));
    expect(view.state.doc.toString()).toBe('Intro.\n/embed report');

    upload.resolve(REPORT);
    await settleUpload();
    expect(view.state.doc.toString()).toBe('Intro.\n\n[Report](report.html#embed)\n');
  });

  test.skipIf(!hasDom)('leaves the typed command unchanged when upload is cancelled', async () => {
    const upload = deferred<EmbedTarget | null>();
    const view = createView('/embed report', {
      getTargets: () => [],
      buildInsertLine,
      uploadTarget: () => upload.promise,
    });
    const result = await requirePickerResult(view);
    applyOption(view, result, requireOption(result, 'Upload HTML...'));

    upload.resolve(null);
    await settleUpload();
    expect(view.state.doc.toString()).toBe('/embed report');
  });

  test.skipIf(!hasDom)('leaves the typed command unchanged when the host upload rejects', async () => {
    const view = createView('/embed report', {
      getTargets: () => [],
      buildInsertLine,
      uploadTarget: async () => {
        throw new Error('host surfaced upload failure');
      },
    });
    const result = await requirePickerResult(view);
    applyOption(view, result, requireOption(result, 'Upload HTML...'));

    await settleUpload();
    expect(view.state.doc.toString()).toBe('/embed report');
  });

  test.skipIf(!hasDom)('single-flights a pending upload and renders an inert Uploading row', async () => {
    const upload = deferred<EmbedTarget | null>();
    let calls = 0;
    const view = createView('/embed report', {
      getTargets: () => [],
      buildInsertLine,
      uploadTarget: () => {
        calls += 1;
        return upload.promise;
      },
    });
    const initial = await requirePickerResult(view);
    const uploadOption = requireOption(initial, 'Upload HTML...');
    applyOption(view, initial, uploadOption);

    const pending = await requirePickerResult(view);
    const uploadingOption = requireOption(pending, 'Uploading...');
    applyOption(view, pending, uploadingOption);
    // A stale copy of the original option is also unable to start a second call.
    applyOption(view, initial, uploadOption);
    expect(calls).toBe(1);

    upload.resolve(null);
    await settleUpload();
  });

  test.skipIf(!hasDom)('drops the resolved insert when the /embed anchor line was deleted', async () => {
    const upload = deferred<EmbedTarget | null>();
    const view = createView('Keep\n/embed report\nTail', {
      getTargets: () => [],
      buildInsertLine,
      uploadTarget: () => upload.promise,
    });
    const anchorFrom = view.state.doc.toString().indexOf('/embed');
    view.dispatch({ selection: { anchor: anchorFrom + '/embed report'.length } });
    const result = await requirePickerResult(view);
    applyOption(view, result, requireOption(result, 'Upload HTML...'));

    view.dispatch({ changes: { from: anchorFrom, to: anchorFrom + '/embed report'.length } });
    const editedBody = view.state.doc.toString();
    upload.resolve(REPORT);
    await settleUpload();

    expect(view.state.doc.toString()).toBe(editedBody);
  });

  test.skipIf(!hasDom)('maps the pending anchor when text is inserted above its line', async () => {
    const upload = deferred<EmbedTarget | null>();
    const view = createView('/embed report', {
      getTargets: () => [],
      buildInsertLine,
      uploadTarget: () => upload.promise,
    });
    const result = await requirePickerResult(view);
    applyOption(view, result, requireOption(result, 'Upload HTML...'));

    view.dispatch({ changes: { from: 0, insert: 'Intro\n' } });
    upload.resolve(REPORT);
    await settleUpload();

    expect(view.state.doc.toString()).toBe('Intro\n\n[Report](report.html#embed)\n');
  });
});

describe('embed picker: notice row', () => {
  test.skipIf(!hasDom)('renders a host notice when present and omits it when null', async () => {
    const notice = 'NOTICE_SENTINEL';
    const withNotice = createView('/embed report', {
      getTargets: () => [REPORT],
      buildInsertLine,
      getNotice: (body) => (body.includes('/embed') ? notice : null),
    });
    const withoutNotice = createView('/embed report', {
      getTargets: () => [REPORT],
      buildInsertLine,
      getNotice: () => null,
    });

    // Sentinel assertion: this guards conditional row presence, not host copy.
    expect((await requirePickerResult(withNotice)).options.some((row) => row.label === notice)).toBe(
      true,
    );
    expect(
      (await requirePickerResult(withoutNotice)).options.some((row) => row.label === notice),
    ).toBe(false);
  });
});
