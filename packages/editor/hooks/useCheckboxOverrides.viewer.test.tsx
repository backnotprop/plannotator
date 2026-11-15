/**
 * Plan review's checkbox toggles, through the real hook and the real Viewer: a press shows the item checked, a second
 * press shows it open again, and a restored snapshot shows it as saved. The Viewer draws a block again only when its
 * props change, so the hook must hand it a new overrides map each time; a map changed in place would leave the old
 * mark on screen.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import type { Annotation } from '@plannotator/ui/types';
import type { UseCheckboxOverridesReturn } from './useCheckboxOverrides';

const hasDom = typeof document !== 'undefined';
const React = (hasDom ? await import('react') : {}) as typeof import('react');
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { Viewer } = (hasDom ? await import('@plannotator/ui/components/Viewer') : {}) as typeof import('@plannotator/ui/components/Viewer');
const { parseMarkdownToBlocks } = (hasDom ? await import('@plannotator/ui/utils/parser') : {}) as typeof import('@plannotator/ui/utils/parser');
const { useCheckboxOverrides } = (hasDom ? await import('./useCheckboxOverrides') : {}) as typeof import('./useCheckboxOverrides');

const PLAN = ['# Release', '', '- [ ] Tag the release', '- [ ] Post the notes'].join('\n');
const noop = () => {};
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
let checkbox: UseCheckboxOverridesReturn | null = null;

afterEach(async () => {
  if (root) await React.act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  checkbox = null;
});

function Plan() {
  const blocks = React.useMemo(() => parseMarkdownToBlocks(PLAN), []);
  const [annotations, setAnnotations] = React.useState<Annotation[]>([]);
  checkbox = useCheckboxOverrides({
    blocks,
    annotations,
    addAnnotation: (annotation) => {
      setAnnotations((all) => [...all, annotation]);
      return annotations.length;
    },
    removeAnnotation: (id) => setAnnotations((all) => all.filter((a) => a.id !== id)),
  });
  return (
    <Viewer
      blocks={blocks}
      markdown={PLAN}
      annotations={annotations}
      onAddAnnotation={noop}
      onSelectAnnotation={noop}
      selectedAnnotationId={null}
      mode="selection"
      taterMode={false}
      stickyActions={false}
      disableCodePathValidation
      onToggleCheckbox={checkbox.toggle}
      checkboxOverrides={checkbox.overrides}
    />
  );
}

const checked = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('[data-rich-list-checked]')].find((item) => item.textContent?.includes(text))?.getAttribute('data-rich-list-checked');

test.skipIf(!hasDom)('a toggle, a second toggle and a restored snapshot each show on the item', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await React.act(async () => root!.render(<Plan />));
  const box = () => [...host!.querySelectorAll<HTMLElement>('[role="checkbox"]')].find((b) => b.closest('[data-rich-list-checked]')?.textContent?.includes('Tag the release'))!;

  await React.act(async () => box().click());
  expect(checked(host, 'Tag the release')).toBe('true');
  const saved = [...checkbox!.overrides];

  await React.act(async () => box().click());
  expect(checked(host, 'Tag the release')).toBe('false');

  await React.act(async () => checkbox!.restoreOverrides(saved));
  expect(checked(host, 'Tag the release')).toBe('true');
  expect(checked(host, 'Post the notes')).toBe('false');
});
