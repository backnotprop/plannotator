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

const RENDER_CAP = 40;

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
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(renderCount.current).toBeLessThanOrEqual(4);
  });
});
