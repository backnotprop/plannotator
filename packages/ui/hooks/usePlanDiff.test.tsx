import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { usePlanDiff, type PlanDiffFetchers, type UsePlanDiffReturn, type VersionInfo } from './usePlanDiff';

// usePlanDiff had no test coverage before this feature. These cover the
// per-document seam added for annotate folder sessions: the `docKey` reset
// (so switching documents doesn't inherit the previous document's diff
// base), that a stable docKey survives a reconcile-style text update without
// losing its baseline, and that per-document `fetchers` are actually used
// instead of the bare-endpoint defaults.

const hasDom = typeof document !== 'undefined';

interface HarnessProps {
  currentPlan: string;
  initialPreviousPlan: string | null;
  versionInfo: VersionInfo | null;
  fetchers?: PlanDiffFetchers;
  docKey?: string | null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

// A stable component identity is required across mount + update renders —
// re-declaring the component function per call (as react-dom would treat as
// a type change) would remount the hook and lose its state instead of
// re-rendering it, defeating the point of these tests.
function HarnessHolder(props: HarnessProps & { onLatest?: (v: UsePlanDiffReturn) => void }) {
  const v = usePlanDiff(props.currentPlan, props.initialPreviousPlan, props.versionInfo, props.fetchers, props.docKey);
  props.onLatest?.(v);
  return null;
}

async function mountHolder(props: HarnessProps): Promise<{ current: () => UsePlanDiffReturn; update: (p: HarnessProps) => Promise<void> }> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  let latest: UsePlanDiffReturn | null = null;

  const render = async (p: HarnessProps) => {
    await act(async () => {
      root!.render(<HarnessHolder {...p} onLatest={(v) => { latest = v; }} />);
    });
  };

  await render(props);

  return {
    current: () => {
      if (!latest) throw new Error('hook was not mounted');
      return latest;
    },
    update: render,
  };
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  host?.remove();
  host = null;
});

describe('usePlanDiff — per-document docKey reset', () => {
  test.skipIf(!hasDom)('switching docKey resets diff-base state to the new document\'s own baseline', async () => {
    const versionInfoA: VersionInfo = { version: 2, totalVersions: 2, project: 'demo' };
    const session = await mountHolder({
      currentPlan: 'doc A v2 text',
      initialPreviousPlan: 'doc A v1 text',
      versionInfo: versionInfoA,
      docKey: 'docA',
    });

    expect(session.current().diffBasePlan).toBe('doc A v1 text');
    expect(session.current().diffBaseVersion).toBe(1);
    expect(session.current().hasPreviousVersion).toBe(true);

    // Switch to a different document with no history at all.
    await session.update({
      currentPlan: 'doc B text',
      initialPreviousPlan: null,
      versionInfo: null,
      docKey: 'docB',
    });

    expect(session.current().diffBasePlan).toBeNull();
    expect(session.current().diffBaseVersion).toBeNull();
    expect(session.current().hasPreviousVersion).toBe(false);
    expect(session.current().versions).toEqual([]);
  });

  test.skipIf(!hasDom)('switching docKey picks up the new document\'s own previousPlan, not the old one', async () => {
    const versionInfoA: VersionInfo = { version: 2, totalVersions: 2, project: 'demo' };
    const versionInfoB: VersionInfo = { version: 3, totalVersions: 3, project: 'demo' };
    const session = await mountHolder({
      currentPlan: 'doc A text',
      initialPreviousPlan: 'doc A previous',
      versionInfo: versionInfoA,
      docKey: 'docA',
    });
    expect(session.current().diffBasePlan).toBe('doc A previous');

    await session.update({
      currentPlan: 'doc B text',
      initialPreviousPlan: 'doc B previous',
      versionInfo: versionInfoB,
      docKey: 'docB',
    });

    expect(session.current().diffBasePlan).toBe('doc B previous');
    expect(session.current().diffBaseVersion).toBe(2);
  });

  test.skipIf(!hasDom)('an undefined/stable docKey (the root document) keeps today\'s one-time-hydration behavior', async () => {
    // The root document (single-file annotate, plan, review) never passes a
    // docKey — this reproduces its call shape exactly.
    const session = await mountHolder({
      currentPlan: 'root plan text',
      initialPreviousPlan: null,
      versionInfo: null,
    });
    expect(session.current().diffBasePlan).toBeNull();

    // /api/plan resolves asynchronously after mount and previousPlan/versionInfo
    // arrive — the one-time sync effect should hydrate diffBasePlan.
    const versionInfo: VersionInfo = { version: 2, totalVersions: 2, project: 'demo' };
    await session.update({
      currentPlan: 'root plan text',
      initialPreviousPlan: 'root previous plan',
      versionInfo,
    });
    expect(session.current().diffBasePlan).toBe('root previous plan');

    // A later change to initialPreviousPlan must NOT overwrite an
    // already-hydrated diffBasePlan — this is the pre-existing "only sync
    // once" behavior the docKey seam must not disturb for the root document.
    await session.update({
      currentPlan: 'root plan text',
      initialPreviousPlan: 'a different previous plan',
      versionInfo,
    });
    expect(session.current().diffBasePlan).toBe('root previous plan');
  });
});

describe('usePlanDiff — per-docKey base-selection memory', () => {
  test.skipIf(!hasDom)('a manually-selected base version survives a detour to another document and back', async () => {
    const rootVersionInfo: VersionInfo = { version: 3, totalVersions: 3, project: 'demo' };
    const docAVersionInfo: VersionInfo = { version: 5, totalVersions: 5, project: 'demo' };
    const fetchers: PlanDiffFetchers = {
      fetchVersion: async (version) => ({ plan: `fetched plan v${version}`, version }),
    };

    const session = await mountHolder({
      currentPlan: 'root current text',
      initialPreviousPlan: 'root v2 text',
      versionInfo: rootVersionInfo,
      docKey: null,
      fetchers,
    });

    // Sanity: the auto-selected default base is version - 1 (v2), not v1.
    expect(session.current().diffBaseVersion).toBe(2);
    expect(session.current().diffBasePlan).toBe('root v2 text');

    // User manually picks an earlier, non-default version via the injected fetcher.
    await act(async () => {
      await session.current().selectBaseVersion(1);
    });
    expect(session.current().diffBaseVersion).toBe(1);
    expect(session.current().diffBasePlan).toBe('fetched plan v1');

    // Detour: navigate to a different document (e.g. a linked doc opened
    // from root). Its own default base applies — nothing carries over.
    await session.update({
      currentPlan: 'docA current text',
      initialPreviousPlan: 'docA previous text',
      versionInfo: docAVersionInfo,
      docKey: 'docA',
      fetchers,
    });
    expect(session.current().diffBaseVersion).toBe(4);
    expect(session.current().diffBasePlan).toBe('docA previous text');

    // Navigate back to root (docKey null) with the same original props.
    await session.update({
      currentPlan: 'root current text',
      initialPreviousPlan: 'root v2 text',
      versionInfo: rootVersionInfo,
      docKey: null,
      fetchers,
    });

    // The manual selection from before the detour is restored — NOT the
    // auto-computed default (v2) that a plain reset would re-seed.
    expect(session.current().diffBaseVersion).toBe(1);
    expect(session.current().diffBasePlan).toBe('fetched plan v1');
  });

  test.skipIf(!hasDom)('distinct docKeys keep independent base selections — no leakage between them', async () => {
    const versionInfoA: VersionInfo = { version: 3, totalVersions: 3, project: 'demo' };
    const versionInfoB: VersionInfo = { version: 4, totalVersions: 4, project: 'demo' };
    const fetchers: PlanDiffFetchers = {
      fetchVersion: async (version) => ({ plan: `fetched plan v${version}`, version }),
    };

    const session = await mountHolder({
      currentPlan: 'docA current',
      initialPreviousPlan: 'docA previous',
      versionInfo: versionInfoA,
      docKey: 'docA',
      fetchers,
    });
    await act(async () => {
      await session.current().selectBaseVersion(1);
    });
    expect(session.current().diffBaseVersion).toBe(1);
    expect(session.current().diffBasePlan).toBe('fetched plan v1');

    await session.update({
      currentPlan: 'docB current',
      initialPreviousPlan: 'docB previous',
      versionInfo: versionInfoB,
      docKey: 'docB',
      fetchers,
    });
    await act(async () => {
      await session.current().selectBaseVersion(2);
    });
    expect(session.current().diffBaseVersion).toBe(2);
    expect(session.current().diffBasePlan).toBe('fetched plan v2');

    // Back to docA: its own selection (v1) — not docB's (v2).
    await session.update({
      currentPlan: 'docA current',
      initialPreviousPlan: 'docA previous',
      versionInfo: versionInfoA,
      docKey: 'docA',
      fetchers,
    });
    expect(session.current().diffBaseVersion).toBe(1);
    expect(session.current().diffBasePlan).toBe('fetched plan v1');

    // Back to docB: its own selection (v2) — confirms docA's visit above
    // didn't clobber it either.
    await session.update({
      currentPlan: 'docB current',
      initialPreviousPlan: 'docB previous',
      versionInfo: versionInfoB,
      docKey: 'docB',
      fetchers,
    });
    expect(session.current().diffBaseVersion).toBe(2);
    expect(session.current().diffBasePlan).toBe('fetched plan v2');
  });
});

describe('usePlanDiff — baseline survives a live-reload-style text update', () => {
  test.skipIf(!hasDom)('a currentPlan change with a stable docKey recomputes the diff without losing diffBasePlan', async () => {
    const versionInfoA: VersionInfo = { version: 2, totalVersions: 2, project: 'demo' };
    const session = await mountHolder({
      currentPlan: '# Doc\n\noriginal text\n',
      initialPreviousPlan: '# Doc\n\nprevious text\n',
      versionInfo: versionInfoA,
      docKey: 'docA',
    });

    expect(session.current().diffBasePlan).toBe('# Doc\n\nprevious text\n');
    const firstStats = session.current().diffStats;
    expect(firstStats).not.toBeNull();

    // Simulate a reconcile-triggered disk update: only currentPlan changes,
    // docKey (the active document's identity) stays the same.
    await session.update({
      currentPlan: '# Doc\n\nreloaded text from disk\n',
      initialPreviousPlan: '# Doc\n\nprevious text\n',
      versionInfo: versionInfoA,
      docKey: 'docA',
    });

    // Baseline is unchanged — the diff is still against the ORIGINAL previous
    // version, not reset just because the current text moved.
    expect(session.current().diffBasePlan).toBe('# Doc\n\nprevious text\n');
    // But the diff itself recomputed against the new current text.
    expect(session.current().diffBlocks).not.toBeNull();
    const blocks = session.current().diffBlocks!;
    const hasReloadedText = blocks.some((b) =>
      (b.content ?? '').includes('reloaded text from disk')
    );
    expect(hasReloadedText).toBe(true);
  });
});

describe('usePlanDiff — per-document fetchers', () => {
  test.skipIf(!hasDom)('selectBaseVersion uses the provided fetchVersion instead of the bare-endpoint default', async () => {
    let calledWith: number | null = null;
    const fetchers: PlanDiffFetchers = {
      fetchVersion: async (version) => {
        calledWith = version;
        return { plan: 'fetched via custom fetcher', version };
      },
    };
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async () => {
        throw new Error('default fetch should not be called when a per-document fetcher is supplied');
      },
    });

    try {
      const session = await mountHolder({
        currentPlan: 'current',
        initialPreviousPlan: 'previous',
        versionInfo: { version: 2, totalVersions: 2, project: 'demo' },
        docKey: 'docA',
        fetchers,
      });

      await act(async () => {
        await session.current().selectBaseVersion(1);
      });

      expect(calledWith).toBe(1);
      expect(session.current().diffBasePlan).toBe('fetched via custom fetcher');
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
  });

  test.skipIf(!hasDom)('fetchVersions uses the provided fetcher instead of the bare-endpoint default', async () => {
    const fetchers: PlanDiffFetchers = {
      fetchVersions: async () => ({
        project: 'demo',
        slug: 'annotate-docA',
        versions: [
          { version: 1, timestamp: '2026-01-01T00:00:00.000Z' },
          { version: 2, timestamp: '2026-01-02T00:00:00.000Z' },
        ],
      }),
    };
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async () => {
        throw new Error('default fetch should not be called when a per-document fetcher is supplied');
      },
    });

    try {
      const session = await mountHolder({
        currentPlan: 'current',
        initialPreviousPlan: 'previous',
        versionInfo: { version: 2, totalVersions: 2, project: 'demo' },
        docKey: 'docA',
        fetchers,
      });

      await act(async () => {
        await session.current().fetchVersions();
      });

      expect(session.current().versions).toEqual([
        { version: 1, timestamp: '2026-01-01T00:00:00.000Z' },
        { version: 2, timestamp: '2026-01-02T00:00:00.000Z' },
      ]);
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
  });
});
