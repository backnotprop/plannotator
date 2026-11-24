/**
 * A way into the viewer from a sound or video the message's text plays in place (the owner, 2026-11-24: comment
 * on and annotate an inline video "like the viewer can"). The player's own controls keep every click on it, so the
 * viewer (time comments, a drawing on a frame) is reached by an "Open" button under it: the "Show all" button's
 * look (`ib-btn ib-sm` in an `annotation-exclude` span after the element, its word drawn from `data-label`, so the
 * body's text stays the agent's; images.ts `syncMessageImages`), named "Open <name>" as an attached file's tile is.
 * Only once the Inbox keeps the file (its `inline_images` record, captured on a read of the thread): until then
 * there is nothing to open in the viewer, and the button appears when the record lands (the next render).
 * Inbox only: ui draws the player (`HostResolvedMedia`) and knows nothing of this.
 */

const OPEN_ATTR = 'data-ib-media-open';

export interface MediaOpenRecord {
  id: string;
  name: string;
}

/** Keep an "Open" button after each inline player whose record exists; remove the others. Safe to call at any time. */
export function syncMediaOpen(body: HTMLElement, recordOf: (src: string | null) => MediaOpenRecord | null): void {
  const kept = new Set<Element>();
  for (const media of body.querySelectorAll<HTMLMediaElement>('video[data-inline-media], audio[data-inline-media]')) {
    if (media.hidden) continue;
    const record = recordOf(media.getAttribute('src'));
    if (!record) continue;
    let open = media.nextElementSibling;
    if (!open?.hasAttribute(OPEN_ATTR)) {
      open = body.ownerDocument.createElement('span');
      open.setAttribute(OPEN_ATTR, '');
      open.className = 'ib-mediaopen annotation-exclude';
      const button = body.ownerDocument.createElement('button');
      button.type = 'button';
      button.className = 'ib-btn ib-sm';
      button.setAttribute('data-label', 'Open');
      open.append(button);
      media.after(open);
    }
    const button = open.firstElementChild as HTMLButtonElement;
    const name = `Open ${record.name}`;
    if (button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name);
    if (button.getAttribute('data-inline-image') !== record.id) button.setAttribute('data-inline-image', record.id);
    kept.add(open);
  }
  for (const open of body.querySelectorAll(`[${OPEN_ATTR}]`)) if (!kept.has(open)) open.remove();
}

/** A click on one of those buttons: the player it opens. Null: the click was on something else. */
export function mediaOpenTarget(target: EventTarget | null): HTMLMediaElement | null {
  const open = target instanceof Element ? target.closest(`[${OPEN_ATTR}]`) : null;
  const media = open?.previousElementSibling;
  return media instanceof HTMLMediaElement ? media : null;
}
