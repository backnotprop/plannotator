import React from 'react';
import { ListTree } from 'lucide-react';

export function CallTreeHunkEntry({ title, onOpen }: { readonly title: string; readonly onOpen: () => void }) {
  return (
    <div className="call-tree-hunk-entry-line">
      <button
        type="button"
        className="call-tree-hunk-entry"
        onClick={onOpen}
        aria-label={`Call tree ${title}`}
      >
        <ListTree aria-hidden="true" size={12} strokeWidth={2} />
        <span>Call tree</span>
        <span className="call-tree-hunk-entry-name">{title}</span>
      </button>
    </div>
  );
}
