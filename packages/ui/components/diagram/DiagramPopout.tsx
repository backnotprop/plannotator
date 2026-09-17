import { Code } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/utils';
import { PopoutDialog } from '../PopoutDialog';
import { Button } from '../ui/button';
import { DiagramViewer, type DiagramViewerProps } from './DiagramViewer';

/**
 * The diagram at full size over the document: the SAME `DiagramViewer` the
 * fence renders inline, in the `TablePopout` chrome (a non-modal Base UI
 * dialog with the dark scrim; annotation toolbars that portal outside it
 * stay interactive). One code path: everything the popout can do, the
 * inline canvas can do, only larger. The canvas takes the keyboard on
 * arrival so `+`, `-`, `0` and Escape work without a click; Escape walks
 * the viewer's ladder first (a draft, a selection) and closes the popout
 * only when nothing else is left to close.
 */
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
  /** The dialog's accessible name and the header label. */
  title: string;
  /** Portal target; null falls back to body. */
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
      className="h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none"
      dataAttributes={{ 'data-diagram-popout': '', ...dataAttributes }}
    >
      {/* The popout's own chrome: a press here addresses no diagram part
          (see diagram/diagramControls). */}
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
        {/* The popout owns the screen: every touch drag is a pan. */}
        <DiagramViewer {...viewer} sourceOpen={sourceOpen} onDismiss={onClose} autoFocus canvasClassName="touch-none" />
      </div>
    </PopoutDialog>
  );
}
