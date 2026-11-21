/**
 * The held list's lines (newsWords.ts): the news in the list on screen, "Claude Code replied in “Checkout redesign”
 * · Show", and, in a project or filter view, the news outside it, "Codex replied in billing-svc · Show all". The two
 * never count a thread twice. A thread the view holds but the person's own filter picks hide is in neither: Show all
 * would not bring it in. Pure.
 */
import type { InboxListSection } from '@plannotator/core/inbox-types';
import { heldArrivalRows, type OpenThread } from './held';
import { arrivalOf, elsewhereLine, hereLine, type NewsLine } from './newsWords';

export interface HeldLinesInput {
  /** The list on screen (held) and the latest read, both whole: every project, before any filter. */
  shown: readonly InboxListSection[];
  latest: readonly InboxListSection[];
  /** The list as the person reads it: the view's scope, then their filter picks (useListView's `filterShown`). */
  view: (sections: readonly InboxListSection[]) => InboxListSection[];
  /** The view's scope alone (a project, a machine, an agent, a tag), or null on the Inbox: no line for elsewhere. */
  scope: ((sections: readonly InboxListSection[]) => InboxListSection[]) | null;
  openedHere?: ReadonlySet<string>;
  open?: OpenThread | null;
  names?: ReadonlyMap<string, string>;
}

export function heldLines({ shown, latest, view, scope, openedHere, open, names }: HeldLinesInput): { here: NewsLine | null; elsewhere: NewsLine | null } {
  const here = hereLine(heldArrivalRows(view(shown), view(latest), openedHere, open).map(({ row, was }) => arrivalOf(row, was, names)));
  if (!scope) return { here, elsewhere: null };
  const inView = new Set(scope(latest).flatMap((section) => section.threads.map((row) => row.thread_id)));
  const away = heldArrivalRows(shown, latest, openedHere, open).filter(({ row }) => !inView.has(row.thread_id));
  return { here, elsewhere: elsewhereLine(away.map(({ row, was }) => arrivalOf(row, was, names))) };
}
