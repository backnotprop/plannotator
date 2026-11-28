/**
 * Whether an Escape is for a swarm popover in `box` (the status view, the ghost box's "to" list): never one pressed
 * inside a modal dialog that does not hold it (New message opened over the thread), so one Escape closes that dialog.
 */
export function swarmEscapeIsOurs(event: KeyboardEvent, box: Element | null): boolean {
  const target = event.target instanceof Element ? event.target : null;
  const modal = target?.closest('[aria-modal="true"]') ?? null;
  return !modal || (!!box && modal.contains(box));
}
