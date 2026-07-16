import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useConfigValue, setReviewPanelView, setReviewDefaultDiffType } from '@plannotator/ui/config';
import { TextShimmer } from '@plannotator/ui/components/TextShimmer';
import workspacesImg from '@plannotator/ui/assets/workspaces.webp';
import sectionsImg from '@plannotator/ui/assets/review-sections.png';
import treeImg from '@plannotator/ui/assets/review-tree.png';

/**
 * Code-review setup chooser — same shell/structure as the plan app's
 * LookAndFeelAnnouncementDialog. Left: which panel view a review opens in
 * (git-status Sections vs the classic Tree), as hover-expandable screenshots.
 * Right: the default diff type (including the composite "All changes"). Footer
 * carries the shared "Workspaces are coming" teaser page.
 *
 * Self-contained: reads/writes the configStore directly so it works both as a
 * first-run dialog and from the Settings panel.
 *
 * Coupling rule — the Sections view is DEFINED by the since-base diff, so:
 *   Sections view  ⟺  defaultDiffType === 'since-base'
 * Tree view can show any diff (including since-base, i.e. a tree of the
 * everything-set). The setters below keep the two settings consistent.
 */

interface ReviewSetupDialogProps {
  isOpen: boolean;
  onDismiss: () => void;
}

const WAITLIST_URL = 'https://plannotator.ai/workspaces';

type DiffChoice = 'since-base' | 'uncommitted' | 'unstaged' | 'staged' | 'merge-base' | 'all';

const DIFF_OPTIONS: { value: DiffChoice; label: string; tag?: string; desc: string }[] = [
  // "All changes" belongs to since-base (the flagship composite); uncommitted
  // keeps its plain name so the two stay distinguishable side by side.
  { value: 'since-base', label: 'All changes', tag: 'New', desc: 'Everything since your branch left main — committed, uncommitted, and untracked.' },
  { value: 'uncommitted', label: 'Uncommitted', desc: "Everything you've changed since your last commit." },
  { value: 'unstaged', label: 'Unstaged', desc: "Only changes you haven't staged yet." },
  { value: 'staged', label: 'Staged', desc: "Only changes you've staged for commit." },
  { value: 'merge-base', label: 'Committed changes (PR view)', desc: 'Commits on this branch vs the base — the literal PR view.' },
  { value: 'all', label: 'All files (HEAD)', desc: 'Every tracked file at HEAD, shown as additions.' },
];

const VIEW_OPTIONS: { key: 'sections' | 'tree'; img: string; title: string; tag: string; desc: string }[] = [
  {
    key: 'sections',
    img: sectionsImg,
    title: 'Git status',
    tag: 'New',
    desc: 'Committed, Changes, and Untracked — grouped like git status.',
  },
  {
    key: 'tree',
    img: treeImg,
    title: 'Tree',
    tag: 'Classic',
    desc: 'The familiar folder tree of changed files.',
  },
];

export const ReviewSetupDialog: React.FC<ReviewSetupDialogProps> = ({ isOpen, onDismiss }) => {
  const [page, setPage] = useState<1 | 2>(1);
  const [hovered, setHovered] = useState<string | null>(null);
  const panelView = useConfigValue('reviewPanelView');
  const defaultDiffType = useConfigValue('defaultDiffType');

  if (!isOpen) return null;

  // Coupling (sections ⟺ since-base) lives in the shared setters — never
  // write the pair by hand (see @plannotator/ui/config/reviewView).
  const chooseView = (key: 'sections' | 'tree') => setReviewPanelView(key);
  const chooseDiff = (value: DiffChoice) => setReviewDefaultDiffType(value);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-5xl h-[800px] max-h-[calc(100vh-2rem)] shadow-2xl flex flex-col">
        {page === 1 ? (
          <>
            {/* Header */}
            <div className="p-7 border-b border-border">
              <h3 className="font-semibold text-2xl mb-1.5">Set up your review view</h3>
              <p className="text-sm text-muted-foreground max-w-3xl">
                A simpler review, closer to what you'd see on GitHub. We recommend the{' '}
                <span className="text-foreground font-medium">Git status</span> view defaulting to{' '}
                <span className="text-foreground font-medium">All changes</span> — every local change
                since <span className="font-mono">origin/main</span>. It isn't a literal PR (only
                committed work lands in one — pick <span className="text-foreground font-medium">Committed changes</span>{' '}
                for that), but it gives you the whole local picture. Switch anytime, or change these later in Settings.
              </p>
            </div>

            {/* Body: view cards (left) + diff type (right) */}
            <div className="px-7 pt-6 flex-1 min-h-0 flex gap-8">
              {/* Left — default view (screenshots, hover to expand) */}
              <div className="flex-[3] min-w-0 flex flex-col">
                <div className="text-sm font-medium mb-3">Default view</div>
                <div className="flex gap-5">
                  {VIEW_OPTIONS.map((opt) => {
                    const selected = panelView === opt.key;
                    const isHovered = hovered === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => chooseView(opt.key)}
                        onMouseEnter={() => setHovered(opt.key)}
                        onMouseLeave={() => setHovered((h) => (h === opt.key ? null : h))}
                        aria-pressed={selected}
                        className={`flex-1 min-w-0 flex flex-col items-stretch gap-2 rounded-lg border p-2 text-left transition-colors ${
                          selected ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                        }`}
                      >
                        <div className="relative overflow-visible">
                          <img
                            src={opt.img}
                            alt={`${opt.title} view`}
                            className="w-full rounded-md select-none object-cover object-top"
                            draggable={false}
                            style={{
                              height: 340,
                              border: `2px solid ${
                                selected ? 'var(--primary)' : 'color-mix(in srgb, var(--primary) 25%, transparent)'
                              }`,
                              transform: isHovered ? 'scale(1.35)' : 'scale(1)',
                              transformOrigin: 'top center',
                              zIndex: isHovered ? 50 : 0,
                              position: 'relative',
                              boxShadow: isHovered ? '0 18px 44px rgba(0,0,0,0.45)' : 'none',
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

              {/* Right — default diff type */}
              <div className="flex-[2] min-w-0 flex flex-col">
                <div className="text-sm font-medium mb-3">Default diff</div>
                <div className="flex flex-col gap-2 overflow-auto pr-1">
                  {DIFF_OPTIONS.map((opt) => {
                    const selected = defaultDiffType === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => chooseDiff(opt.value)}
                        className={`w-full flex items-start gap-3 p-2.5 rounded-lg border text-left transition-colors ${
                          selected ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/30 hover:bg-muted/40'
                        }`}
                      >
                        <span
                          className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                            selected ? 'border-primary' : 'border-muted-foreground/40'
                          }`}
                        >
                          {selected && <span className="w-2 h-2 rounded-full bg-primary" />}
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-medium">{opt.label}</span>
                            {opt.tag && (
                              <span
                                className={`text-[10px] leading-none px-1.5 py-0.5 rounded-full ${
                                  selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                                }`}
                              >
                                {opt.tag}
                              </span>
                            )}
                          </span>
                          <span className="block text-xs text-muted-foreground leading-snug mt-0.5">{opt.desc}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
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
            <div className="flex-1 min-h-0 p-6 flex items-center justify-center">
              <img
                src={workspacesImg}
                alt="Plannotator Workspaces, a shared context workspace across your agents"
                className="max-h-full max-w-full w-auto object-contain rounded-lg border border-border select-none"
                draggable={false}
              />
            </div>
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
