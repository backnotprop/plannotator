/**
 * Putting reference cards on the board: what a paste becomes, and how a web
 * card fills in. Speaks only in commands, like everything else that changes
 * a canvas; an agent adds the same cards with the same `add` command.
 */
import type { CanvasStore } from '../events/store';
import { isPictureRef } from '../model/assets';
import { createId } from '../model/ids';
import { hostOf, pastedUrl } from '../model/reference';
import type { Point } from '../model/geometry';
import type { ReferenceObject, ReferenceTarget } from '../model/types';
import type { LinkPreviewPort } from '../model/reference';

/** A card with no picture, and one with. */
export const CARD_SIZE = { w: 280, h: 84 } as const;
export const CARD_SIZE_WITH_IMAGE = { w: 280, h: 236 } as const;

/** What a host says a pasted text is, when it knows it as one of its own things. */
export interface PastedReference {
  target: ReferenceTarget;
  title?: string;
  description?: string;
  site?: string;
  image?: string;
  icon?: string;
}

/** Lets the host recognise its own artifacts and plans in pasted text. */
export type PasteResolver = (text: string) => PastedReference | null;

/** What a pasted text should become: a host's own reference, else a web card for a bare address, else nothing. */
export function referenceFromPaste(text: string, resolve?: PasteResolver): PastedReference | null {
  const own = resolve?.(text.trim()) ?? null;
  if (own) return own;
  const url = pastedUrl(text);
  return url ? { target: { kind: 'web', url }, site: hostOf(url) } : null;
}

/**
 * Add a card centred on `at`. A web card is on the board at once, showing
 * its address; when the preview lands it fills in, and grows to hold a
 * picture if the person has not resized it meanwhile. The fill-in joins the
 * paste's own undo step wherever that step is by then, and leaves redo alone. Returns the card's id, or null when it was refused.
 */
export function addReference(store: CanvasStore, at: Point, reference: PastedReference, preview?: LinkPreviewPort): string | null {
  const id = createId('ref');
  const size = reference.image ? CARD_SIZE_WITH_IMAGE : CARD_SIZE;
  const gesture = `ref-${id}`;
  const object: ReferenceObject = { id, type: 'reference', x: Math.round(at.x - size.w / 2), y: Math.round(at.y - size.h / 2), ...size, ...reference };
  const added = store.dispatch({ type: 'add', objects: [object] }, { gesture });
  if (!added.ok) return null;
  const { target } = reference;
  if (target.kind === 'web' && preview && !reference.title) {
    void preview(target.url).then((found) => {
      const current = store.getDocument().objects[id];
      if (!found || !current || current.type !== 'reference') return;
      // A picture address the card may not hold is left out, not allowed to sink the rest.
      const image = isPictureRef(found.image) ? found.image : undefined;
      const icon = isPictureRef(found.icon) ? found.icon : undefined;
      const patch = { title: found.title?.slice(0, 300), description: found.description?.slice(0, 600), site: found.site?.slice(0, 300), image, icon };
      if (!Object.values(patch).some(Boolean)) return;
      // Part of the paste, wherever that step now is; never a step of its own, never the end of a redo.
      store.dispatch({ type: 'edit', id, patch }, { gesture, amend: true });
      const now = store.getDocument().objects[id];
      if (image && now?.type === 'reference' && now.w === CARD_SIZE.w && now.h === CARD_SIZE.h) {
        store.dispatch({ type: 'resize', id, rect: { x: now.x, y: now.y, ...CARD_SIZE_WITH_IMAGE } }, { gesture, amend: true });
      }
    });
  }
  return id;
}
