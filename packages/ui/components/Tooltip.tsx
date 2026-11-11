import React from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';

/**
 * One tooltip timing for every surface: open after 150 ms of rest, and open the next one at once
 * for 400 ms after one closes.
 */
export const TOOLTIP_DELAY_MS = 150;
export const TOOLTIP_SKIP_DELAY_MS = 400;

interface TooltipProviderContextValue {
  disableHoverablePopup: boolean;
}

const TooltipProviderContext = React.createContext<TooltipProviderContextValue | null>(null);

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
}) => {
  // One object per setting, so tooltips behind a memo boundary don't re-render with the provider.
  const value = React.useMemo(() => ({ disableHoverablePopup: disableHoverableContent }), [disableHoverableContent]);
  return (
    <BaseTooltip.Provider delay={delayDuration ?? TOOLTIP_DELAY_MS} timeout={skipDelayDuration ?? TOOLTIP_SKIP_DELAY_MS}>
      <TooltipProviderContext.Provider value={value}>{children}</TooltipProviderContext.Provider>
    </BaseTooltip.Provider>
  );
};

/**
 * True under a host where Escape belongs to the page: every Tooltip below acts as if it had
 * `escapePassesThrough`.
 */
export const TooltipEscapePassesThrough = React.createContext(false);

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  delayDuration?: number;
  sideOffset?: number;
  wide?: boolean;
  shouldOpen?: (trigger: Element) => boolean;
  container?: HTMLElement | null;
  escapePassesThrough?: boolean;
  forceOpen?: boolean;
}

/**
 * The trigger element is the same either way, so layout, text and accessible names do not
 * change; arming mounts a new copy of it.
 */
export const TooltipArmed = React.createContext(true);

export const Tooltip: React.FC<TooltipProps> = (props) => {
  const armed = React.useContext(TooltipArmed);
  if (!armed && !props.forceOpen) return props.children;
  return <ArmedTooltip {...props} />;
};

const ArmedTooltip: React.FC<TooltipProps> = ({
  content,
  children,
  side = 'top',
  align = 'center',
  delayDuration,
  sideOffset = 8,
  wide = false,
  shouldOpen,
  container,
  escapePassesThrough: passesThroughProp = false,
  forceOpen,
}) => {
  const provider = React.useContext(TooltipProviderContext);
  const passesThroughHere = React.useContext(TooltipEscapePassesThrough);
  const escapePassesThrough = passesThroughProp || passesThroughHere;
  const disableHoverablePopup = provider?.disableHoverablePopup ?? false;
  const triggerDelay = delayDuration ?? (provider ? undefined : TOOLTIP_DELAY_MS);
  const [controlledOpen, setControlledOpen] = React.useState(false);
  const controlledMode = escapePassesThrough || forceOpen !== undefined;
  const controlled = controlledMode ? { open: controlledOpen || forceOpen === true } : {};
  return (
    <BaseTooltip.Root
      disableHoverablePopup={disableHoverablePopup}
      {...controlled}
      onOpenChange={
        shouldOpen || controlledMode
          ? (open, details) => {
              if (open && shouldOpen && !(details.trigger && shouldOpen(details.trigger))) {
                details.cancel();
                return;
              }
              if (!controlledMode) return;
              if (escapePassesThrough && !open && details.reason === 'escape-key') {
                details.cancel();
                details.allowPropagation();
              }
              setControlledOpen(open);
            }
          : undefined
      }
    >
      <BaseTooltip.Trigger render={children} delay={triggerDelay} />
      <BaseTooltip.Portal container={container ?? undefined}>
        {/* Above the annotation toolbar (z-[100]), so a tooltip that flips toward it is never tucked under it. */}
        <BaseTooltip.Positioner side={side} align={align} sideOffset={sideOffset} className="isolate z-[110]">
          <BaseTooltip.Popup
            data-pn-tooltip=""
            className={`z-[110] px-2 py-1 text-xs bg-popover text-popover-foreground border border-transparent rounded shadow-[var(--float-shadow)] origin-[var(--transform-origin)] transition-[opacity,scale] duration-150 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95 ${
              wide
                ? 'max-w-[min(260px,calc(100vw-1rem))] leading-snug whitespace-normal [overflow-wrap:anywhere]'
                : 'whitespace-nowrap'
            }`}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
};
