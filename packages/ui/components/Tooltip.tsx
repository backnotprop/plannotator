import React from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';

export const TooltipProvider = RadixTooltip.Provider;

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  delayDuration?: number;
  sideOffset?: number;
  /**
   * When true, allow the tooltip to wrap onto multiple lines with a reasonable
   * max width. Default is single-line (nowrap) — matches the original callsites
   * that use it for short button labels.
   */
  wide?: boolean;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  side = 'top',
  align = 'center',
  delayDuration,
  sideOffset = 8,
  wide = false,
}) => (
  <RadixTooltip.Root delayDuration={delayDuration}>
    <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        side={side}
        align={align}
        sideOffset={sideOffset}
        className={`z-50 px-2 py-1 text-xs bg-popover text-popover-foreground border border-border rounded shadow-md origin-[var(--radix-tooltip-content-transform-origin)] transition-[opacity,transform] duration-150 ease-out data-[state=closed]:opacity-0 data-[state=closed]:scale-95 data-[state=delayed-open]:opacity-100 data-[state=delayed-open]:scale-100 data-[state=instant-open]:opacity-100 data-[state=instant-open]:scale-100 ${
          wide ? 'max-w-[260px] leading-snug whitespace-normal' : 'whitespace-nowrap'
        }`}
      >
        {content}
      </RadixTooltip.Content>
    </RadixTooltip.Portal>
  </RadixTooltip.Root>
);
