/**
 * The levels one refresh of the files panel asks for (`GET …/files/levels`): the root, then the open folders the
 * last answer refused for its row cap (`too_large`), then the rest. The server lists them in order until the cap, so
 * a folder past the cap is not the one left out at every refresh.
 */
export function relistOrder(open: readonly string[], starved: ReadonlySet<string>): string[] {
  return ['', ...open.filter((dir) => dir !== '' && starved.has(dir)), ...open.filter((dir) => dir !== '' && !starved.has(dir))];
}
