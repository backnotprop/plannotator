/**
 * DOM builder for the edit-session Selection Action popover content.
 *
 * Pierre's `renderSelectionAction` returns a PLAIN DOM node (not React) that
 * renders inside the editor's shadow DOM, where the app's Tailwind/global CSS
 * does not apply — so everything here is styled inline. CSS custom properties
 * DO inherit through the shadow boundary, so colors come from the app's theme
 * tokens (var(--card), var(--border), ...) and track light/dark and theme
 * switches for free.
 *
 * No Pierre types cross this module: the caller (useEditSession) adapts the
 * SelectionActionContext into the single `onMakeAnnotation` callback.
 */

const ICON_COMMENT_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>';

const BUTTON_STYLE = [
  'display: inline-flex',
  'align-items: center',
  'gap: 5px',
  'font-family: var(--font-sans), system-ui, sans-serif',
  'font-size: 12px',
  'font-weight: 500',
  'line-height: 1',
  'padding: 5px 10px',
  'border-radius: 6px',
  'border: 1px solid var(--border)',
  'background-color: var(--card)',
  'color: var(--card-foreground)',
  'cursor: pointer',
  'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18)',
  'white-space: nowrap',
].join('; ');

const BUTTON_HOVER_BACKGROUND = 'var(--muted)';

/**
 * Build the popover element: a single "Make annotation" action.
 *
 * `onMakeAnnotation` receives the button's viewport rect so the caller can
 * anchor the app-side comment entry where the popover was. The handler must
 * snapshot everything it needs from the editor synchronously — the caller
 * closes the Pierre popover right after, and the editor selection may
 * collapse as soon as focus moves to the app-side entry.
 */
export function buildSelectionActionElement(
  onMakeAnnotation: (anchorRect: DOMRect) => void,
): HTMLElement {
  const container = document.createElement('div');
  container.style.cssText = 'display: flex; gap: 4px;';
  container.dataset.testid = 'edit-selection-action';

  const button = document.createElement('button');
  button.type = 'button';
  button.style.cssText = BUTTON_STYLE;
  button.innerHTML = `${ICON_COMMENT_SVG}<span>Make annotation</span>`;
  button.title = 'Create a Plannotator comment on the selected lines';
  button.dataset.testid = 'edit-selection-make-annotation';

  button.addEventListener('mouseenter', () => {
    button.style.backgroundColor = BUTTON_HOVER_BACKGROUND;
  });
  button.addEventListener('mouseleave', () => {
    button.style.backgroundColor = 'var(--card)';
  });
  // Suppress the default mousedown so clicking the action doesn't blur the
  // editor and collapse the selection we're about to read (same trick as
  // Pierre's own selection-action demo).
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    onMakeAnnotation(button.getBoundingClientRect());
  });

  container.append(button);
  return container;
}
