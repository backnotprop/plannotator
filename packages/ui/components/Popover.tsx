import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import React from 'react';

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  HTMLDivElement,
  PopoverPrimitive.Popup.Props &
    Pick<PopoverPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align' | 'alignOffset'>
>(({ className, side, align = 'center', sideOffset = 6, alignOffset, children, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Positioner
      side={side}
      align={align}
      sideOffset={sideOffset}
      alignOffset={alignOffset}
      className="isolate z-[100]"
    >
      <PopoverPrimitive.Popup
        ref={ref}
        className={`bg-popover text-popover-foreground border border-border/50 rounded-lg shadow-xl z-[100] outline-none popover-enter ${className ?? ''}`}
        {...props}
      >
        {children}
      </PopoverPrimitive.Popup>
    </PopoverPrimitive.Positioner>
  </PopoverPrimitive.Portal>
));

PopoverContent.displayName = 'PopoverContent';

export { Popover, PopoverTrigger, PopoverContent };
