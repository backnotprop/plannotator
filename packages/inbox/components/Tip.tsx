import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
import { Tooltip, TOOLTIP_DELAY_MS } from '@plannotator/ui/components/Tooltip';
import { isTextCut as isTextCutIn, noHover } from '@plannotator/ui/utils/textCut';
import { tooltipContainerOf } from '@plannotator/ui/components/HostTitle';

/**
 * ui's cut check (a whole pixel, or the text's Range wider than its box). A
 * FileName (`.ib-fname`) counts as cut when its first part (`.ib-fname-h`) is.
 */
export function isTextCut(el: Element | null | undefined): boolean {
  return isTextCutIn(el, el?.classList.contains('ib-fname') ? '.ib-fname-h' : undefined);
}

/** How long the pointer rests before a tooltip opens (the list chips' timing). */
export const TIP_DELAY_MS = TOOLTIP_DELAY_MS;

/**
 * The Inbox's hover text: ui's Tooltip (the component the list's chips use),
 * never the browser's native `title`, which waits about a second and cannot
 * be styled. The window's one TooltipProvider (App.tsx) sets the timing:
 * 150 ms to open, the next one at once within 400 ms.
 *
 * `cut`: open only while the trigger's text is actually cut (an ellipsis, a
 * clamp), so a name that fits gets no tooltip repeating it. Without `cut` it
 * always opens. `when` decides each time instead, for anything else (a mark
 * whose label is hidden).
 *
 * The trigger keeps its own accessible name (an `aria-label`, or its text):
 * the tooltip adds nothing a screen reader needs, and a trigger that is not
 * focusable stays out of the tab order. Nothing opens on a touch screen
 * (`hover: none`): a hover there is a first tap. The popup is portaled into
 * the open native `<dialog>` the trigger sits in (so the top layer does not
 * cover it), else into the window's root (`data-pn-tooltip-root`), so the
 * Soft switches' tokens reach it. Escape closes an open tooltip and still reaches the window
 * (`escapePassesThrough`), so Escape closes a thread whatever holds focus.
 */
export function Tip({
  content,
  children,
  cut = false,
  when,
  side = 'top',
  align,
  wide = true,
  open,
}: {
  content: ReactNode;
  children: ReactElement;
  cut?: boolean;
  when?: (trigger: Element) => boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  wide?: boolean;
  /**
   * Shown whatever the pointer does while true (the list rows' badges, while
   * their row has keyboard focus). Unset: hover decides, as for every tip.
   */
  open?: boolean;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const shouldOpen = useCallback(
    (trigger: Element) => {
      if (content === null || content === undefined || content === '') return false;
      if (noHover()) return false;
      if (cut && !isTextCut(trigger)) return false;
      if (when && !when(trigger)) return false;
      setContainer(tooltipContainerOf(trigger));
      return true;
    },
    [content, cut, when],
  );
  // A disabled control gets no pointer events (and React drops mouse events on
  // it), so its tooltip hangs on a wrapper the pointer reaches instead
  // (inbox.css: `.ib-tipwrap > :disabled` lets the pointer through). Any
  // control that can be disabled gets the wrapper, disabled or not, so the
  // control is never remounted (and never loses focus) when it changes.
  const canDisable = 'disabled' in (children.props as object);
  const trigger = canDisable ? (
    <span className="ib-tipwrap" data-tip-wrap="">
      {children}
    </span>
  ) : (
    children
  );
  return (
    <Tooltip
      content={content}
      side={side}
      align={align}
      wide={wide}
      delayDuration={TIP_DELAY_MS}
      shouldOpen={shouldOpen}
      // Opened without a hover, shouldOpen never named the trigger's root: the window's.
      container={container ?? (open ? windowTooltipRoot() : null)}
      escapePassesThrough
      forceOpen={open}
    >
      {trigger}
    </Tooltip>
  );
}

function windowTooltipRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('[data-pn-tooltip-root]');
}

/** A project's tooltip: its whole name (a row may cut it) over its folder, which no row shows. */
export function ProjectTipText({ name, root }: { name: string; root: string }) {
  return (
    <span className="ib-tip-proj" data-project-tip="">
      <bdi className="ib-tip-name">{name}</bdi>
      <span className="ib-tip-path" dir="ltr">
        {root}
      </span>
    </span>
  );
}
