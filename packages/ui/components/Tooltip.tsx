import React from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';

/**
 * One tooltip timing for every surface (owner's design-system ruling q4): open
 * after 150 ms of rest, and open the next one at once for 400 ms after one
 * closes. A host's own `TooltipProvider` props, or a trigger's
 * `delayDuration`, still win.
 */
export const TOOLTIP_DELAY_MS = 150;
export const TOOLTIP_SKIP_DELAY_MS = 400;

interface TooltipProviderContextValue {
  disableHoverablePopup: boolean;
}

/** Null outside a `TooltipProvider`: a lone Tooltip then sets its own 150 ms (Base UI's own default is 600). */
const TooltipProviderContext = React.createContext<TooltipProviderContextValue | null>(null);

/**
 * TooltipProvider keeps the Radix-era prop names (`delayDuration`,
 * `skipDelayDuration`, `disableHoverableContent`) as its public API and maps
 * them onto Base UI's Provider (`delay`, `timeout`) — call sites in the apps
 * stay unchanged. `disableHoverableContent` has no provider-level equivalent
 * in Base UI (it moved to per-root `disableHoverablePopup`), so it is carried
 * via context and applied to every Tooltip root under the provider.
 */
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
  /**
   * Asked each time the tooltip would open, with the trigger element; `false`
   * keeps it closed this time (e.g. open only while the trigger's text is cut
   * off). Unset: it always opens, as before.
   */
  shouldOpen?: (trigger: Element) => boolean;
  /**
   * Where the popup is portaled. Unset: the document body. A trigger inside a
   * native modal `<dialog>` needs the dialog here, or the popup is drawn
   * under the dialog's top layer.
   */
  container?: HTMLElement | null;
  /**
   * When true, Escape closes the tooltip without using the key up: it still
   * reaches the page (not default-prevented, not stopped), so the page's own
   * Escape (closing a pane) works while a tooltip is open. Unset: Base UI's
   * default, where the Escape that closes a tooltip goes no further.
   */
  escapePassesThrough?: boolean;
  /**
   * When true, the tooltip is shown whatever the pointer does: a host shows
   * it while the element that holds the trigger has keyboard focus (the
   * Inbox's row badges). False or unset: hover and focus on the trigger decide,
   * as before.
   */
  forceOpen?: boolean;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  side = 'top',
  align = 'center',
  delayDuration,
  sideOffset = 8,
  wide = false,
  shouldOpen,
  container,
  escapePassesThrough = false,
  forceOpen,
}) => {
  const provider = React.useContext(TooltipProviderContext);
  const disableHoverablePopup = provider?.disableHoverablePopup ?? false;
  // Under a provider, an unset delay takes the provider's; alone, the shared default.
  const triggerDelay = delayDuration ?? (provider ? undefined : TOOLTIP_DELAY_MS);
  // Controlled for escapePassesThrough (the Escape close is canceled, so Base UI neither prevents nor stops the
  // key, and the tooltip is closed here instead) and for forceOpen (shown on top of what hover decides).
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
          {/* A borderless float (owner's design-system ruling q4): the shadow (--float-shadow, theme.css) separates
              it from the page. The 1px border stays, transparent, so forced colors (Windows High Contrast), which
              drop shadows and paint borders in the system colour, still draw its edge. */}
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
