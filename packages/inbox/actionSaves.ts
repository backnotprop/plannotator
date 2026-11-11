const inFlight = new Set<Promise<unknown>>();
const flushes = new Set<() => void>();

export function trackActionSave<T>(save: Promise<T>): Promise<T> {
  inFlight.add(save);
  const done = () => inFlight.delete(save);
  save.then(done, done);
  return save;
}

export function registerActionFlush(flush: () => void): () => void {
  flushes.add(flush);
  return () => flushes.delete(flush);
}

export function actionSavesPending(): boolean {
  return inFlight.size > 0;
}

export async function actionSavesSettled(): Promise<void> {
  for (const flush of [...flushes]) flush();
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/**
 * A note save the server refused because the item moved on while the note
 * was in its typing pause (sent from another window, superseded, archived):
 * there is nothing for the person to do about it, so the window says
 * nothing (no error toast). A Done or Can't do it the person pressed is never
 * moot: its refusal is shown.
 */
export function isMootNoteRefusal(mark: { quiet?: boolean } | null, cause: unknown): boolean {
  if (!mark?.quiet || !cause || typeof cause !== 'object') return false;
  const code = (cause as { code?: unknown }).code;
  return code === 'action_already_sent' || code === 'action_closed';
}
