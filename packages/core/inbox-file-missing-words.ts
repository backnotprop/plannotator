/**
 * What the Inbox says of a file a message names that is nowhere it looked: the referenced file pane's card
 * (packages/inbox ReferencedFilePane) and the open-in routes' errors (packages/server/inbox-open-in.ts), so the window
 * and the server say the same. PROPOSED words, held for the owner's approval before this ships.
 *
 * `lookedIn`: where it was looked for first, as the window names a file of the thread (from the project folder when it
 * lies there), or null when no path is safe to name. With no path, or one that is only the name itself (a file at the
 * project's top), the short form: "plan.md isn't at plan.md." says nothing.
 */
export function fileNotFoundShort(name: string, lookedIn: string | null | undefined): boolean {
  return !lookedIn || lookedIn === name;
}

/** The card's line under the file's name: "isn't at <path>." (only when `fileNotFoundShort` is false). */
export function fileNotFoundWords(lookedIn: string): string {
  return `isn't at ${lookedIn}.`;
}

/** The whole sentence: "<name> isn't at <path>.", or "Couldn't find <name>." */
export function fileNotFoundSentence(name: string, lookedIn: string | null | undefined): string {
  return fileNotFoundShort(name, lookedIn) ? `Couldn't find ${name}.` : `${name} ${fileNotFoundWords(lookedIn!)}`;
}
