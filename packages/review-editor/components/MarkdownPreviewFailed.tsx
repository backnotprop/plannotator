import React from 'react';

/** The preview's chunk could not load (`LazyBlockBoundary`): the same box, saying so. */
export const MarkdownPreviewFailed: React.FC<{ notice: React.ReactNode }> = ({ notice }) => (
  <div className="min-h-full px-4 py-4 sm:px-6" data-markdown-preview="" data-markdown-preview-view="failed">
    <div className="mx-auto max-w-3xl rounded-md border border-border/60 bg-muted/20 p-4 [&>[role=status]]:mb-0">
      {notice}
    </div>
  </div>
);
