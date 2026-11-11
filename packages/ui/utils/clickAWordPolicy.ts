/**
 * Click a word: in the Viewer's Select input method, one click on a word
 * highlights that word (`hooks/useClickWord`).
 *
 * Default: on, for every host of the Viewer. A host that wants a click on
 * text to make nothing, as before, passes
 * `configurePlannotatorUI({ clickAWord: false })`; one Viewer's own
 * `clickAWord` prop wins over this. Read when a Viewer mounts.
 */
let clickAWord = true;

export function setClickAWord(on: boolean): void {
  clickAWord = on;
}

export function resetClickAWord(): void {
  clickAWord = true;
}

export function getClickAWord(): boolean {
  return clickAWord;
}
