import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { markPlanDiffMarketingSeen } from '../../utils/planDiffMarketing';

const PREVIEW_IMAGE_URL = 'https://plannotator.ai/assets/plan-diff-preview.png';
const FEEDBACK_URL = 'https://github.com/backnotprop/plannotator/issues';

const VIDEO_URLS: Record<string, string> = {
  'claude-code': 'https://plannotator.ai/demos/plan-diff-claude-code',
  'opencode': 'https://plannotator.ai/demos/plan-diff-opencode',
  'pi': 'https://plannotator.ai/demos/plan-diff-pi',
};
const DEFAULT_VIDEO_URL = 'https://plannotator.ai/demos/plan-diff';

interface PlanDiffMarketingProps {
  isOpen: boolean;
  origin: 'claude-code' | 'opencode' | 'pi' | null;
  onComplete: () => void;
}

export const PlanDiffMarketing: React.FC<PlanDiffMarketingProps> = ({
  isOpen,
  origin,
  onComplete,
}) => {
  const [imageError, setImageError] = useState(false);
  const videoUrl = (origin && VIDEO_URLS[origin]) || DEFAULT_VIDEO_URL;

  if (!isOpen) return null;

  const handleDismiss = () => {
    markPlanDiffMarketingSeen();
    onComplete();
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-2xl shadow-2xl">
        {/* Header */}
        <div className="p-5 border-b border-border">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-primary/15">
              <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
              </svg>
            </div>
            <h3 className="font-semibold text-base">New: Plan Diff Mode</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            See exactly what changed when a coding agent revises your plan.
          </p>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Banner image */}
          {imageError ? (
            <div className="w-full aspect-[16/7] rounded-lg border border-border bg-muted/50 flex items-center justify-center">
              <div className="text-center text-muted-foreground">
                <svg className="w-8 h-8 mx-auto mb-2 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                </svg>
                <p className="text-xs">Plan Diff screenshot</p>
              </div>
            </div>
          ) : (
            <img
              src={PREVIEW_IMAGE_URL}
              alt="Plan Diff Mode preview showing visual and raw diff views"
              className="w-full rounded-lg border border-border"
              onError={() => setImageError(true)}
            />
          )}

          {/* Feature summary */}
          <div className="space-y-3 text-sm text-foreground/90">
            <div className="flex gap-2.5">
              <div className="shrink-0 mt-0.5">
                <div className="w-1.5 h-1.5 rounded-full bg-success mt-1.5" />
              </div>
              <p>
                <span className="font-medium">Two view modes</span>{' '}
                <span className="text-muted-foreground">— a rendered visual diff with color-coded borders for quick scanning, and a raw markdown diff for precision.</span>
              </p>
            </div>
            <div className="flex gap-2.5">
              <div className="shrink-0 mt-0.5">
                <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5" />
              </div>
              <p>
                <span className="font-medium">Version history</span>{' '}
                <span className="text-muted-foreground">— compare against any previous version from the sidebar. Plans are automatically versioned as your agent iterates.</span>
              </p>
            </div>
            <div className="flex gap-2.5">
              <div className="shrink-0 mt-0.5">
                <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 mt-1.5" />
              </div>
              <p>
                <span className="font-medium text-muted-foreground">Coming soon</span>{' '}
                <span className="text-muted-foreground">— cross-plan comparison across different plans in the same project.</span>
              </p>
            </div>
          </div>

          {/* Video demo link */}
          <a
            href={videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 hover:bg-muted border border-transparent hover:border-border transition-all group"
          >
            <div className="p-1.5 rounded-lg bg-primary/10 group-hover:bg-primary/20 transition-colors">
              <svg className="w-4 h-4 text-primary" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <span className="text-sm font-medium text-foreground/90">Watch Video Demo of Plan Diff</span>
            <svg className="w-3.5 h-3.5 text-muted-foreground ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
          </a>

          {/* Feedback callout */}
          <p className="text-xs text-muted-foreground leading-relaxed">
            This is the first release of Plan Diff — rough edges are expected, especially around plan name matching across sessions. If something feels off or you have ideas, open an{' '}
            <a
              href={FEEDBACK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2 hover:text-primary/80"
            >
              issue
            </a>. Let's make this better together.
          </p>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex justify-end">
          <button
            onClick={handleDismiss}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
