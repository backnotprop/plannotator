import React from 'react';
import { Button } from '@plannotator/ui/components/ui/button';

export function FolderAnnotationEmptyState({
  compactTouchLayout,
  onChooseFile,
}: {
  compactTouchLayout: boolean;
  onChooseFile: () => void;
}) {
  return (
    <div className="w-full flex justify-center">
      <div className="w-full max-w-3xl p-12 text-center text-muted-foreground">
        <p className="text-lg font-medium mb-2">Select a file to annotate</p>
        <p className="text-sm">
          {compactTouchLayout
            ? 'Choose a markdown, text, or HTML file to begin.'
            : 'Pick a markdown or HTML file from the sidebar to begin.'}
        </p>
        {compactTouchLayout && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={onChooseFile}
          >
            Choose a file
          </Button>
        )}
      </div>
    </div>
  );
}
