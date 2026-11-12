import React from 'react';
import { Tooltip } from './Tooltip';
import { isTextCut, noHover } from '../utils/textCut';

let componentTooltips = false;

export function setComponentTooltips(on: boolean): void {
  componentTooltips = on;
}

export function resetComponentTooltips(): void {
  componentTooltips = false;
}

export function getComponentTooltips(): boolean {
  return componentTooltips;
}

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
      <span id={descriptionId} hidden data-host-title-description="">
        {title}
      </span>
    </>
  );
}
