import React from 'react';

export const PanelEmptyState: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div data-panel-empty="" className={`px-3 py-3 text-left text-xs leading-5 text-muted-foreground${className ? ` ${className}` : ''}`}>
    {children}
  </div>
);
