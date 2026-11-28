import React, { useState } from 'react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';

type TooltipProps = React.ComponentProps<typeof Tooltip>;

export const LazyTooltip: React.FC<TooltipProps> = (props) => {
  const [armed, setArmed] = useState(false);
  const child = props.children as React.ReactElement<{ onPointerEnter?: (event: React.PointerEvent) => void; onFocus?: (event: React.FocusEvent) => void }>;
  if (armed) return <Tooltip {...props} />;
  return React.cloneElement(child, {
    onPointerEnter: (event: React.PointerEvent) => {
      child.props.onPointerEnter?.(event);
      setArmed(true);
    },
    onFocus: (event: React.FocusEvent) => {
      child.props.onFocus?.(event);
      setArmed(true);
    },
  });
};
