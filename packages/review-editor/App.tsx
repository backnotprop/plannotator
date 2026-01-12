import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ThemeProvider, useTheme } from '@plannotator/ui/components/ThemeProvider';
import { ModeToggle } from '@plannotator/ui/components/ModeToggle';
import { storage } from '@plannotator/ui/utils/storage';
import { getIdentity } from '@plannotator/ui/utils/identity';
import { CodeAnnotation, CodeAnnotationType, SelectedLineRange, DiffAnnotationMetadata } from '@plannotator/ui/types';
import { DiffViewer } from './components/DiffViewer';
import { ReviewPanel } from './components/ReviewPanel';
import { FileTree } from './components/FileTree';

declare const __APP_VERSION__: string;

// Demo diff for development
const DEMO_DIFF = `diff --git a/src/components/Button.tsx b/src/components/Button.tsx
index 1234567..abcdefg 100644
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -1,10 +1,15 @@
-import React from 'react';
+import React, { useCallback } from 'react';

 interface ButtonProps {
   label: string;
   onClick: () => void;
+  disabled?: boolean;
+  variant?: 'primary' | 'secondary';
 }

-export const Button = ({ label, onClick }: ButtonProps) => {
+export const Button = ({ label, onClick, disabled, variant = 'primary' }: ButtonProps) => {
+  const handleClick = useCallback(() => {
+    if (!disabled) onClick();
+  }, [disabled, onClick]);
+
   return (
-    <button onClick={onClick}>
+    <button onClick={handleClick} disabled={disabled} className={variant}>
       {label}
     </button>
   );
diff --git a/src/utils/helpers.ts b/src/utils/helpers.ts
index 2345678..bcdefgh 100644
--- a/src/utils/helpers.ts
+++ b/src/utils/helpers.ts
@@ -5,3 +5,8 @@ export function formatDate(date: Date): string {
 export function capitalize(str: string): string {
   return str.charAt(0).toUpperCase() + str.slice(1);
 }
+
+export function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
+  let timeoutId: NodeJS.Timeout;
+  return ((...args) => { clearTimeout(timeoutId); timeoutId = setTimeout(() => fn(...args), delay); }) as T;
+}
`;

interface DiffFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
}

interface DiffData {
  files: DiffFile[];
  rawPatch: string;
  gitRef: string;
}

// Simple diff parser to extract files from unified diff
function parseDiffToFiles(rawPatch: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileChunks = rawPatch.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const lines = chunk.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.+) b\/(.+)/);
    if (!headerMatch) continue;

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];

    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }

    files.push({
      path: newPath,
      oldPath: oldPath !== newPath ? oldPath : undefined,
      patch: 'diff --git ' + chunk,
      additions,
      deletions,
    });
  }

  return files;
}

// Generate unique ID
function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

// Export annotations as markdown feedback
function exportReviewFeedback(annotations: CodeAnnotation[], files: DiffFile[]): string {
  if (annotations.length === 0) {
    return '# Code Review\n\nNo feedback provided.';
  }

  const grouped = new Map<string, CodeAnnotation[]>();
  for (const ann of annotations) {
    const existing = grouped.get(ann.filePath) || [];
    existing.push(ann);
    grouped.set(ann.filePath, existing);
  }

  let output = '# Code Review Feedback\n\n';

  for (const [filePath, fileAnnotations] of grouped) {
    output += `## ${filePath}\n\n`;

    const sorted = [...fileAnnotations].sort((a, b) => a.lineStart - b.lineStart);

    for (let i = 0; i < sorted.length; i++) {
      const ann = sorted[i];
      const lineRange = ann.lineStart === ann.lineEnd
        ? `Line ${ann.lineStart}`
        : `Lines ${ann.lineStart}-${ann.lineEnd}`;

      const typeLabel = ann.type.charAt(0).toUpperCase() + ann.type.slice(1);

      output += `### ${i + 1}. ${lineRange} (${ann.side}): ${typeLabel}\n`;

      if (ann.text) {
        output += `> ${ann.text}\n`;
      }

      if (ann.suggestedCode) {
        output += `\n**Suggested:**\n\`\`\`\n${ann.suggestedCode}\n\`\`\`\n`;
      }

      output += '\n';
    }
  }

  return output;
}

const ReviewApp: React.FC = () => {
  const [diffData, setDiffData] = useState<DiffData | null>(null);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [annotations, setAnnotations] = useState<CodeAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<SelectedLineRange | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [isApiMode, setIsApiMode] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>(() => {
    return (storage.getItem('review-diff-style') as 'split' | 'unified') || 'split';
  });
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const identity = useMemo(() => getIdentity(), []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape closes modals
      if (e.key === 'Escape') {
        if (showExportModal) {
          setShowExportModal(false);
        }
      }
      // Cmd/Ctrl+Shift+C to copy diff
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'c') {
        e.preventDefault();
        handleCopyDiff();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showExportModal]);

  // Get annotations for active file
  const activeFileAnnotations = useMemo(() => {
    const activeFile = files[activeFileIndex];
    if (!activeFile) return [];
    return annotations.filter(a => a.filePath === activeFile.path);
  }, [annotations, files, activeFileIndex]);

  // Check if we're in API mode
  useEffect(() => {
    fetch('/api/diff')
      .then(res => {
        if (!res.ok) throw new Error('Not in API mode');
        return res.json();
      })
      .then((data: DiffData) => {
        setDiffData(data);
        setFiles(parseDiffToFiles(data.rawPatch));
        setIsApiMode(true);
      })
      .catch(() => {
        // Not in API mode - use demo content
        const demoFiles = parseDiffToFiles(DEMO_DIFF);
        setDiffData({
          files: demoFiles,
          rawPatch: DEMO_DIFF,
          gitRef: 'demo',
        });
        setFiles(demoFiles);
        setIsApiMode(false);
      })
      .finally(() => setIsLoading(false));
  }, []);

  // Handle diff style change
  const handleDiffStyleChange = useCallback((style: 'split' | 'unified') => {
    setDiffStyle(style);
    storage.setItem('review-diff-style', style);
  }, []);

  // Handle line selection from diff viewer
  const handleLineSelection = useCallback((range: SelectedLineRange | null) => {
    setPendingSelection(range);
  }, []);

  // Add annotation
  const handleAddAnnotation = useCallback((
    type: CodeAnnotationType,
    text?: string,
    suggestedCode?: string
  ) => {
    if (!pendingSelection || !files[activeFileIndex]) return;

    const newAnnotation: CodeAnnotation = {
      id: generateId(),
      type,
      filePath: files[activeFileIndex].path,
      lineStart: pendingSelection.start,
      lineEnd: pendingSelection.end,
      side: pendingSelection.side === 'additions' ? 'new' : 'old',
      text,
      suggestedCode,
      createdAt: Date.now(),
      author: identity,
    };

    setAnnotations(prev => [...prev, newAnnotation]);
    setPendingSelection(null);
  }, [pendingSelection, files, activeFileIndex, identity]);

  // Delete annotation
  const handleDeleteAnnotation = useCallback((id: string) => {
    setAnnotations(prev => prev.filter(a => a.id !== id));
    if (selectedAnnotationId === id) {
      setSelectedAnnotationId(null);
    }
  }, [selectedAnnotationId]);

  // Copy diff to clipboard
  const handleCopyDiff = useCallback(async () => {
    if (!diffData) return;
    try {
      await navigator.clipboard.writeText(diffData.rawPatch);
      setCopyFeedback('Diff copied!');
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      setCopyFeedback('Failed to copy');
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [diffData]);

  // Submit feedback
  const handleSubmitFeedback = useCallback(async () => {
    if (!isApiMode) {
      setShowExportModal(true);
      return;
    }

    setIsSubmitting(true);
    try {
      const feedback = exportReviewFeedback(annotations, files);
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback, annotations }),
      });
      setSubmitted(true);
    } catch (err) {
      console.error('Failed to submit:', err);
    } finally {
      setIsSubmitting(false);
    }
  }, [isApiMode, annotations, files]);

  const activeFile = files[activeFileIndex];
  const feedbackMarkdown = useMemo(() =>
    exportReviewFeedback(annotations, files),
    [annotations, files]
  );

  if (isLoading) {
    return (
      <ThemeProvider defaultTheme="dark">
        <div className="h-screen flex items-center justify-center bg-background">
          <div className="text-muted-foreground text-sm">Loading diff...</div>
        </div>
      </ThemeProvider>
    );
  }

  if (submitted) {
    return (
      <ThemeProvider defaultTheme="dark">
        <div className="h-screen flex items-center justify-center bg-background">
          <div className="text-center">
            <div className="text-2xl mb-2">Review Submitted</div>
            <div className="text-muted-foreground text-sm">You can close this tab.</div>
          </div>
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider defaultTheme="dark">
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        {/* Header */}
        <header className="h-12 flex items-center justify-between px-4 border-b border-border/50 bg-card/50 backdrop-blur-xl z-50">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-tight">Code Review</span>
            <span className="text-xs text-muted-foreground font-mono opacity-60">
              v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'}
            </span>
            {diffData?.gitRef && (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-muted text-muted-foreground">
                {diffData.gitRef}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Diff style toggle */}
            <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
              <button
                onClick={() => handleDiffStyleChange('split')}
                className={`px-2 py-1 text-xs rounded-md transition-colors ${
                  diffStyle === 'split'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Split
              </button>
              <button
                onClick={() => handleDiffStyleChange('unified')}
                className={`px-2 py-1 text-xs rounded-md transition-colors ${
                  diffStyle === 'unified'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Unified
              </button>
            </div>

            <div className="w-px h-5 bg-border/50" />

            {/* Copy diff */}
            <button
              onClick={handleCopyDiff}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Copy raw diff"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>

            {/* Export */}
            <button
              onClick={() => setShowExportModal(true)}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Export feedback"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </button>

            {isApiMode && (
              <>
                <div className="w-px h-5 bg-border/50" />
                <button
                  onClick={handleSubmitFeedback}
                  disabled={isSubmitting}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    isSubmitting
                      ? 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground'
                      : 'bg-primary text-primary-foreground hover:opacity-90'
                  }`}
                >
                  {isSubmitting ? 'Submitting...' : 'Submit Review'}
                </button>
              </>
            )}

            <div className="w-px h-5 bg-border/50" />
            <ModeToggle />
          </div>
        </header>

        {/* Main content */}
        <div className="flex-1 flex overflow-hidden">
          {/* File tree sidebar */}
          {files.length > 1 && (
            <FileTree
              files={files}
              activeFileIndex={activeFileIndex}
              onSelectFile={setActiveFileIndex}
              annotations={annotations}
              enableKeyboardNav={!showExportModal}
            />
          )}

          {/* Diff viewer */}
          <main className="flex-1 overflow-hidden">
            {activeFile && (
              <DiffViewer
                patch={activeFile.patch}
                filePath={activeFile.path}
                diffStyle={diffStyle}
                annotations={activeFileAnnotations}
                selectedAnnotationId={selectedAnnotationId}
                pendingSelection={pendingSelection}
                onLineSelection={handleLineSelection}
                onAddAnnotation={handleAddAnnotation}
                onSelectAnnotation={setSelectedAnnotationId}
              />
            )}
          </main>

          {/* Annotations panel */}
          <ReviewPanel
            isOpen={isPanelOpen}
            onToggle={() => setIsPanelOpen(!isPanelOpen)}
            annotations={annotations}
            files={files}
            selectedAnnotationId={selectedAnnotationId}
            onSelectAnnotation={setSelectedAnnotationId}
            onDeleteAnnotation={handleDeleteAnnotation}
          />
        </div>

        {/* Export Modal */}
        {showExportModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
            <div className="bg-card border border-border rounded-xl w-full max-w-2xl flex flex-col max-h-[80vh] shadow-2xl">
              <div className="p-4 border-b border-border flex justify-between items-center">
                <h3 className="font-semibold text-sm">Export Review Feedback</h3>
                <button
                  onClick={() => setShowExportModal(false)}
                  className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 overflow-auto p-4">
                <div className="text-xs text-muted-foreground mb-2">
                  {annotations.length} annotation{annotations.length !== 1 ? 's' : ''}
                </div>
                <pre className="export-code-block whitespace-pre-wrap">
                  {feedbackMarkdown}
                </pre>
              </div>
              <div className="p-4 border-t border-border flex justify-end gap-2">
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(feedbackMarkdown);
                  }}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-colors"
                >
                  Copy to Clipboard
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Copy feedback toast */}
        {copyFeedback && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-card border border-border rounded-lg shadow-lg text-sm animate-in fade-in slide-in-from-bottom-2 duration-200">
            {copyFeedback}
          </div>
        )}
      </div>
    </ThemeProvider>
  );
};

export default ReviewApp;
