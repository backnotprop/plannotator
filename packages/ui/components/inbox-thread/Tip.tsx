import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
import { Tooltip, TOOLTIP_DELAY_MS } from '../Tooltip';
import { isTextCut as isTextCutIn, noHover } from '../../utils/textCut';
import { tooltipContainerOf } from '../HostTitle';

export function isTextCut(el: Element | null | undefined): boolean {
  return isTextCutIn(el, el?.classList.contains('ib-fname') ? '.ib-fname-h' : undefined);
}

export const TIP_DELAY_MS = TOOLTIP_DELAY_MS;

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
