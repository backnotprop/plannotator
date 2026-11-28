/**
 * A paragraph (or a list item) that holds only images: `![a](a.jpg) ![b](b.jpg)`,
 * linked images (`[![x](a.jpg)](https://…)`) too, over one line or several.
 *
 * Two or more draw as one row that wraps on a narrow screen, each image capped
 * at one height (never enlarged), where they used to stack or sit at their own
 * sizes side by side. One alone
 * keeps its width but is never taller than `min(30rem, 70vh)`, so a tall
 * screenshot does not fill the page (a click still opens it full size).
 * An image in a sentence, in a table cell, or written as `<img width=…>` is
 * not one of these and draws as before.
 *
 * The paragraph stays the same element with the same text (the spaces between
 * the images included), so a comment's stored position is unchanged; only its
 * layout classes and `data-image-row="<count>"` are added. A host can style on
 * that attribute.
 *
 * A host that sizes the pictures in a document itself turns this off with
 * `<ImageRowsContext.Provider value={false}>` around its renderer: no row, no
 * cap, no attribute; its images draw exactly as before. The Plannotator Inbox
 * does this for message bodies, whose pictures it fits itself
 * (`.ib-body img[data-ib-fit]`).
 */
import { createContext } from 'react';

/** False: images alone in a paragraph draw as they always did (the host sizes them). Default true. */
export const ImageRowsContext = createContext(true);

const IMAGE = /!\[[^\]]*\]\([^)]+\)/;
const LINKED_IMAGE = new RegExp(`\\[${IMAGE.source}\\]\\([^)]+\\)`);
const IMAGES = new RegExp(`${LINKED_IMAGE.source}|${IMAGE.source}`, 'g');

/** How many images `text` holds when it holds nothing else but white space; else 0. */
export function imageOnlyCount(text: string): number {
  if (!text.includes('![')) return 0;
  let count = 0;
  const rest = text.replace(IMAGES, () => {
    count += 1;
    return '';
  });
  return rest.trim() === '' ? count : 0;
}

/**
 * The row: wrapping, no inline margins on the images, every image capped at one
 * height. Capped, never set: an image is never drawn larger than it is, so two
 * badges or 16 px icons stay their size, and an image not yet loaded takes no
 * made-up box (nothing jumps when it arrives). Screenshots and photos, taller
 * than the cap, all draw at the cap: one even row.
 */
const ROW_CLASS =
  'flex flex-wrap items-center gap-2 [&_img]:my-0 [&_img]:h-auto [&_img]:max-h-[min(12rem,40vh)] [&_img]:w-auto [&_img]:max-w-full [&_img]:object-contain';
/** One image: its own width, capped in height. */
const SINGLE_CLASS = '[&_img]:max-h-[min(30rem,70vh)] [&_img]:w-auto [&_img]:object-contain';

/** Classes and attributes for the element holding `text`; empty when it is not images only, or rows are off (ImageRowsContext). */
export function imageRowProps(text: string, enabled = true): { className: string; 'data-image-row'?: number } {
  const count = enabled ? imageOnlyCount(text) : 0;
  if (count === 0) return { className: '' };
  return { className: count > 1 ? ROW_CLASS : SINGLE_CLASS, 'data-image-row': count };
}
