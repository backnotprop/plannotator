import React from 'react';
import { fileBasename } from '../utils/fileName';

export const FileNameChip: React.FC<{ path: string }> = ({ path }) => (
  <span
    className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary truncate max-w-[180px]"
    title={path}
  >
    {fileBasename(path)}
  </span>
);
