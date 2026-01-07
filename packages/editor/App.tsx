import React, { useState, useEffect, useMemo, useRef } from 'react';
import { parseMarkdownToBlocks, exportDiff } from '@plannotator/ui/utils/parser';
import { Viewer, ViewerHandle } from '@plannotator/ui/components/Viewer';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { ExportModal } from '@plannotator/ui/components/ExportModal';
import { ConfirmDialog } from '@plannotator/ui/components/ConfirmDialog';
import { Annotation, Block, EditorMode } from '@plannotator/ui/types';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { ModeToggle } from '@plannotator/ui/components/ModeToggle';
import { ModeSwitcher } from '@plannotator/ui/components/ModeSwitcher';
import { TaterSpriteRunning } from '@plannotator/ui/components/TaterSpriteRunning';
import { TaterSpritePullup } from '@plannotator/ui/components/TaterSpritePullup';
import { Settings } from '@plannotator/ui/components/Settings';
import { useSharing } from '@plannotator/ui/hooks/useSharing';
import { storage } from '@plannotator/ui/utils/storage';
import { UpdateBanner } from '@plannotator/ui/components/UpdateBanner';
import { getObsidianSettings } from '@plannotator/ui/utils/obsidian';
import { getBearSettings } from '@plannotator/ui/utils/bear';
import { ImageAnnotator } from '@plannotator/ui/components/ImageAnnotator';

const PLAN_CONTENT = `# Implementation Plan: Real-time Collaboration

## Overview
Add real-time collaboration features to the editor using WebSocket connections and operational transforms.

## Phase 1: Infrastructure

### WebSocket Server
Set up a WebSocket server to handle concurrent connections:

\`\`\`typescript
const server = new WebSocketServer({ port: 8080 });

server.on('connection', (socket, request) => {
  const sessionId = generateSessionId();
  sessions.set(sessionId, socket);

  socket.on('message', (data) => {
    broadcast(sessionId, data);
  });
});
\`\`\`

### Client Connection
- Establish persistent connection on document load
  - Initialize WebSocket with authentication token
  - Set up heartbeat ping/pong every 30 seconds
  - Handle connection state changes (connecting, open, closing, closed)
- Implement reconnection logic with exponential backoff
  - Start with 1 second delay
  - Double delay on each retry (max 30 seconds)
  - Reset delay on successful connection
- Handle offline state gracefully
  - Queue local changes in IndexedDB
  - Show offline indicator in UI
  - Sync queued changes on reconnect

### Database Schema

\`\`\`sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  content JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role VARCHAR(50) DEFAULT 'editor',
  cursor_position JSONB,
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_collaborators_document ON collaborators(document_id);
\`\`\`

## Phase 2: Operational Transforms

> The key insight is that we need to transform operations against concurrent operations to maintain consistency.

Key requirements:
- Transform insert against insert
  - Same position: use user ID for deterministic ordering
  - Different positions: adjust offset of later operation
- Transform insert against delete
  - Insert before delete: no change needed
  - Insert inside deleted range: special handling required
    - Option A: Move insert to delete start position
    - Option B: Discard the insert entirely
  - Insert after delete: adjust insert position
- Transform delete against delete
  - Non-overlapping: adjust positions
  - Overlapping: merge or split operations
- Maintain cursor positions across transforms
  - Track cursor as a zero-width insert operation
  - Update cursor position after each transform

### Transform Implementation

\`\`\`typescript
interface Operation {
  type: 'insert' | 'delete';
  position: number;
  content?: string;
  length?: number;
  userId: string;
  timestamp: number;
}

class OperationalTransform {
  private pendingOps: Operation[] = [];
  private history: Operation[] = [];

  transform(op1: Operation, op2: Operation): [Operation, Operation] {
    if (op1.type === 'insert' && op2.type === 'insert') {
      if (op1.position <= op2.position) {
        return [op1, { ...op2, position: op2.position + (op1.content?.length || 0) }];
      } else {
        return [{ ...op1, position: op1.position + (op2.content?.length || 0) }, op2];
      }
    }

    if (op1.type === 'delete' && op2.type === 'delete') {
      // Complex delete vs delete transformation
      const op1End = op1.position + (op1.length || 0);
      const op2End = op2.position + (op2.length || 0);

      if (op1End <= op2.position) {
        return [op1, { ...op2, position: op2.position - (op1.length || 0) }];
      }
      // ... more cases
    }

    return [op1, op2];
  }

  apply(doc: string, op: Operation): string {
    if (op.type === 'insert') {
      return doc.slice(0, op.position) + op.content + doc.slice(op.position);
    } else {
      return doc.slice(0, op.position) + doc.slice(op.position + (op.length || 0));
    }
  }
}
\`\`\`

## Phase 3: UI Updates

1. Show collaborator cursors in real-time
   - Render cursor as colored vertical line
   - Add name label above cursor
   - Animate cursor movement smoothly
2. Display presence indicators
   - Avatar stack in header
   - Dropdown with full collaborator list
     - Show online/away status
     - Display last activity time
     - Allow @mentioning collaborators
3. Add conflict resolution UI
   - Highlight conflicting regions
   - Show diff comparison panel
   - Provide merge options:
     - Accept mine
     - Accept theirs
     - Manual merge
4. Implement undo/redo stack per user
   - Track operations by user ID
   - Allow undoing only own changes
   - Show undo history in sidebar

### React Component for Cursors

\`\`\`tsx
import React, { useEffect, useState } from 'react';
import { useCollaboration } from '../hooks/useCollaboration';

interface CursorOverlayProps {
  documentId: string;
  containerRef: React.RefObject<HTMLDivElement>;
}

export const CursorOverlay: React.FC<CursorOverlayProps> = ({
  documentId,
  containerRef
}) => {
  const { collaborators, currentUser } = useCollaboration(documentId);
  const [positions, setPositions] = useState<Map<string, DOMRect>>(new Map());

  useEffect(() => {
    const updatePositions = () => {
      const newPositions = new Map<string, DOMRect>();
      collaborators.forEach(collab => {
        if (collab.userId !== currentUser.id && collab.cursorPosition) {
          const rect = getCursorRect(containerRef.current, collab.cursorPosition);
          if (rect) newPositions.set(collab.userId, rect);
        }
      });
      setPositions(newPositions);
    };

    const interval = setInterval(updatePositions, 50);
    return () => clearInterval(interval);
  }, [collaborators, currentUser, containerRef]);

  return (
    <>
      {Array.from(positions.entries()).map(([userId, rect]) => (
        <div
          key={userId}
          className="absolute pointer-events-none transition-all duration-75"
          style={{
            left: rect.left,
            top: rect.top,
            height: rect.height,
          }}
        >
          <div className="w-0.5 h-full bg-blue-500 animate-pulse" />
          <div className="absolute -top-5 left-0 px-1.5 py-0.5 bg-blue-500
                          text-white text-xs rounded whitespace-nowrap">
            {collaborators.find(c => c.userId === userId)?.userName}
          </div>
        </div>
      ))}
    </>
  );
};
\`\`\`

### Configuration

\`\`\`json
{
  "collaboration": {
    "enabled": true,
    "maxCollaborators": 10,
    "cursorColors": ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"],
    "syncInterval": 100,
    "reconnect": {
      "maxAttempts": 5,
      "backoffMultiplier": 1.5,
      "initialDelay": 1000
    }
  }
}
\`\`\`

---

## Pre-launch Checklist

- [ ] Infrastructure ready
  - [x] WebSocket server deployed
  - [x] Database migrations applied
  - [ ] Load balancer configured
    - [ ] SSL certificates installed
    - [ ] Health checks enabled
      - [ ] /health endpoint returns 200
      - [ ] /ready endpoint checks DB connection
        - [ ] Primary database
        - [ ] Read replicas
          - [ ] us-east-1 replica
          - [ ] eu-west-1 replica
- [ ] Security audit complete
  - [x] Authentication flow reviewed
  - [ ] Rate limiting implemented
    - [x] 100 req/min for anonymous users
    - [ ] 1000 req/min for authenticated users
  - [ ] Input sanitization verified
- [x] Documentation updated
  - [x] API reference generated
  - [x] Integration guide written
  - [ ] Video tutorials recorded

### Mixed List Styles

* Asterisk item at level 0
  - Dash item at level 1
    * Asterisk at level 2
      - Dash at level 3
        * Asterisk at level 4
          - Maximum reasonable depth
1. Numbered item
   - Sub-bullet under numbered
   - Another sub-bullet
     1. Nested numbered list
     2. Second nested number

---

**Target:** Ship MVP in next sprint
`;

const App: React.FC = () => {
  const [markdown, setMarkdown] = useState(PLAN_CONTENT);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [showExport, setShowExport] = useState(false);
  const [showFeedbackPrompt, setShowFeedbackPrompt] = useState(false);
  const [showClaudeCodeWarning, setShowClaudeCodeWarning] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [editorMode, setEditorMode] = useState<EditorMode>('selection');
  const [taterMode, setTaterMode] = useState(() => {
    const stored = storage.getItem('plannotator-tater-mode');
    return stored === 'true';
  });
  const [isApiMode, setIsApiMode] = useState(false);
  const [origin, setOrigin] = useState<'claude-code' | 'opencode' | null>(null);
  const [globalAttachments, setGlobalAttachments] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<'approved' | 'denied' | null>(null);
  const [pendingPasteImage, setPendingPasteImage] = useState<{ file: File; blobUrl: string } | null>(null);
  const viewerRef = useRef<ViewerHandle>(null);

  // URL-based sharing
  const {
    isSharedSession,
    isLoadingShared,
    shareUrl,
    shareUrlSize,
    pendingSharedAnnotations,
    sharedGlobalAttachments,
    clearPendingSharedAnnotations,
  } = useSharing(
    markdown,
    annotations,
    globalAttachments,
    setMarkdown,
    setAnnotations,
    setGlobalAttachments,
    () => {
      // When loaded from share, mark as loaded
      setIsLoading(false);
    }
  );

  // Apply shared annotations to DOM after they're loaded
  useEffect(() => {
    if (pendingSharedAnnotations && pendingSharedAnnotations.length > 0) {
      // Small delay to ensure DOM is rendered
      const timer = setTimeout(() => {
        // Clear existing highlights first (important when loading new share URL)
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

  // Check if we're in API mode (served from Bun hook server)
  // Skip if we loaded from a shared URL
  useEffect(() => {
    if (isLoadingShared) return; // Wait for share check to complete
    if (isSharedSession) return; // Already loaded from share

    fetch('/api/plan')
      .then(res => {
        if (!res.ok) throw new Error('Not in API mode');
        return res.json();
      })
      .then((data: { plan: string; origin?: 'claude-code' | 'opencode' }) => {
        setMarkdown(data.plan);
        setIsApiMode(true);
        if (data.origin) setOrigin(data.origin);
      })
      .catch(() => {
        // Not in API mode - use default content
        setIsApiMode(false);
      })
      .finally(() => setIsLoading(false));
  }, [isLoadingShared, isSharedSession]);

  useEffect(() => {
    setBlocks(parseMarkdownToBlocks(markdown));
  }, [markdown]);

  // Global paste listener for image attachments
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            // Show annotator instead of direct upload
            const blobUrl = URL.createObjectURL(file);
            setPendingPasteImage({ file, blobUrl });
          }
          break;
        }
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, []);

  // Handle paste annotator accept
  const handlePasteAnnotatorAccept = async (blob: Blob, hasDrawings: boolean) => {
    if (!pendingPasteImage) return;

    try {
      const formData = new FormData();
      const fileToUpload = hasDrawings
        ? new File([blob], 'annotated.png', { type: 'image/png' })
        : pendingPasteImage.file;
      formData.append('file', fileToUpload);

      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      if (res.ok) {
        const { path } = await res.json();
        setGlobalAttachments(prev => [...prev, path]);
      }
    } catch {
      // Upload failed silently
    } finally {
      URL.revokeObjectURL(pendingPasteImage.blobUrl);
      setPendingPasteImage(null);
    }
  };

  const handlePasteAnnotatorClose = () => {
    if (pendingPasteImage) {
      URL.revokeObjectURL(pendingPasteImage.blobUrl);
      setPendingPasteImage(null);
    }
  };

  // API mode handlers
  const handleApprove = async () => {
    setIsSubmitting(true);
    try {
      const obsidianSettings = getObsidianSettings();
      const bearSettings = getBearSettings();

      // Build request body - include integrations if enabled
      const body: { obsidian?: object; bear?: object; feedback?: string } = {};

      if (obsidianSettings.enabled && obsidianSettings.vaultPath) {
        body.obsidian = {
          vaultPath: obsidianSettings.vaultPath,
          folder: obsidianSettings.folder || 'plannotator',
          plan: markdown,
        };
      }

      if (bearSettings.enabled) {
        body.bear = { plan: markdown };
      }

      // Include annotations as feedback if any exist (for OpenCode "approve with notes")
      if (annotations.length > 0 || globalAttachments.length > 0) {
        body.feedback = diffOutput;
      }

      await fetch('/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setSubmitted('approved');
    } catch {
      setIsSubmitting(false);
    }
  };

  const handleDeny = async () => {
    setIsSubmitting(true);
    try {
      await fetch('/api/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: diffOutput })
      });
      setSubmitted('denied');
    } catch {
      setIsSubmitting(false);
    }
  };

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
    setAnnotations(prev => prev.map(ann =>
      ann.author === oldIdentity ? { ...ann, author: newIdentity } : ann
    ));
  };

  const handleAddGlobalAttachment = (path: string) => {
    setGlobalAttachments(prev => [...prev, path]);
  };

  const handleRemoveGlobalAttachment = (path: string) => {
    setGlobalAttachments(prev => prev.filter(p => p !== path));
  };

  const diffOutput = useMemo(() => exportDiff(blocks, annotations, globalAttachments), [blocks, annotations, globalAttachments]);

  return (
    <ThemeProvider defaultTheme="dark">
      <div className="h-screen flex flex-col bg-background overflow-hidden">
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
            <a
              href="https://github.com/backnotprop/plannotator/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground font-mono opacity-60 hidden md:inline hover:opacity-100 transition-opacity"
            >
              v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'}
            </a>
            {origin && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium hidden md:inline ${
                origin === 'claude-code'
                  ? 'bg-orange-500/15 text-orange-400'
                  : 'bg-zinc-500/20 text-zinc-400'
              }`}>
                {origin === 'claude-code' ? 'Claude Code' : 'OpenCode'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 md:gap-2">
            {isApiMode && (
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
                  title="Deny with Feedback"
                >
                  <svg className="w-4 h-4 md:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <span className="hidden md:inline">{isSubmitting ? 'Sending...' : 'Deny with Feedback'}</span>
                </button>

                <div className="relative group/approve">
                  <button
                    onClick={() => {
                      // Show warning for Claude Code users with annotations
                      if (origin === 'claude-code' && annotations.length > 0) {
                        setShowClaudeCodeWarning(true);
                      } else {
                        handleApprove();
                      }
                    }}
                    disabled={isSubmitting}
                    className={`px-2 py-1 md:px-2.5 rounded-md text-xs font-medium transition-all ${
                      isSubmitting
                        ? 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground'
                        : origin === 'claude-code' && annotations.length > 0
                          ? 'bg-green-600/50 text-white/70 hover:bg-green-600 hover:text-white'
                          : 'bg-green-600 text-white hover:bg-green-500'
                    }`}
                  >
                    <span className="md:hidden">{isSubmitting ? '...' : 'OK'}</span>
                    <span className="hidden md:inline">{isSubmitting ? 'Approving...' : 'Approve'}</span>
                  </button>
                  {origin === 'claude-code' && annotations.length > 0 && (
                    <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-popover border border-border rounded-lg shadow-xl text-xs text-foreground w-56 text-center opacity-0 invisible group-hover/approve:opacity-100 group-hover/approve:visible transition-all pointer-events-none z-50">
                      <div className="absolute bottom-full right-4 border-4 border-transparent border-b-border" />
                      <div className="absolute bottom-full right-4 mt-px border-4 border-transparent border-b-popover" />
                      Claude Code doesn't support feedback on approval. Your annotations won't be seen.
                    </div>
                  )}
                </div>

                <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
              </>
            )}

            <ModeToggle />
            <Settings taterMode={taterMode} onTaterModeChange={handleTaterModeChange} onIdentityChange={handleIdentityChange} />

            <button
              onClick={() => setIsPanelOpen(!isPanelOpen)}
              className={`p-1.5 rounded-md text-xs font-medium transition-all ${
                isPanelOpen
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
            </button>

            <button
              onClick={() => setShowExport(true)}
              className="p-1.5 md:px-2.5 md:py-1 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors"
              title="Export"
            >
              <svg className="w-4 h-4 md:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              <span className="hidden md:inline">Export</span>
            </button>
          </div>
        </header>

        {/* Main Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Document Area */}
          <main className="flex-1 overflow-y-auto bg-grid">
            <div className="min-h-full flex flex-col items-center px-4 py-3 md:px-10 md:py-8 xl:px-16">
              {/* Mode Switcher */}
              <div className="w-full max-w-[832px] 2xl:max-w-5xl mb-3 md:mb-4 flex justify-start">
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
                globalAttachments={globalAttachments}
                onAddGlobalAttachment={handleAddGlobalAttachment}
                onRemoveGlobalAttachment={handleRemoveGlobalAttachment}
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
        <ConfirmDialog
          isOpen={showFeedbackPrompt}
          onClose={() => setShowFeedbackPrompt(false)}
          title="Add Annotations First"
          message="To provide feedback, select text in the plan and add annotations. Claude will use your annotations to revise the plan."
          variant="info"
        />

        {/* Claude Code annotation warning dialog */}
        <ConfirmDialog
          isOpen={showClaudeCodeWarning}
          onClose={() => setShowClaudeCodeWarning(false)}
          onConfirm={() => {
            setShowClaudeCodeWarning(false);
            handleApprove();
          }}
          title="Annotations Won't Be Sent"
          message={<>Claude Code doesn't yet support feedback on approval. Your {annotations.length} annotation{annotations.length !== 1 ? 's' : ''} will be lost.</>}
          subMessage={
            <>
              To send feedback, use <strong>Deny with Feedback</strong> instead.
              <br /><br />
              Want this feature? Upvote these issues:
              <br />
              <a href="https://github.com/anthropics/claude-code/issues/16001" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">#16001</a>
              {' · '}
              <a href="https://github.com/anthropics/claude-code/issues/15755" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">#15755</a>
            </>
          }
          confirmText="Approve Anyway"
          cancelText="Cancel"
          variant="warning"
          showCancel
        />

        {/* Completion overlay - shown after approve/deny */}
        {submitted && (
          <div className="fixed inset-0 z-[100] bg-background flex items-center justify-center">
            <div className="text-center space-y-6 max-w-md px-8">
              <div className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center ${
                submitted === 'approved'
                  ? 'bg-green-500/20 text-green-500'
                  : 'bg-accent/20 text-accent'
              }`}>
                {submitted === 'approved' ? (
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
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

              <div className="pt-4 border-t border-border">
                <p className="text-sm text-muted-foreground">
                  Return to your <span className="text-foreground font-medium">Claude Code terminal</span> to continue.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Update notification */}
        <UpdateBanner />

        {/* Image Annotator for pasted images */}
        <ImageAnnotator
          isOpen={!!pendingPasteImage}
          imageSrc={pendingPasteImage?.blobUrl ?? ''}
          onAccept={handlePasteAnnotatorAccept}
          onClose={handlePasteAnnotatorClose}
        />
      </div>
    </ThemeProvider>
  );
};

export default App;
