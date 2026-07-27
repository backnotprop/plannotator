/**
 * usePlanDiffViewAutoExit + usePlanDiff integration (DOM_TESTS=1)
 *
 * Mirrors App.tsx's wiring: the diff-view active flag lives in the harness
 * (like App's isPlanDiffActive state), usePlanDiff tracks the active
 * document via docKey, and usePlanDiffViewAutoExit exits diff view when the
 * newly active document carries no baseline — the annotate-folder "diff view
 * stuck on after opening a history-less file" quirk. Also pins that a switch
 * to a baseline-carrying document does NOT exit, and that the HTML-surface
 * gate (active passed as false) suppresses the auto-exit entirely.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePlanDiff, type VersionInfo } from '@plannotator/ui/hooks/usePlanDiff';
import { usePlanDiffViewAutoExit } from './hooks/usePlanDiffViewAutoExit';

const hasDom = typeof document !== 'undefined';

interface DocState {
  key: string;
  markdown: string;
  previousPlan: string | null;
  versionInfo: VersionInfo | null;
}

interface HarnessApi {
  isPlanDiffActive: boolean;
  hasPreviousVersion: boolean;
  activate: () => void;
  switchDoc: (doc: DocState) => void;
}

const DOC_WITH_BASELINE: DocState = {
  key: '/tmp/a.md',
  markdown: 'A v2\n',
  previousPlan: 'A v1\n',
  versionInfo: { version: 2, totalVersions: 2, project: 'test' },
};

const DOC_WITHOUT_BASELINE: DocState = {
  key: '/tmp/b.md',
  markdown: 'B fresh\n',
  previousPlan: null,
  versionInfo: null,
};

const SECOND_DOC_WITH_BASELINE: DocState = {
  key: '/tmp/c.md',
  markdown: 'C v3\n',
  previousPlan: 'C v2\n',
  versionInfo: { version: 3, totalVersions: 3, project: 'test' },
};

let roots: Root[] = [];
let containers: HTMLElement[] = [];

function Harness({
  apiRef,
  htmlSurface = false,
}: {
  apiRef: { current: HarnessApi | null };
  htmlSurface?: boolean;
}) {
  const [doc, setDoc] = useState<DocState>(DOC_WITH_BASELINE);
  const [isPlanDiffActive, setIsPlanDiffActive] = useState(false);

  const planDiff = usePlanDiff(
    doc.markdown,
    htmlSurface ? null : doc.previousPlan,
    htmlSurface ? null : doc.versionInfo,
    undefined,
    doc.key,
  );

  usePlanDiffViewAutoExit(
    isPlanDiffActive && !htmlSurface,
    planDiff.hasPreviousVersion,
    () => setIsPlanDiffActive(false),
  );

  apiRef.current = {
    isPlanDiffActive,
    hasPreviousVersion: planDiff.hasPreviousVersion,
    activate: () => setIsPlanDiffActive(true),
    switchDoc: setDoc,
  };
  return null;
}

async function mountHarness(htmlSurface = false): Promise<{ current: () => HarnessApi }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const apiRef: { current: HarnessApi | null } = { current: null };
  await act(async () => {
    root.render(<Harness apiRef={apiRef} htmlSurface={htmlSurface} />);
  });
  return {
    current: () => {
      if (!apiRef.current) throw new Error('Harness not mounted');
      return apiRef.current;
    },
  };
}

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  for (const container of containers) container.remove();
  containers = [];
});

describe('usePlanDiffViewAutoExit', () => {
  test.skipIf(!hasDom)('exits diff view when the active document switches to one with no baseline', async () => {
    const harness = await mountHarness();

    await act(async () => harness.current().activate());
    expect(harness.current().isPlanDiffActive).toBe(true);
    expect(harness.current().hasPreviousVersion).toBe(true);

    await act(async () => harness.current().switchDoc(DOC_WITHOUT_BASELINE));
    expect(harness.current().hasPreviousVersion).toBe(false);
    expect(harness.current().isPlanDiffActive).toBe(false);
  });

  test.skipIf(!hasDom)('keeps diff view active when switching to a document that has its own baseline', async () => {
    const harness = await mountHarness();

    await act(async () => harness.current().activate());
    await act(async () => harness.current().switchDoc(SECOND_DOC_WITH_BASELINE));

    expect(harness.current().hasPreviousVersion).toBe(true);
    expect(harness.current().isPlanDiffActive).toBe(true);
  });

  test.skipIf(!hasDom)('never auto-exits on HTML surfaces, where usePlanDiff is fed nulls by design', async () => {
    const harness = await mountHarness(true);

    await act(async () => harness.current().activate());
    // hasPreviousVersion is always false here (nulls in), but the caller
    // gates `active` off, so the html diff toggle must stay on.
    expect(harness.current().hasPreviousVersion).toBe(false);
    expect(harness.current().isPlanDiffActive).toBe(true);
  });

  test.skipIf(!hasDom)('stays off for a stable root document with no baseline (plan review first version)', async () => {
    const harness = await mountHarness();

    await act(async () => harness.current().switchDoc(DOC_WITHOUT_BASELINE));
    expect(harness.current().isPlanDiffActive).toBe(false);

    // Activating with no baseline immediately snaps back off — the stuck
    // state can never establish itself.
    await act(async () => harness.current().activate());
    expect(harness.current().isPlanDiffActive).toBe(false);
  });
});
