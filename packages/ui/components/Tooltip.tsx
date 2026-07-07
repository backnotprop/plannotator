import React from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';

/**
 * TooltipProvider keeps the Radix-era prop names (`delayDuration`,
 * `skipDelayDuration`, `disableHoverableContent`) as its public API and maps
 * them onto Base UI's Provider (`delay`, `timeout`) — call sites in the apps
 * stay unchanged. `disableHoverableContent` has no provider-level equivalent
 * in Base UI (it moved to per-root `disableHoverablePopup`), so it is carried
 * via context and applied to every Tooltip root under the provider.
 */
const DisableHoverablePopupContext = React.createContext(false);

interface TooltipProviderProps {
  delayDuration?: number;
  skipDelayDuration?: number;
  disableHoverableContent?: boolean;
  children?: React.ReactNode;
}

export const TooltipProvider: React.FC<TooltipProviderProps> = ({
  delayDuration,
  skipDelayDuration,
  disableHoverableContent = false,
  children,
}) => (
  <BaseTooltip.Provider delay={delayDuration} timeout={skipDelayDuration}>
    <DisableHoverablePopupContext.Provider value={disableHoverableContent}>
      {children}
    </DisableHoverablePopupContext.Provider>
  </BaseTooltip.Provider>
);

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
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
}) => {
  const disableHoverablePopup = React.useContext(DisableHoverablePopupContext);
  return (
    <BaseTooltip.Root disableHoverablePopup={disableHoverablePopup}>
      <BaseTooltip.Trigger render={children} delay={delayDuration} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} align={align} sideOffset={sideOffset} className="isolate z-50">
          <BaseTooltip.Popup
            className={`z-50 px-2 py-1 text-xs bg-popover text-popover-foreground border border-border rounded shadow-md origin-[var(--transform-origin)] transition-[opacity,scale] duration-150 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95 ${
              wide ? 'max-w-[260px] leading-snug whitespace-normal' : 'whitespace-nowrap'
            }`}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
};
