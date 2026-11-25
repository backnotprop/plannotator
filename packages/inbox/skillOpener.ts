/**
 * Where focus goes back when a skill's file closes (SkillFilePane): the chip or the name on the skills line that
 * opened it. The control is found again by what it is (its message, its skill, its place) when the one pressed was
 * drawn anew while the file was open. It is forgotten when the file goes another way: the browser's Back, or the
 * thread it was opened in going away (another thread opened), so a later file never sends focus to a stale control.
 */
let opener: { element: HTMLElement; selector: string; thread: string } | null = null;

/** The skill files open now, by their thread: their skill and how each closes (a double-click takes its open back). */
const panes = new Set<{ thread: string; name: string; close: () => void }>();

const quoted = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;

/** `element` (a `[data-skill-open]` control inside a message's `[data-message-id]`) in `thread` opened a skill's file. */
export function noteSkillOpener(element: HTMLElement, thread: string): void {
  const messageId = element.closest('[data-message-id]')?.getAttribute('data-message-id') ?? '';
  const name = element.getAttribute('data-skill-open') ?? '';
  const place = element.getAttribute('data-skill-place') ?? '';
  opener = { element, thread, selector: `[data-message-id=${quoted(messageId)}] [data-skill-open=${quoted(name)}][data-skill-place=${quoted(place)}]` };
}

/** What opened the file is no longer where focus goes back. */
export function forgetSkillOpener(): void {
  opener = null;
}

/** Tests: the control focus would go back to, if any. */
export function skillOpenerNow(): HTMLElement | null {
  return opener?.element ?? null;
}

/** After the file closed: focus its opener once the thread is drawn again (a few frames at most). */
export function returnFocusToSkillOpener(): void {
  const was = opener;
  opener = null;
  if (!was) return;
  let tries = 0;
  const attempt = () => {
    const target = was.element.isConnected ? was.element : document.querySelector<HTMLElement>(was.selector);
    if (target && target.getClientRects().length > 0) {
      target.focus({ preventScroll: true });
      return;
    }
    // Still hidden (a phone's file covers the thread until it closes): try again next frame.
    if (++tries < 10) requestAnimationFrame(attempt);
    else target?.focus({ preventScroll: true });
  };
  requestAnimationFrame(attempt);
}

/**
 * A skill's file is open in `thread` (SkillFilePane, while it is drawn); the answer is called when it is not. Once no
 * file of the opener's thread is left open, the opener is forgotten: checked a moment later, so a pane drawn again at
 * once (React's development double mount, a new skill in the same pane) still keeps it.
 */
export function holdSkillFile(thread: string, name: string, close: () => void): () => void {
  const entry = { thread, name, close };
  panes.add(entry);
  // Taken back before it was drawn (a quick double-click): it closes at once.
  if (takenBack && takenBack.name === name && Date.now() - takenBack.at < TAKE_BACK_MS) {
    takenBack = null;
    queueMicrotask(close);
  }
  return () => {
    panes.delete(entry);
    queueMicrotask(() => {
      if (opener && ![...panes].some((pane) => pane.thread === opener!.thread)) opener = null;
    });
  };
}

/** A take-back that came before its file was drawn, and how long it waits for it. */
let takenBack: { name: string; at: number } | null = null;
const TAKE_BACK_MS = 1000;

/** A double-click's second press takes back the open its first click made: `name`'s file closes, focus stays put. */
export function takeBackSkillFile(name: string): void {
  opener = null;
  const pane = [...panes].find((open) => open.name === name);
  if (pane) pane.close();
  else takenBack = { name, at: Date.now() };
}

// The browser's Back (or Forward) moved the window: what opened the file is not where focus goes any more.
if (typeof window !== 'undefined') window.addEventListener('popstate', forgetSkillOpener, true);
