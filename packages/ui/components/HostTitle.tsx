import React from 'react';
import { Tooltip } from './Tooltip';
import { isTextCut, noHover } from '../utils/textCut';

/**
 * `name` marks a title that is also the control's accessible name (an icon button with no
 * `aria-label`): the child then gets it as its `aria-label`, so the name never depends on the
 * tooltip.
 */

let componentTooltips = false;

/** Draw ui's hover text as ui's Tooltip (true) or a native title (false, the default). */
export function setComponentTooltips(on: boolean): void {
  componentTooltips = on;
}

export function resetComponentTooltips(): void {
  componentTooltips = false;
}

export function getComponentTooltips(): boolean {
  return componentTooltips;
}

/**
 * Where a tooltip for `trigger` is portaled: the open native `<dialog>` it sits in (a popup in
 * the body is drawn under the dialog's top layer).
 */
export function tooltipContainerOf(trigger: Element): HTMLElement | null {
  return trigger.closest<HTMLElement>('dialog[open], [data-pn-tooltip-root]');
}

export function HostTitle({
  title,
  children,
  name = false,
  cut = false,
  side = 'top',
}: {
  title: string | undefined | null;
  children: React.ReactElement;
  name?: boolean;
  cut?: boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const descriptionId = React.useId();
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  if (title === undefined || title === null) return children;
  if (!componentTooltips) return React.cloneElement(children as React.ReactElement<{ title?: string }>, { title });
  if (!title) return children;
  const props = children.props as { 'aria-label'?: string; 'aria-describedby'?: string };
  const labelled = props['aria-label'] != null;
  // A title that was the control's only name becomes its aria-label.
  const asName = name && !labelled;
  const describe = !asName && !cut && props['aria-label'] !== title;
  const extra: Record<string, string> = {};
  if (asName) extra['aria-label'] = title;
  if (describe) extra['aria-describedby'] = [props['aria-describedby'], descriptionId].filter(Boolean).join(' ');
  const child = Object.keys(extra).length > 0 ? React.cloneElement(children as React.ReactElement<Record<string, string>>, extra) : children;
  const tooltip = (
    <Tooltip
      content={title}
      side={side}
      wide
      escapePassesThrough
      shouldOpen={(trigger) => {
        if (noHover() || (cut && !isTextCut(trigger))) return false;
        setContainer(tooltipContainerOf(trigger));
        return true;
      }}
      container={container}
    >
      {child}
    </Tooltip>
  );
  if (!describe) return tooltip;
  return (
    <>
      {tooltip}
      {/* `hidden`: never drawn or read in browse mode; aria-describedby still reads it. */}
      <span id={descriptionId} hidden data-host-title-description="">
        {title}
      </span>
    </>
  );
}
