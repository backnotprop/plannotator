/**
 * Where focus goes back when a skill's file closes (SkillFilePane): the chip or the name on the skills line that
 * opened it. The control is found again by what it is (its message, its skill, its place) when the one pressed was
 * drawn anew while the file was open.
 */
let opener: { element: HTMLElement; selector: string } | null = null;

const quoted = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;

/** `element` (a `[data-skill-open]` control inside a message's `[data-message-id]`) opened a skill's file. */
export function noteSkillOpener(element: HTMLElement): void {
  const messageId = element.closest('[data-message-id]')?.getAttribute('data-message-id') ?? '';
  const name = element.getAttribute('data-skill-open') ?? '';
  const place = element.getAttribute('data-skill-place') ?? '';
  opener = { element, selector: `[data-message-id=${quoted(messageId)}] [data-skill-open=${quoted(name)}][data-skill-place=${quoted(place)}]` };
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
