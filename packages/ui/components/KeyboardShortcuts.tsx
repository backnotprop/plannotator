import React from 'react';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/* ─── Key cap component ─── */

const Kbd: React.FC<{ children: React.ReactNode; wide?: boolean }> = ({ children, wide }) => (
  <kbd
    className={`inline-flex items-center justify-center h-[22px] ${
      wide ? 'min-w-[22px] px-1.5' : 'min-w-[22px]'
    } rounded bg-muted border border-border/60 border-b-[2px] text-[11px] font-mono leading-none text-foreground/80 shadow-sm`}
  >
    {children}
  </kbd>
);

/* ─── Key combo renderer ─── */

const Keys: React.FC<{ keys: string[] }> = ({ keys }) => (
  <span className="inline-flex items-center gap-0.5">
    {keys.map((k, i) => (
      <Kbd key={i} wide={k.length > 1}>{k}</Kbd>
    ))}
  </span>
);

/* ─── Shortcut row ─── */

const ShortcutRow: React.FC<{ keys: string[]; desc: string; hint?: string }> = ({ keys, desc, hint }) => (
  <div className="flex items-center justify-between py-1">
    <span className="text-xs text-muted-foreground">
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
    <Keys keys={keys} />
  </div>
);

/* ─── Section ─── */

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-0.5">
    <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5">
      {title}
    </div>
    {children}
  </div>
);

/* ─── Platform-aware key names ─── */

const mod = isMac ? '⌘' : 'Ctrl';
const enter = isMac ? '⏎' : '↵';

/* ─── Shortcut data ─── */

interface Shortcut {
  keys: string[];
  desc: string;
  hint?: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: Shortcut[];
}

const alt = isMac ? '⌥' : 'Alt';

const planShortcuts: ShortcutSection[] = [
  {
    title: 'Actions',
    shortcuts: [
      { keys: [mod, enter], desc: 'Submit / Approve' },
      { keys: [mod, 'S'], desc: 'Save to notes app' },
      { keys: ['Esc'], desc: 'Close dialog' },
    ],
  },
  {
    title: 'Input Method',
    shortcuts: [
      { keys: [alt, 'hold'], desc: 'Temporarily switch mode', hint: 'Hold to switch between Select and Pinpoint, release to revert' },
      { keys: [alt, alt], desc: 'Toggle mode', hint: 'Double-tap to permanently switch between Select and Pinpoint' },
    ],
  },
  {
    title: 'Annotations',
    shortcuts: [
      { keys: ['a-z'], desc: 'Start typing comment', hint: 'When the annotation toolbar is open, any letter key opens the comment editor with that character' },
      { keys: [alt, '1-0'], desc: 'Apply quick label', hint: 'Instantly applies the Nth preset label (0 = 10th). When the label picker is open, bare digits also work.' },
      { keys: [mod, enter], desc: 'Submit comment' },
      { keys: [mod, 'C'], desc: 'Copy selected text' },
      { keys: ['Esc'], desc: 'Close toolbar / Cancel' },
    ],
  },
  {
    title: 'Image Annotator',
    shortcuts: [
      { keys: ['1'], desc: 'Pen tool' },
      { keys: ['2'], desc: 'Arrow tool' },
      { keys: ['3'], desc: 'Circle tool' },
      { keys: [mod, 'Z'], desc: 'Undo' },
      { keys: [enter], desc: 'Finish' },
      { keys: ['Esc'], desc: 'Cancel' },
    ],
  },
];

const reviewShortcuts: ShortcutSection[] = [
  {
    title: 'Actions',
    shortcuts: [
      { keys: [mod, enter], desc: 'Approve / Send feedback' },
      { keys: [alt, alt], desc: 'Toggle destination', hint: 'Double-tap to switch between GitHub and Agent in PR review mode' },
      { keys: [mod, '⇧', 'C'], desc: 'Toggle comment mode' },
      { keys: ['Esc'], desc: 'Collapse sidebar' },
    ],
  },
  {
    title: 'File Navigation',
    shortcuts: [
      { keys: ['J'], desc: 'Next file' },
      { keys: ['K'], desc: 'Previous file' },
      { keys: ['Home'], desc: 'First file' },
      { keys: ['End'], desc: 'Last file' },
    ],
  },
  {
    title: 'Annotations',
    shortcuts: [
      { keys: [mod, enter], desc: 'Submit comment' },
      { keys: ['Tab'], desc: 'Indent in editor' },
      { keys: ['Esc'], desc: 'Close toolbar / Cancel' },
    ],
  },
];

/* ─── Exported panel ─── */

export const KeyboardShortcuts: React.FC<{ mode: 'plan' | 'review' }> = ({ mode }) => {
  const sections = mode === 'review' ? reviewShortcuts : planShortcuts;

  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <Section key={section.title} title={section.title}>
          {section.shortcuts.map((s, i) => (
            <ShortcutRow key={i} keys={s.keys} desc={s.desc} hint={s.hint} />
          ))}
        </Section>
      ))}
    </div>
  );
};
