/** The thread pane's words for what is still to send after a Send that went without its answer. */
import type { UnconfirmedSend } from '../data/actions/sendLanded';

/**
 * What the person added after a Send that went without its answer (comments, picks, files it did not
 * carry): said plainly, since they are still to send. Null when nothing was added. `now`: the ids in the
 * reply box at this moment (comments, `<message id>/<key>` picks, uploads).
 */
export function leftoverWords(earlier: UnconfirmedSend, now: { comments: readonly string[]; picks: readonly string[]; uploads: readonly string[] }): string | null {
  const comments = now.comments.filter((id) => !earlier.comments.includes(id)).length;
  const picks = now.picks.filter((id) => !earlier.picks.includes(id)).length;
  const files = now.uploads.filter((id) => !earlier.uploads.includes(id)).length;
  const parts = [
    comments > 0 ? `${comments} comment${comments === 1 ? '' : 's'}` : null,
    picks > 0 ? `${picks} pick${picks === 1 ? '' : 's'}` : null,
    files > 0 ? `${files} file${files === 1 ? '' : 's'}` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `Your reply went. Not sent yet: ${list}. Press Send to send ${parts.length === 1 && !list.endsWith('s') ? 'it' : 'them'}.`;
}
