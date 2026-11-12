export function unsavedComposer(pane: HTMLElement | null, savedText: (id: string) => string | undefined = () => undefined): HTMLTextAreaElement | null {
  return unsavedComposers(pane, savedText)[0] ?? null;
}

export function unsavedComposers(
  pane: HTMLElement | null,
  savedText: (id: string) => string | undefined = () => undefined,
  owns: (area: HTMLTextAreaElement) => boolean = () => true,
): HTMLTextAreaElement[] {
  const found: HTMLTextAreaElement[] = [];
  const typed = (area: HTMLTextAreaElement) => area.value.trim() !== '';
  for (const area of document.querySelectorAll<HTMLTextAreaElement>('[data-comment-popover] textarea')) {
    if (typed(area) && owns(area)) found.push(area);
  }
  if (!pane) return found;
  for (const area of pane.querySelectorAll<HTMLTextAreaElement>('[data-diagram-composer] textarea, [data-image-composer] textarea')) {
    if (typed(area)) found.push(area);
  }
  const drawn = pane.querySelector<HTMLElement>('[data-image-composer] .ib-markup');
  const row = drawn ? pane.querySelector<HTMLTextAreaElement>('[data-image-composer] textarea') : null;
  if (row && !found.includes(row)) found.push(row);
  const roots: ParentNode[] = [pane];
  for (const container of pane.querySelectorAll('diffs-container')) if (container.shadowRoot) roots.push(container.shadowRoot);
  for (const scope of roots) {
    for (const area of scope.querySelectorAll<HTMLTextAreaElement>('[data-annotation-id] textarea, [data-code-annotation-id] textarea')) {
      const owner = area.closest('[data-annotation-id], [data-code-annotation-id]');
      const id = owner?.getAttribute('data-annotation-id') ?? owner?.getAttribute('data-code-annotation-id') ?? '';
      if (area.value.trim() !== (savedText(id) ?? '').trim()) found.push(area);
    }
  }
  return found;
}
