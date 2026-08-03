/// <reference path="../globals.d.ts" />
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { TextShimmer } from './TextShimmer';
import lookGridImg from '../assets/look-grid.png';
import lookFlatImg from '../assets/look-flat.png';
import workspacesImg from '../assets/workspaces.webp';

interface LookAndFeelAnnouncementDialogProps {
  isOpen: boolean;
  /** Current value of the singleton configStore 'gridEnabled' key. */
  gridEnabled: boolean;
  /** App owns this: it calls configStore.set('gridEnabled', value). */
  onToggleGrid: (value: boolean) => void;
  /** Marks the announcement seen and closes the dialog. */
  onDismiss: () => void;
}

const WAITLIST_URL = 'https://plannotator.ai/workspaces';

const FEATURES: { title: string; desc: string }[] = [
  {
    title: 'Leaner install',
    desc: 'Only the core skills ship by default. Extra skills install separately.',
  },
  { title: 'A fresh new look', desc: 'Refreshed UI 2.0 with new Simple and Neutral themes.' },
  { title: 'Semantic code review', desc: 'Diffs grouped by what changed, not just which lines.' },
  { title: 'Multi-repo reviews', desc: 'Review nested repositories together in one pass.' },
  {
    title: 'Full-page HTML',
    desc: 'Render HTML reports and explainers full-screen, then annotate them in place.',
  },
];

const LOOK_OPTIONS: {
  key: string;
  /** gridEnabled value this option selects. */
  value: boolean;
  img: string;
  title: string;
  tag: string;
  desc: string;
}[] = [
  {
    key: 'grid',
    value: true,
    img: lookGridImg,
    title: 'Grid',
    tag: 'Classic',
    desc: 'Your plan as a floating card on grid paper.',
  },
  {
    key: 'flat',
    value: false,
    img: lookFlatImg,
    title: 'Clean',
    tag: 'New',
    desc: 'A simpler, edge-to-edge flat card.',
  },
];

export const LookAndFeelAnnouncementDialog: React.FC<LookAndFeelAnnouncementDialogProps> = ({
  isOpen,
  gridEnabled,
  onToggleGrid,
  onDismiss,
}) => {
  const [page, setPage] = useState<1 | 2>(1);
  const [hovered, setHovered] = useState<string | null>(null);
  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 backdrop-blur-sm p-4">
      {/* Fixed size across both pages; the dialog never resizes. */}
      <div className="bg-card border border-border rounded-xl w-full max-w-5xl h-[760px] shadow-2xl flex flex-col">
        {page === 1 ? (
          <>
            {/* Header */}
            <div className="p-7 border-b border-border">
              <div className="flex items-start justify-between gap-4">
                <h3 className="font-semibold text-2xl mb-1.5">Plannotator 0.20.0 is here</h3>
                <a
                  href="https://github.com/backnotprop/plannotator/releases/tag/v0.20.0"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 mt-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  Full release notes &#8599;
                </a>
              </div>
              <p className="text-sm text-muted-foreground">
                A big release. Here&apos;s what&apos;s new, plus a choice of how your plans look.
              </p>
            </div>

            {/* What's new */}
            <div className="px-7 pt-6 grid grid-cols-5 gap-3">
              {FEATURES.map((f) => (
                <div key={f.title} className="rounded-lg border border-border bg-muted/40 p-3">
                  <div className="text-sm font-semibold">{f.title}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 leading-snug">{f.desc}</div>
                </div>
              ))}
            </div>

            {/* Plan-look chooser */}
            <div className="px-7 pt-6 flex-1 min-h-0">
              <div className="text-sm font-medium mb-3">Choose your plan look</div>
              <div className="flex gap-6">
                {LOOK_OPTIONS.map((opt) => {
                  const selected = gridEnabled === opt.value;
                  const isHovered = hovered === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => onToggleGrid(opt.value)}
                      onMouseEnter={() => setHovered(opt.key)}
                      onMouseLeave={() => setHovered((h) => (h === opt.key ? null : h))}
                      aria-pressed={selected}
                      className={`flex-1 min-w-0 flex flex-col items-stretch gap-2 rounded-lg border p-2 text-left transition-colors ${
                        selected
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-muted-foreground/40'
                      }`}
                    >
                      <div className="relative">
                        <img
                          src={opt.img}
                          alt={`${opt.title} plan look`}
                          className="w-full rounded-md select-none"
                          draggable={false}
                          style={{
                            border: `2px solid ${
                              selected
                                ? 'var(--primary)'
                                : 'color-mix(in srgb, var(--primary) 25%, transparent)'
                            }`,
                            transform: isHovered ? 'scale(1.22)' : 'scale(1)',
                            transformOrigin: 'center',
                            zIndex: isHovered ? 50 : 0,
                            position: 'relative',
                            boxShadow: isHovered ? '0 14px 36px rgba(0,0,0,0.4)' : 'none',
                            transition:
                              'transform 0.25s cubic-bezier(0.34,1.56,0.64,1), border-color 0.2s ease, box-shadow 0.2s ease',
                          }}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 px-0.5 mt-1">
                        <span className="text-base font-semibold">{opt.title}</span>
                        <span
                          className={`text-[11px] leading-none px-2 py-0.5 rounded-full ${
                            selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {selected ? 'Selected' : opt.tag}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground px-0.5 leading-snug">{opt.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Footer */}
            <div className="px-7 py-5 border-t border-border flex justify-end items-center gap-4">
              <button
                type="button"
                onClick={() => setPage(2)}
                className="px-4 py-2 rounded-lg border border-primary/35 hover:opacity-80 transition-opacity"
              >
                <TextShimmer className="text-sm font-medium" duration={2.5} spread={1.5}>
                  {'✨ Workspaces are coming 🎉 →'}
                </TextShimmer>
              </button>
              <button
                onClick={onDismiss}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Got it
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Header */}
            <div className="p-7 border-b border-border">
              <h3 className="font-semibold text-2xl mb-1.5">Workspaces are coming 🎉</h3>
              <p className="text-sm text-muted-foreground">
                A shared context workspace for specs, reviews, and decisions your agents can build
                on. Join the waitlist.
              </p>
            </div>

            {/* The landscape teaser image, scaled to fit the fixed dialog. */}
            <div className="flex-1 min-h-0 p-6 flex items-center justify-center">
              <img
                src={workspacesImg}
                alt="Plannotator Workspaces, a shared context workspace across your agents"
                className="max-h-full max-w-full w-auto object-contain rounded-lg border border-border select-none"
                draggable={false}
              />
            </div>

            {/* Footer */}
            <div className="px-7 py-5 border-t border-border flex justify-end items-center gap-4">
              <button
                type="button"
                onClick={() => setPage(1)}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                &larr; Back
              </button>
              <a
                href={WAITLIST_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Join the waitlist
              </a>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};
