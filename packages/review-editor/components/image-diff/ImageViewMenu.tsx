import React, { useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  IMAGE_BACKGROUNDS,
  IMAGE_BACKGROUND_LABEL,
  IMAGE_DIFF_MODES,
  IMAGE_DIFF_MODE_LABEL,
  setImageDiffSettings,
  useImageDiffSettings,
  type ImageDiffMode,
} from './imageDiffSettings';

export type ImageViewChoice = ImageDiffMode | 'source';

const DESCRIBE: Record<ImageViewChoice, string> = {
  side: 'Before and after next to each other, same scale',
  swipe: 'Stacked exactly; drag the divider or use the arrow keys',
  onion: 'After over before; fade between them',
  source: 'The SVG as a line diff · comment on lines',
};

function ModeIcon({ mode, className }: { mode: ImageViewChoice; className: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {mode === 'side' && <path d="M3 5h7v14H3zM14 5h7v14h-7z" />}
      {mode === 'swipe' && <path d="M4 5h16v14H4zM12 3v18" />}
      {mode === 'onion' && <path d="M4 8h12v12H4zM8 4h12v12" />}
      {mode === 'source' && <path d="m8 6-6 6 6 6M16 6l6 6-6 6" />}
    </svg>
  );
}

export interface ImageViewMenuProps {
  filePath: string;
  comparable: boolean;
  differencesAvailable: boolean;
  source?: { active: boolean; onChoose: (source: boolean) => void };
  iconOnly?: boolean;
  touch?: boolean;
}

export const ImageViewMenu: React.FC<ImageViewMenuProps> = ({ filePath, comparable, differencesAvailable, source, iconOnly = false, touch = false }) => {
  const [open, setOpen] = useState(false);
  const settings = useImageDiffSettings();
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const modes: ImageDiffMode[] = comparable ? [...IMAGE_DIFF_MODES] : ['side'];
  const choice: ImageViewChoice = source?.active ? 'source' : comparable ? settings.mode : 'side';
  const label = choice === 'source' ? 'Source' : comparable ? IMAGE_DIFF_MODE_LABEL[choice] : 'Image';
  const options: ImageViewChoice[] = [...modes, ...(source ? (['source'] as const) : [])];
  const itemClass = `flex cursor-default select-none items-start gap-2.5 rounded-md outline-none data-[highlighted]:bg-muted ${touch ? 'min-h-14 px-3 py-2.5' : 'px-2.5 py-2'}`;
  const check = (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.25} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 6 9 17l-5-5" />
    </svg>
  );

  const trigger = touch ? (
    <button
      type="button"
      data-pn-touch-target=""
      className="relative ml-1 flex h-11 min-w-11 flex-none items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
    />
  ) : (
    <button
      type="button"
      className={`flex flex-none items-center gap-1 rounded-md border border-border/70 text-xs leading-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 data-[popup-open]:bg-muted ${iconOnly ? 'px-1.5 py-[3px]' : 'px-2 py-[3px]'}`}
    />
  );

  return (
    <Menu.Root open={open} onOpenChange={setOpen} modal={touch}>
      <Menu.Trigger
        render={trigger}
        data-image-view-menu=""
        data-image-view={choice}
        aria-label={`${label} view of ${name}`}
        title={touch ? undefined : `Show ${name} as ${modes.map((m) => IMAGE_DIFF_MODE_LABEL[m]).join(', ')}${source ? ' or Source' : ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        <ModeIcon mode={choice} className="h-3.5 w-3.5 flex-none" />
        {!iconOnly && <span>{label}</span>}
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
          className={touch ? 'z-[111] !fixed !inset-x-0 !bottom-0 !left-0 !top-auto !w-full !transform-none outline-none' : 'z-50 outline-none'}
        >
          <Menu.Popup
            data-image-view-popup={touch ? 'sheet' : 'menu'}
            className={touch
              ? 'w-full rounded-t-[12px] border-t border-border bg-popover px-2 pt-2 pb-[max(env(safe-area-inset-bottom),12px)] text-popover-foreground outline-none transition-[transform,opacity] duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-safe:data-[ending-style]:translate-y-full motion-safe:data-[starting-style]:translate-y-full'
              : 'w-80 max-w-[calc(100vw-16px)] origin-[var(--transform-origin)] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none transition-[opacity,scale] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0'}
          >
            {touch && <div aria-hidden="true" className="mx-auto mb-2 h-1 w-9 rounded-full bg-muted-foreground/30" />}
            <Menu.RadioGroup
              value={choice}
              onValueChange={(value) => {
                const next = value as ImageViewChoice;
                if (next === 'source') source?.onChoose(true);
                else {
                  setImageDiffSettings({ mode: next });
                  if (source?.active) source.onChoose(false);
                }
              }}
            >
              {touch && <Menu.GroupLabel className="truncate px-3 pb-1 pt-0.5 text-sm text-muted-foreground">Show {name} as</Menu.GroupLabel>}
              {options.map((option) => (
                <Menu.RadioItem key={option} value={option} label={option === 'source' ? 'Source' : IMAGE_DIFF_MODE_LABEL[option]} closeOnClick data-image-view-option={option} className={itemClass}>
                  <ModeIcon mode={option} className={`flex-none text-muted-foreground ${touch ? 'mt-0.5 h-[18px] w-[18px]' : 'mt-px h-4 w-4'}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block font-medium text-foreground ${touch ? 'text-base' : 'text-xs'}`}>
                      {option === 'source' ? 'Source' : comparable ? IMAGE_DIFF_MODE_LABEL[option] : 'Image'}
                    </span>
                    <span className={`mt-0.5 block text-muted-foreground ${touch ? 'text-sm' : 'text-[11px] leading-snug'}`}>{DESCRIBE[option]}</span>
                  </span>
                  <Menu.RadioItemIndicator className="flex-none self-center text-primary">{check}</Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            {choice !== 'source' && (
              <>
                <Menu.Separator className="my-1 border-t border-border/60" />
                <Menu.CheckboxItem
                  checked={settings.zoom === 'actual'}
                  onCheckedChange={(checked) => setImageDiffSettings({ zoom: checked ? 'actual' : 'fit' })}
                  data-image-zoom-option=""
                  className={itemClass}
                >
                  <span className={`min-w-0 flex-1 font-medium text-foreground ${touch ? 'text-base' : 'text-xs'}`}>Actual size</span>
                  <Menu.CheckboxItemIndicator className="flex-none self-center text-primary">{check}</Menu.CheckboxItemIndicator>
                </Menu.CheckboxItem>
                {comparable && differencesAvailable && (
                  <Menu.CheckboxItem
                    checked={settings.differences}
                    onCheckedChange={(checked) => setImageDiffSettings({ differences: checked })}
                    data-image-differences-option=""
                    className={itemClass}
                  >
                    <span className={`min-w-0 flex-1 font-medium text-foreground ${touch ? 'text-base' : 'text-xs'}`}>Highlight differences</span>
                    <Menu.CheckboxItemIndicator className="flex-none self-center text-primary">{check}</Menu.CheckboxItemIndicator>
                  </Menu.CheckboxItem>
                )}
                <Menu.Separator className="my-1 border-t border-border/60" />
                <Menu.RadioGroup value={settings.background} onValueChange={(value) => setImageDiffSettings({ background: value as (typeof IMAGE_BACKGROUNDS)[number] })}>
                  <Menu.GroupLabel className={`px-2.5 pb-0.5 pt-1 text-muted-foreground ${touch ? 'text-sm' : 'text-[11px]'}`}>Background</Menu.GroupLabel>
                  {IMAGE_BACKGROUNDS.map((background) => (
                    <Menu.RadioItem key={background} value={background} label={IMAGE_BACKGROUND_LABEL[background]} closeOnClick={false} data-image-background-option={background} className={itemClass}>
                      <span className={`min-w-0 flex-1 font-medium text-foreground ${touch ? 'text-base' : 'text-xs'}`}>{IMAGE_BACKGROUND_LABEL[background]}</span>
                      <Menu.RadioItemIndicator className="flex-none self-center text-primary">{check}</Menu.RadioItemIndicator>
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
};
