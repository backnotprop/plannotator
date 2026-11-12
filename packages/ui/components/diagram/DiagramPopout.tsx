import { Code } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/utils';
import { PopoutDialog } from '../PopoutDialog';
import { Button } from '../ui/button';
import { DiagramViewer, type DiagramViewerProps } from './DiagramViewer';

export function DiagramPopout({
  open,
  onClose,
  title,
  container,
  dataAttributes,
  ...viewer
}: Omit<DiagramViewerProps, 'onDismiss' | 'autoFocus' | 'sourceOpen' | 'className' | 'canvasClassName'> & {
  open: boolean;
  onClose: () => void;
  title: string;
  container?: HTMLElement | null;
  dataAttributes?: Record<string, string>;
}) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const hasPane = viewer.onSave !== undefined;
  return (
    <PopoutDialog
      open={open}
      onClose={onClose}
      title={title}
      container={container}
      className="h-[calc(var(--pn-viewport-height,100dvh)-2rem)] w-[calc(100vw-2rem)] max-w-none"
      dataAttributes={{ 'data-diagram-popout': '', ...dataAttributes }}
    >
      <div data-diagram-control="" data-diagram-popout-chrome="" className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-4 pr-12">
        <span className="truncate text-xs font-medium text-foreground">{title}</span>
        <span className="flex-1" />
        {hasPane && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-diagram-source-toggle=""
            aria-pressed={sourceOpen}
            className={cn('shrink-0', sourceOpen && 'bg-primary/15 text-primary')}
            title={sourceOpen ? 'Close the source pane' : 'Open the diagram source beside the canvas'}
            onClick={() => setSourceOpen((value) => !value)}
          >
            <Code className="size-3.5" aria-hidden="true" />
            <span>Source</span>
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <DiagramViewer {...viewer} sourceOpen={sourceOpen} onDismiss={onClose} autoFocus canvasClassName="touch-none" />
      </div>
    </PopoutDialog>
  );
}
