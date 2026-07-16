import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { TextShimmer } from '@plannotator/ui/components/TextShimmer';

/**
 * One-time "Introducing Guided Reviews" announcement — same shell as
 * LookAndFeelAnnouncementDialog. The hero image is CDN-hosted (not bundled),
 * so on load failure the image container hides entirely and an offline user
 * gets a clean text-only dialog instead of a broken-image icon.
 */

interface GuideIntroDialogProps {
  isOpen: boolean;
  onDismiss: () => void;
}

const HERO_IMAGE_URL = 'https://plannotator.ai/assets/guided-review.webp';

export const GuideIntroDialog: React.FC<GuideIntroDialogProps> = ({ isOpen, onDismiss }) => {
  const [imageFailed, setImageFailed] = useState(false);
  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 backdrop-blur-sm p-4">
      {/* max-h clamp + scrollable body: same protection ReviewSetupDialog
          needed — the hero makes this panel taller than short viewports. */}
      <div className="bg-card border border-border rounded-xl w-full max-w-5xl max-h-[calc(100vh-2rem)] shadow-2xl flex flex-col">
        {/* Header */}
        <div className="p-7 border-b border-border">
          <h3 className="font-semibold text-2xl">Introducing Guided Reviews</h3>
        </div>

        <div className="p-7 flex flex-col gap-5 overflow-y-auto">
          {/* Hero. aspect ratio reserved so the panel doesn't jump on load. */}
          {!imageFailed && (
            <div className="aspect-[3476/2160] w-full">
              <img
                src={HERO_IMAGE_URL}
                alt="Guided review: chaptered changes with per-file summaries"
                className="w-full h-full object-cover rounded-lg border border-border select-none"
                draggable={false}
                onError={() => setImageFailed(true)}
              />
            </div>
          )}

          <p className="text-sm text-muted-foreground leading-relaxed">
            A guided review organizes your changeset into ordered chapters, with the most
            important changes first. Every file gets a brief summary of what changed. It is
            generated on demand by your local agent CLI.
          </p>

          {/* Launch hint: a compact mock of the app header with the Guide pill. */}
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <span className="bg-muted rounded-md text-xs font-medium px-2 py-1 select-none">
              <TextShimmer duration={2.5} spread={1.5}>Guide</TextShimmer>
            </span>
            <span className="text-xs text-muted-foreground">
              Find Guide in the top left of the app header.
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-7 py-5 border-t border-border flex justify-end">
          <button
            onClick={onDismiss}
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
