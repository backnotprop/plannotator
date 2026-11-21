import { placeOf, type OpenQuestionPlace } from '../openQuestions';
import { stillHidden, type FoldState } from './helpers';

interface OpenItem {
  id: string;
  messageId: string;
  key: string;
}

export function measureOpenPlaces(body: HTMLElement | null, fold: FoldState, questions: readonly OpenItem[], actions: readonly OpenItem[]): ReadonlyMap<string, OpenQuestionPlace> {
  const places = new Map<string, OpenQuestionPlace>();
  const hidden = new Set(fold.hidden.flatMap((ids, index) => stillHidden(ids, fold.shown[index])));
  const view = body?.getBoundingClientRect() ?? { top: 0, bottom: 0 };
  const place = (item: OpenItem, inner: string) => {
    if (fold.folded.has(item.messageId) || hidden.has(item.messageId)) {
      places.set(item.id, 'folded');
      return;
    }
    const el =
      body?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(item.messageId)}"] [${inner}="${CSS.escape(item.key)}"]`) ??
      body?.querySelector<HTMLElement>(`[data-message-article="${CSS.escape(item.messageId)}"]`) ??
      null;
    places.set(item.id, placeOf(el?.getBoundingClientRect() ?? null, view));
  };
  for (const q of questions) place(q, 'data-question-key');
  for (const a of actions) place(a, 'data-action-card');
  return places;
}
