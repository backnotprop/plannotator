import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import React from 'react';

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

/**
 * `anchor`: an element the content points at other than a Trigger (one the host drew itself, such as a mark inside a
 * diff's shadow root); the host then holds the Root's `open`. `container`: where it portals (default: the body).
 */
const PopoverContent = React.forwardRef<
  HTMLDivElement,
  PopoverPrimitive.Popup.Props &
    Pick<PopoverPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align' | 'alignOffset' | 'anchor' | 'collisionPadding'> &
    Pick<PopoverPrimitive.Portal.Props, 'container'>
>(({ className, side, align = 'center', sideOffset = 6, alignOffset, anchor, collisionPadding, container, children, ...props }, ref) => (
  <PopoverPrimitive.Portal container={container}>
    <PopoverPrimitive.Positioner
      side={side}
      align={align}
      sideOffset={sideOffset}
      alignOffset={alignOffset}
      anchor={anchor}
      collisionPadding={collisionPadding}
      className="isolate z-[100]"
    >
      <PopoverPrimitive.Popup
        ref={ref}
        className={`bg-popover text-popover-foreground border border-border/50 rounded-lg shadow-xl z-[100] outline-none origin-[var(--transform-origin)] transition-[opacity,scale] duration-150 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95 ${className ?? ''}`}
        {...props}
      >
        {children}
      </PopoverPrimitive.Popup>
    </PopoverPrimitive.Positioner>
  </PopoverPrimitive.Portal>
));

PopoverContent.displayName = 'PopoverContent';

export { Popover, PopoverTrigger, PopoverContent };
