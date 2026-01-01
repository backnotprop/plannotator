/**
 * Embeddable version of the Plannotator app.
 *
 * Key differences from App.tsx:
 * - Themes are scoped to the container element, not document.documentElement
 * - Approve/deny use callbacks instead of API calls
 * - No assumptions about being the root document
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { parseMarkdownToBlocks, exportDiff } from '@plannotator/ui/utils/parser';
import { Viewer, ViewerHandle } from '@plannotator/ui/components/Viewer';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { ExportModal } from '@plannotator/ui/components/ExportModal';
import { Annotation, Block, EditorMode } from '@plannotator/ui/types';
import { ScopedThemeProvider } from './ScopedThemeProvider';
import { ModeToggle } from '@plannotator/ui/components/ModeToggle';
import { ModeSwitcher } from '@plannotator/ui/components/ModeSwitcher';
import { TaterSpriteRunning } from '@plannotator/ui/components/TaterSpriteRunning';
import { TaterSpritePullup } from '@plannotator/ui/components/TaterSpritePullup';
import { Settings } from '@plannotator/ui/components/Settings';
import { useSharing } from '@plannotator/ui/hooks/useSharing';
import { storage } from '@plannotator/ui/utils/storage';
import { UpdateBanner } from '@plannotator/ui/components/UpdateBanner';

const DEMO_CONTENT = `# Demo Plan

This is a demonstration of Plannotator in embedded mode.

## Features

- Select text to add annotations
- Use redline mode for quick deletions
- Export feedback to share with your team

\`\`\`typescript
// Example code block
function greet(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`

Try selecting some text above to add annotations!
`;

export interface EmbeddableAppController {
  setPlan: (plan: string) => void;
  getFeedback: () => string;
}

export interface EmbeddableAppProps {
  /**
   * Initial markdown plan content.
   */
  initialPlan?: string;

  /**
   * Initial theme. Defaults to 'dark'.
   */
  initialTheme?: 'dark' | 'light' | 'system';

  /**
   * Called when user approves the plan.
   */
  onApprove?: () => void;

  /**
   * Called when user denies with feedback.
   */
  onDeny?: (feedback: string) => void;

  /**
   * Base URL for API calls. Set to null to disable API mode.
   */
  apiBaseUrl?: string | null;

  /**
   * Whether to show update banner. Defaults to false.
   */
  showUpdateBanner?: boolean;

  /**
   * Reference to the container element for scoped theming.
   */
  containerRef?: HTMLElement;

  /**
   * Callback when controller is ready for external access.
   */
  onControllerReady?: (controller: EmbeddableAppController) => void;
}

export const EmbeddableApp: React.FC<EmbeddableAppProps> = ({
  initialPlan,
  initialTheme = 'dark',
  onApprove,
  onDeny,
  apiBaseUrl,
  showUpdateBanner = false,
  containerRef,
  onControllerReady,
}) => {
  const [markdown, setMarkdown] = useState(initialPlan || DEMO_CONTENT);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [showExport, setShowExport] = useState(false);
  const [showFeedbackPrompt, setShowFeedbackPrompt] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [editorMode, setEditorMode] = useState<EditorMode>('selection');
  const [taterMode, setTaterMode] = useState(() => {
    const stored = storage.getItem('plannotator-tater-mode');
    return stored === 'true';
  });
  const [isApiMode, setIsApiMode] = useState(false);
  const [isLoading, setIsLoading] = useState(apiBaseUrl !== null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<'approved' | 'denied' | null>(null);
  const viewerRef = useRef<ViewerHandle>(null);

  // Calculate diff output
  const diffOutput = useMemo(() => exportDiff(blocks, annotations), [blocks, annotations]);

  // Expose controller to parent
  useEffect(() => {
    if (onControllerReady) {
      onControllerReady({
        setPlan: (plan: string) => setMarkdown(plan),
        getFeedback: () => diffOutput,
      });
    }
  }, [onControllerReady, diffOutput]);

  // URL-based sharing
  const {
    isSharedSession,
    isLoadingShared,
    shareUrl,
    shareUrlSize,
    pendingSharedAnnotations,
    clearPendingSharedAnnotations,
  } = useSharing(
    markdown,
    annotations,
    setMarkdown,
    setAnnotations,
    () => setIsLoading(false)
  );

  // Apply shared annotations to DOM after they're loaded
  useEffect(() => {
    if (pendingSharedAnnotations && pendingSharedAnnotations.length > 0) {
      const timer = setTimeout(() => {
        viewerRef.current?.clearAllHighlights();
        viewerRef.current?.applySharedAnnotations(pendingSharedAnnotations);
        clearPendingSharedAnnotations();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [pendingSharedAnnotations, clearPendingSharedAnnotations]);

  const handleTaterModeChange = (enabled: boolean) => {
    setTaterMode(enabled);
    storage.setItem('plannotator-tater-mode', String(enabled));
  };

  // Check if we're in API mode (skip if apiBaseUrl is null or loaded from share)
  useEffect(() => {
    if (apiBaseUrl === null) {
      setIsLoading(false);
      return;
    }
    if (isLoadingShared) return;
    if (isSharedSession) return;

    const baseUrl = apiBaseUrl || '';
    fetch(`${baseUrl}/api/plan`)
      .then(res => {
        if (!res.ok) throw new Error('Not in API mode');
        return res.json();
      })
      .then((data: { plan: string }) => {
        setMarkdown(data.plan);
        setIsApiMode(true);
      })
      .catch(() => {
        setIsApiMode(false);
      })
      .finally(() => setIsLoading(false));
  }, [apiBaseUrl, isLoadingShared, isSharedSession]);

  useEffect(() => {
    setBlocks(parseMarkdownToBlocks(markdown));
  }, [markdown]);

  // Approve/deny handlers with callback support
  const handleApprove = useCallback(async () => {
    setIsSubmitting(true);
    try {
      if (onApprove) {
        onApprove();
      } else if (apiBaseUrl !== null) {
        const baseUrl = apiBaseUrl || '';
        await fetch(`${baseUrl}/api/approve`, { method: 'POST' });
      }
      setSubmitted('approved');
    } catch {
      setIsSubmitting(false);
    }
  }, [onApprove, apiBaseUrl]);

  const handleDeny = useCallback(async () => {
    setIsSubmitting(true);
    try {
      if (onDeny) {
        onDeny(diffOutput);
      } else if (apiBaseUrl !== null) {
        const baseUrl = apiBaseUrl || '';
        await fetch(`${baseUrl}/api/deny`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedback: diffOutput }),
        });
      }
      setSubmitted('denied');
    } catch {
      setIsSubmitting(false);
    }
  }, [onDeny, apiBaseUrl, diffOutput]);

  const handleAddAnnotation = (ann: Annotation) => {
    setAnnotations(prev => [...prev, ann]);
    setSelectedAnnotationId(ann.id);
    setIsPanelOpen(true);
  };

  const handleDeleteAnnotation = (id: string) => {
    viewerRef.current?.removeHighlight(id);
    setAnnotations(prev => prev.filter(a => a.id !== id));
    if (selectedAnnotationId === id) setSelectedAnnotationId(null);
  };

  const handleIdentityChange = (oldIdentity: string, newIdentity: string) => {
    setAnnotations(prev =>
      prev.map(ann => (ann.author === oldIdentity ? { ...ann, author: newIdentity } : ann))
    );
  };

  // Determine if we should show action buttons
  const showActions = isApiMode || onApprove || onDeny;

  return (
    <ScopedThemeProvider
      defaultTheme={initialTheme}
      containerRef={containerRef}
    >
      <div className="plannotator-embed h-full flex flex-col bg-background overflow-hidden">
        {/* Tater sprites */}
        {taterMode && <TaterSpriteRunning />}

        {/* Minimal Header */}
        <header className="h-12 flex items-center justify-between px-2 md:px-4 border-b border-border/50 bg-card/50 backdrop-blur-xl z-50">
          <div className="flex items-center gap-2 md:gap-3">
            <a
              href="https://plannotator.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 md:gap-2 hover:opacity-80 transition-opacity"
            >
              <span className="text-sm font-semibold tracking-tight">Plannotator</span>
            </a>
            <span className="text-xs text-muted-foreground font-mono opacity-60 hidden md:inline">
              v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'}
            </span>
          </div>

          <div className="flex items-center gap-1 md:gap-2">
            {showActions && (
              <>
                <button
                  onClick={() => {
                    if (annotations.length === 0) {
                      setShowFeedbackPrompt(true);
                    } else {
                      handleDeny();
                    }
                  }}
                  disabled={isSubmitting}
                  className={`p-1.5 md:px-2.5 md:py-1 rounded-md text-xs font-medium transition-all ${
                    isSubmitting
                      ? 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground'
                      : 'bg-accent/15 text-accent hover:bg-accent/25 border border-accent/30'
                  }`}
                  title="Provide Feedback"
                >
                  <svg
                    className="w-4 h-4 md:hidden"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                    />
                  </svg>
                  <span className="hidden md:inline">
                    {isSubmitting ? 'Sending...' : 'Provide Feedback'}
                  </span>
                </button>

                <button
                  onClick={handleApprove}
                  disabled={isSubmitting}
                  className={`px-2 py-1 md:px-2.5 rounded-md text-xs font-medium transition-all ${
                    isSubmitting
                      ? 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground'
                      : 'bg-green-600 text-white hover:bg-green-500'
                  }`}
                >
                  <span className="md:hidden">{isSubmitting ? '...' : 'OK'}</span>
                  <span className="hidden md:inline">
                    {isSubmitting ? 'Approving...' : 'Approve'}
                  </span>
                </button>

                <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
              </>
            )}

            <ModeToggle />
            <Settings
              taterMode={taterMode}
              onTaterModeChange={handleTaterModeChange}
              onIdentityChange={handleIdentityChange}
            />

            <button
              onClick={() => setIsPanelOpen(!isPanelOpen)}
              className={`p-1.5 rounded-md text-xs font-medium transition-all ${
                isPanelOpen
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
                />
              </svg>
            </button>

            <button
              onClick={() => setShowExport(true)}
              className="p-1.5 md:px-2.5 md:py-1 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors"
              title="Export"
            >
              <svg
                className="w-4 h-4 md:hidden"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </svg>
              <span className="hidden md:inline">Export</span>
            </button>
          </div>
        </header>

        {/* Main Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Document Area */}
          <main className="flex-1 overflow-y-auto bg-grid">
            <div className="min-h-full flex flex-col items-center p-3 md:p-8">
              {/* Mode Switcher */}
              <div className="w-full max-w-3xl mb-3 md:mb-4 flex justify-start">
                <ModeSwitcher mode={editorMode} onChange={setEditorMode} taterMode={taterMode} />
              </div>

              <Viewer
                ref={viewerRef}
                blocks={blocks}
                markdown={markdown}
                annotations={annotations}
                onAddAnnotation={handleAddAnnotation}
                onSelectAnnotation={setSelectedAnnotationId}
                selectedAnnotationId={selectedAnnotationId}
                mode={editorMode}
                taterMode={taterMode}
              />
            </div>
          </main>

          {/* Annotation Panel */}
          <AnnotationPanel
            isOpen={isPanelOpen}
            blocks={blocks}
            annotations={annotations}
            selectedId={selectedAnnotationId}
            onSelect={setSelectedAnnotationId}
            onDelete={handleDeleteAnnotation}
            shareUrl={shareUrl}
          />
        </div>

        {/* Export Modal */}
        <ExportModal
          isOpen={showExport}
          onClose={() => setShowExport(false)}
          shareUrl={shareUrl}
          shareUrlSize={shareUrlSize}
          diffOutput={diffOutput}
          annotationCount={annotations.length}
          taterSprite={taterMode ? <TaterSpritePullup /> : undefined}
        />

        {/* Feedback prompt dialog */}
        {showFeedbackPrompt && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
            <div className="bg-card border border-border rounded-xl w-full max-w-sm shadow-2xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-accent"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
                    />
                  </svg>
                </div>
                <h3 className="font-semibold">Add Annotations First</h3>
              </div>
              <p className="text-sm text-muted-foreground mb-6">
                To provide feedback, select text in the plan and add annotations. Claude will use
                your annotations to revise the plan.
              </p>
              <div className="flex justify-end">
                <button
                  onClick={() => setShowFeedbackPrompt(false)}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                >
                  Got it
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Completion overlay - shown after approve/deny */}
        {submitted && (
          <div className="absolute inset-0 z-[100] bg-background flex items-center justify-center">
            <div className="text-center space-y-6 max-w-md px-8">
              <div
                className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center ${
                  submitted === 'approved'
                    ? 'bg-green-500/20 text-green-500'
                    : 'bg-accent/20 text-accent'
                }`}
              >
                {submitted === 'approved' ? (
                  <svg
                    className="w-8 h-8"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg
                    className="w-8 h-8"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                    />
                  </svg>
                )}
              </div>

              <div className="space-y-2">
                <h2 className="text-xl font-semibold text-foreground">
                  {submitted === 'approved' ? 'Plan Approved' : 'Feedback Sent'}
                </h2>
                <p className="text-muted-foreground">
                  {submitted === 'approved'
                    ? 'Claude will proceed with the implementation.'
                    : 'Claude will revise the plan based on your annotations.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Update notification */}
        {showUpdateBanner && <UpdateBanner />}
      </div>
    </ScopedThemeProvider>
  );
};

// Declare the version global
declare const __APP_VERSION__: string;

export default EmbeddableApp;
