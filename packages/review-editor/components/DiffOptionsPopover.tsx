import React from 'react';
import { DiffDisplayOptionsPopover } from '@plannotator/ui/components/DiffDisplayOptions';

interface DiffOptionsPopoverProps {
  compactTouchLayout?: boolean;
}

/**
 * Code review's "Diff display" gear: ui's DiffDisplayOptionsPopover with every row, Whole file and Hide whitespace
 * included (code review has the repository). Split / Unified is the strip's own button (ReviewDockRightActions).
 */
export const DiffOptionsPopover: React.FC<DiffOptionsPopoverProps> = ({ compactTouchLayout = false }) => (
  <DiffDisplayOptionsPopover compactTouchLayout={compactTouchLayout} />
);
