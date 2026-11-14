import React from 'react';
import { Menu } from '@base-ui/react/menu';
import { ChevronDown } from 'lucide-react';


export type ChangedFileView = 'changes' | 'whole' | 'original';

const LABELS: Record<ChangedFileView, { label: string; title: string }> = {
  changes: { label: 'Diff', title: 'The diff' },
  whole: { label: 'Current', title: "The whole file at the diff's new side, with change bars" },
  original: { label: 'Original', title: "The whole file at the diff's old side, with the removed lines marked" },
};

export const FileViewSwitch: React.FC<{
  view: ChangedFileView;
  onSelect: (view: ChangedFileView) => void;
  wholeUnavailableReason?: string | null;
  originalUnavailableReason?: string | null;
}> = ({ view, onSelect, wholeUnavailableReason, originalUnavailableReason }) => {
  const segment = (key: ChangedFileView) => {
    const reason = key === 'whole' ? wholeUnavailableReason : key === 'original' ? originalUnavailableReason : null;
    const disabled = !!reason;
    return (
      <button
        key={key}
        type="button"
        data-file-view={key}
        aria-pressed={view === key}
        disabled={disabled}
        title={disabled ? reason ?? undefined : LABELS[key].title}
        onClick={() => onSelect(key)}
        className={`px-2 py-0.5 rounded-sm text-xs whitespace-nowrap transition-colors ${
          view === key ? 'bg-background text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {LABELS[key].label}
      </button>
    );
  };
  const reasonOf = (key: ChangedFileView) => (key === 'whole' ? wholeUnavailableReason : key === 'original' ? originalUnavailableReason : null);
  return (
    <>
      <div className="flex-none flex items-center bg-muted/50 rounded p-0.5 mr-1 @max-[600px]/file-header:hidden" role="group" aria-label="File view" data-file-view-switch>
        {segment('changes')}
        {segment('whole')}
        {segment('original')}
      </div>
      <Menu.Root>
        <Menu.Trigger
          data-file-view-menu=""
          aria-label={`File view: ${LABELS[view].label}`}
          className="hidden @max-[600px]/file-header:flex flex-none items-center gap-0.5 h-6 px-1.5 mr-1 rounded text-xs font-medium bg-muted/50 text-foreground hover:bg-muted"
        >
          {LABELS[view].label}
          <ChevronDown className="w-3 h-3 text-muted-foreground" aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4} align="end" className="z-[110] outline-none">
            <Menu.Popup className="min-w-[9rem] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
              {(['changes', 'whole', 'original'] as const).map((key) => (
                <Menu.Item
                  key={key}
                  disabled={!!reasonOf(key)}
                  onClick={() => onSelect(key)}
                  data-file-view-option={key}
                  title={reasonOf(key) ?? LABELS[key].title}
                  className={`h-7 flex items-center px-2 rounded-md text-xs outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-40 ${view === key ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
                >
                  {LABELS[key].label}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </>
  );
};
