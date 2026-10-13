import React, { useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import type { MarkdownFileView } from '../utils/markdownPreview';

/**
 * One control per Markdown file: a header button naming the view the file is
 * shown in, opening a menu Source / Changes / Read (approved "Menu" variant,
 * 2026-10-12 controls amendment). On a phone the same button (44 px hit area)
 * opens the same menu as a bottom sheet, with the same words in the same
 * order. Kept out of FileHeader so the guides.show viewer, which renders
 * FileHeader read-only, never carries it.
 */

const LABEL: Record<MarkdownFileView, string> = { source: 'Source', changes: 'Changes', read: 'Read' };

function describe(view: MarkdownFileView, status: MarkdownViewMenuProps['status']): string {
  if (view === 'source') return 'The line diff · comment on lines';
  if (view === 'changes') return 'Rendered, changes marked · select to comment';
  if (status === 'deleted') return 'The deleted version, rendered · select to comment';
  if (status === 'added') return 'The new file, rendered · select to comment';
  return 'The new version, rendered · select to comment';
}

function ViewIcon({ view, className }: { view: MarkdownFileView; className: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {view === 'source' && <path d="m8 6-6 6 6 6M16 6l6 6-6 6" />}
      {view === 'changes' && <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM9 10h6M12 7v6M9 17h6" />}
      {view === 'read' && <path d="M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />}
    </svg>
  );
}

export interface MarkdownViewMenuProps {
  /** The file's path (named by the phone sheet and the accessible label). */
  filePath: string;
  view: MarkdownFileView;
  /** What this file offers (added / deleted: Source and Read). */
  views: readonly MarkdownFileView[];
  onChoose: (view: MarkdownFileView) => void;
  status?: 'added' | 'deleted' | 'renamed' | 'modified';
  /** A tight desktop header: the icon alone (the name stays in the label and tooltip). */
  iconOnly?: boolean;
  /** The compact touch shell: a 44 px button and a bottom sheet. */
  touch?: boolean;
  /** Set while the view cannot change (the file holds the edit session): the button is disabled and says why. */
  disabledReason?: string | null;
}

export const MarkdownViewMenu: React.FC<MarkdownViewMenuProps> = ({
  filePath,
  view,
  views,
  onChoose,
  status,
  iconOnly = false,
  touch = false,
  disabledReason = null,
}) => {
  const [open, setOpen] = useState(false);
  const rendered = view !== 'source';
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const title = disabledReason
    ? disabledReason
    : rendered
    ? `Showing ${LABEL[view]}. Select text to comment. P: next view`
    : 'Show this Markdown file as Source, Changes or Read. P: next view';

  const trigger = touch ? (
    // Drawn 36 px; the ::after box makes the hit area 44 px (4 px past each
    // edge), which the 44 px compact header leaves room for.
    <button
      type="button"
      className={`relative ml-1 flex h-9 flex-none items-center gap-1 rounded-md px-2 text-xs transition-colors after:absolute after:-inset-1 after:content-[''] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:opacity-50 ${
        rendered ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
      }`}
    />
  ) : (
    <button
      type="button"
      className={`flex flex-none items-center gap-1 rounded-md border text-xs leading-none transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 data-[popup-open]:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ${
        iconOnly ? 'px-1.5 py-[3px]' : 'px-2 py-[3px]'
      } ${
        rendered
          ? 'border-primary/40 bg-primary/10 text-primary data-[popup-open]:bg-primary/15'
          : 'border-border/70 text-muted-foreground hover:text-foreground hover:bg-muted'
      }`}
    />
  );

  return (
    <Menu.Root open={open && !disabledReason} onOpenChange={setOpen} modal={touch} disabled={!!disabledReason}>
      <Menu.Trigger
        render={trigger}
        disabled={!!disabledReason}
        data-markdown-view-menu=""
        data-markdown-view={view}
        aria-label={`${LABEL[view]} view of ${name}`}
        title={touch && !disabledReason ? undefined : title}
        // The header row toggles the file's collapse on click.
        onClick={(event) => event.stopPropagation()}
      >
        <ViewIcon view={view} className="h-3.5 w-3.5 flex-none" />
        {!iconOnly && <span>{LABEL[view]}</span>}
        <svg className="h-3 w-3 flex-none opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
        </svg>
      </Menu.Trigger>
      <Menu.Portal>
        {touch && (
          <Menu.Backdrop className="fixed inset-0 z-[110] bg-black/40 transition-opacity duration-200 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        )}
        <Menu.Positioner
          side="bottom"
          align="end"
          sideOffset={4}
          className={touch
            // The sheet ignores the anchor: pinned to the bottom edge, full width.
            ? 'z-[111] !fixed !inset-x-0 !bottom-0 !left-0 !top-auto !w-full !transform-none outline-none'
            : 'z-50 outline-none'}
        >
          <Menu.Popup
            data-markdown-view-popup={touch ? 'sheet' : 'menu'}
            className={touch
              ? 'w-full rounded-t-2xl border-t border-border bg-popover px-2 pt-2 pb-[max(env(safe-area-inset-bottom),12px)] text-popover-foreground shadow-[0_-12px_40px_-16px_rgba(15,23,42,0.45)] outline-none transition-[transform,opacity] duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-safe:data-[ending-style]:translate-y-full motion-safe:data-[starting-style]:translate-y-full'
              : 'w-96 max-w-[calc(100vw-16px)] origin-[var(--transform-origin)] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none transition-[opacity,scale] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0'}
          >
            {touch && <div aria-hidden="true" className="mx-auto mb-2 h-1 w-9 rounded-full bg-muted-foreground/30" />}
            <Menu.RadioGroup
              value={view}
              onValueChange={(value) => {
                if (value !== view) onChoose(value as MarkdownFileView);
              }}
            >
              {touch && (
                <Menu.GroupLabel className="truncate px-3 pb-1 pt-0.5 text-sm text-muted-foreground">
                  Show {name} as
                </Menu.GroupLabel>
              )}
              {views.map((option) => (
                <Menu.RadioItem
                  key={option}
                  value={option}
                  label={LABEL[option]}
                  closeOnClick
                  data-markdown-view-option={option}
                  className={`flex cursor-default select-none items-start gap-2.5 rounded-md outline-none data-[highlighted]:bg-muted ${
                    touch ? 'min-h-14 px-3 py-2.5' : 'px-2.5 py-2'
                  }`}
                >
                  <ViewIcon view={option} className={`flex-none text-muted-foreground ${touch ? 'mt-0.5 h-[18px] w-[18px]' : 'mt-px h-4 w-4'}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block font-medium text-foreground ${touch ? 'text-base' : 'text-xs'}`}>{LABEL[option]}</span>
                    <span className={`mt-0.5 block text-muted-foreground ${touch ? 'text-sm' : 'text-[11px] leading-snug'}`}>
                      {describe(option, status)}
                    </span>
                  </span>
                  <Menu.RadioItemIndicator className="flex-none self-center text-primary">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.25} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M20 6 9 17l-5-5" />
                    </svg>
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            {!touch && (
              <div aria-hidden="true" className="mt-1 border-t border-border/60 px-2.5 pb-1 pt-2 text-[11px] text-muted-foreground">
                <kbd className="mr-1 rounded border border-border bg-muted px-1 font-mono text-[10px] text-foreground">P</kbd>
                next view · files you have not set follow your choice
              </div>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
};
