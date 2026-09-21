import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import {
  primeSkillContentsForExport,
  resetSkillCatalogCache,
  resetSkillCatalogTransport,
  resetSkillContentTransport,
  setSkillCatalogTransport,
  setSkillContentTransport,
} from '@plannotator/ui/utils/skillCatalog';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { useEditableDocuments } from './editableDocuments';

const hasDom = typeof document !== 'undefined';

// Regression for the skill-prime render loop: once a comment referenced a
// human-only skill, App.tsx's priming effect re-fired every render (its deps
// changed identity every render via useEditableDocuments' bare object
// literal) and primeSkillContentsForExport kept answering "changed" for
// content that had already landed — so every effect run bumped the
// generation, which re-rendered, which re-fired the effect, unbounded.
// This harness mirrors that exact wiring and asserts the commit count stays
// flat while idle.

const RENDER_CAP = 40; // keeps a regression from hanging the test run

let roots: Root[] = [];
let containers: HTMLElement[] = [];

beforeEach(() => {
  resetSkillCatalogCache();
  setSkillCatalogTransport(async () => [
    {
      name: 'plannotator-review',
      root: 'claude',
      humanOnly: true,
      dir: '/skills/plannotator-review',
    },
  ] as SkillCatalogEntry[]);
  setSkillContentTransport(async (name) => ({
    name,
    dir: `/skills/${name}`,
    path: `/skills/${name}/SKILL.md`,
    content: `# Instructions for ${name}`,
    truncated: false,
    humanOnly: true,
  }));
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of containers.splice(0)) container.remove();
  resetSkillCatalogCache();
  resetSkillCatalogTransport();
  resetSkillContentTransport();
});

describe('skill-content priming effect', () => {
  test.skipIf(!hasDom)('settles instead of re-render looping once a human-only skill is referenced', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    containers.push(container);

    const renderCount = { current: 0 };

    function Harness() {
      renderCount.current++;
      const editableDocuments = useEditableDocuments();
      // Mirrors App.tsx's getLinkedDocumentMarkdown → getDocAnnotations
      // chain: a callback keyed on the hook's returned object ends up in the
      // priming effect's dep array.
      const getDocAnnotations = React.useCallback(
        () => new Map<string, never>(),
        [editableDocuments],
      );
      const [, setSkillContentGeneration] = React.useState(0);
      React.useEffect(() => {
        if (renderCount.current > RENDER_CAP) return;
        let cancelled = false;
        void getDocAnnotations();
        primeSkillContentsForExport(['See $plannotator-review']).then((changed) => {
          if (changed && !cancelled) setSkillContentGeneration((g) => g + 1);
        });
        return () => {
          cancelled = true;
        };
      }, [getDocAnnotations]);
      return null;
    }

    await act(async () => {
      root.render(<Harness />);
    });
    // Let several idle microtask/effect cycles pass; a looping app keeps
    // committing here, a fixed one is already settled.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    // Expected: initial render + the single generation bump when the skill
    // content first lands. Anything near RENDER_CAP is the loop.
    expect(renderCount.current).toBeLessThanOrEqual(4);
  });
});
