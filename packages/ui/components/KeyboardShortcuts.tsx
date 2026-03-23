import React from 'react';
import {
  formatShortcutBindingTokens,
  getShortcutPlatform,
  listRegistryShortcutSections,
  type ShortcutRegistry,
} from '../shortcuts';

const Kbd: React.FC<{ children: React.ReactNode; wide?: boolean }> = ({ children, wide }) => (
  <kbd
    className={`inline-flex items-center justify-center h-[22px] ${
      wide ? 'min-w-[22px] px-1.5' : 'min-w-[22px]'
    } rounded bg-muted border border-border/60 border-b-[2px] text-[11px] font-mono leading-none text-foreground/80 shadow-sm`}
  >
    {children}
  </kbd>
);

const KeyCombo: React.FC<{ binding: string }> = ({ binding }) => {
  const keys = formatShortcutBindingTokens(binding, getShortcutPlatform());

  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((key, index) => (
        <Kbd key={`${binding}-${index}`} wide={key.length > 1}>{key}</Kbd>
      ))}
    </span>
  );
};

const ShortcutBindings: React.FC<{ bindings: string[] }> = ({ bindings }) => (
  <span className="inline-flex items-center gap-1.5 flex-wrap justify-end">
    {bindings.map((binding, index) => (
      <React.Fragment key={binding}>
        {index > 0 && <span className="text-[10px] text-muted-foreground/60">or</span>}
        <KeyCombo binding={binding} />
      </React.Fragment>
    ))}
  </span>
);

const ShortcutRow: React.FC<{ bindings: string[]; desc: string; hint?: string }> = ({ bindings, desc, hint }) => (
  <div className="flex items-center justify-between gap-4 py-1">
    <span className="text-xs text-muted-foreground min-w-0">
      {desc}
      {hint && (
        <span className="relative group ml-1 inline-flex">
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[9px] font-medium bg-muted-foreground/15 text-muted-foreground/60 cursor-default">?</span>
          <span className="absolute bottom-full left-0 mb-1.5 px-2.5 py-1.5 rounded bg-foreground text-background text-[11px] leading-snug w-[320px] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity shadow-lg z-50">
            {hint}
          </span>
        </span>
      )}
    </span>
    <ShortcutBindings bindings={bindings} />
  </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-0.5">
    <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5">
      {title}
    </div>
    {children}
  </div>
);

export const KeyboardShortcuts: React.FC<{ shortcutRegistry: ShortcutRegistry }> = ({ shortcutRegistry }) => {
  const sections = listRegistryShortcutSections(shortcutRegistry);

  if (sections.length === 0) {
    return <div className="text-xs text-muted-foreground">No shortcuts are available in this view.</div>;
  }

  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <Section key={section.title} title={section.title}>
          {section.shortcuts.map((shortcut) => (
            <ShortcutRow
              key={`${shortcut.scopeId}-${shortcut.actionId}`}
              bindings={shortcut.bindings}
              desc={shortcut.description}
              hint={shortcut.hint}
            />
          ))}
        </Section>
      ))}
    </div>
  );
};
