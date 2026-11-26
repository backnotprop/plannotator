/**
 * What the referenced file pane says of a file a message names that is nowhere it looked (ReferencedFilePane): the
 * file's name, then where it looked first, as the window names a file of the thread (`looked_in`: from the project
 * folder when it lies there). PROPOSED words, held for the owner's approval before this ships.
 */
export function fileNotFoundWords(lookedIn: string): string {
  return `isn't at ${lookedIn}.`;
}
