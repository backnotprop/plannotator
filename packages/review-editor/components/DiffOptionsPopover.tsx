import React from 'react';
import { DiffDisplayOptionsPopover } from '@plannotator/ui/components/DiffDisplayOptions';

interface DiffOptionsPopoverProps {
  compactTouchLayout?: boolean;
}

export const DiffOptionsPopover: React.FC<DiffOptionsPopoverProps> = ({ compactTouchLayout = false }) => (
  <DiffDisplayOptionsPopover compactTouchLayout={compactTouchLayout} />
);
