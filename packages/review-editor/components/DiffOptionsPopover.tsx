import React from 'react';
import { DiffDisplayOptionsPopover } from '@plannotator/ui/components/DiffDisplayOptions';

interface DiffOptionsPopoverProps {
  compactTouchLayout?: boolean;
  triggerClassName?: string;
  actions?: React.ReactNode;
}

export const DiffOptionsPopover: React.FC<DiffOptionsPopoverProps> = ({ compactTouchLayout = false, triggerClassName, actions }) => (
  <DiffDisplayOptionsPopover compactTouchLayout={compactTouchLayout} triggerClassName={triggerClassName} actions={actions} />
);
