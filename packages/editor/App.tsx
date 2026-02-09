import React, { useState, useEffect, useMemo, useRef } from 'react';
import { parseMarkdownToBlocks, exportDiff, extractFrontmatter, Frontmatter } from '@plannotator/ui/utils/parser';
import { Viewer, ViewerHandle } from '@plannotator/ui/components/Viewer';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { ExportModal } from '@plannotator/ui/components/ExportModal';
import { ImportModal } from '@plannotator/ui/components/ImportModal';
import { ConfirmDialog } from '@plannotator/ui/components/ConfirmDialog';
import { Annotation, Block, EditorMode } from '@plannotator/ui/types';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { ModeToggle } from '@plannotator/ui/components/ModeToggle';
import { ModeSwitcher } from '@plannotator/ui/components/ModeSwitcher';
import { TaterSpriteRunning } from '@plannotator/ui/components/TaterSpriteRunning';
import { TaterSpritePullup } from '@plannotator/ui/components/TaterSpritePullup';
import { Settings } from '@plannotator/ui/components/Settings';
import { TableOfContents } from '@plannotator/ui/components/TableOfContents';
import { useSharing } from '@plannotator/ui/hooks/useSharing';
import { useAgents } from '@plannotator/ui/hooks/useAgents';
import { useActiveSection } from '@plannotator/ui/hooks/useActiveSection';
import { storage } from '@plannotator/ui/utils/storage';
import { UpdateBanner } from '@plannotator/ui/components/UpdateBanner';
import { getObsidianSettings, getEffectiveVaultPath, isObsidianConfigured, CUSTOM_PATH_SENTINEL } from '@plannotator/ui/utils/obsidian';
import { getBearSettings } from '@plannotator/ui/utils/bear';
import { getDefaultNotesApp } from '@plannotator/ui/utils/defaultNotesApp';
import { getAgentSwitchSettings, getEffectiveAgentName } from '@plannotator/ui/utils/agentSwitch';
import { getPlanSaveSettings } from '@plannotator/ui/utils/planSave';
import { getUIPreferences, needsUIFeaturesSetup, type UIPreferences } from '@plannotator/ui/utils/uiPreferences';
import { getEditorMode, saveEditorMode } from '@plannotator/ui/utils/editorMode';
import {
  getPermissionModeSettings,
  needsPermissionModeSetup,
  type PermissionMode,
} from '@plannotator/ui/utils/permissionMode';
import { PermissionModeSetup } from '@plannotator/ui/components/PermissionModeSetup';
import { UIFeaturesSetup } from '@plannotator/ui/components/UIFeaturesSetup';
import { ImageAnnotator } from '@plannotator/ui/components/ImageAnnotator';

const PLAN_CONTENT = `# Implementation Plan: Real-time Collaboration

## Overview
Add real-time collaboration features to the editor using WebSocket connections and operational transforms.

### Architecture

\`\`\`mermaid
flowchart LR
    subgraph Client["Client Browser"]
        UI[React UI] --> OT[OT Engine]
        OT <--> WS[WebSocket Client]
    end

    subgraph Server["Backend"]
        WSS[WebSocket Server] <--> OTS[OT Transform]
        OTS <--> DB[(PostgreSQL)]
    end

    WS <--> WSS
\`\`\`

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
  const [frontmatter, setFrontmatter] = useState<Frontmatter | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFeedbackPrompt, setShowFeedbackPrompt] = useState(false);
  const [showClaudeCodeWarning, setShowClaudeCodeWarning] = useState(false);
  const [showAgentWarning, setShowAgentWarning] = useState(false);
  const [agentWarningMessage, setAgentWarningMessage] = useState('');
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [editorMode, setEditorMode] = useState<EditorMode>(getEditorMode);
  const [taterMode, setTaterMode] = useState(() => {
    const stored = storage.getItem('plannotator-tater-mode');
    return stored === 'true';
  });
  const [uiPrefs, setUiPrefs] = useState(() => getUIPreferences());
  const [isApiMode, setIsApiMode] = useState(false);
  const [origin, setOrigin] = useState<'claude-code' | 'opencode' | null>(null);
  const [globalAttachments, setGlobalAttachments] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<'approved' | 'denied' | null>(null);
  const [pendingPasteImage, setPendingPasteImage] = useState<{ file: File; blobUrl: string } | null>(null);
  const [showPermissionModeSetup, setShowPermissionModeSetup] = useState(false);
  const [showUIFeaturesSetup, setShowUIFeaturesSetup] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [sharingEnabled, setSharingEnabled] = useState(true);
  const [repoInfo, setRepoInfo] = useState<{ display: string; branch?: string } | null>(null);
  const [showExportDropdown, setShowExportDropdown] = useState(false);
  const [initialExportTab, setInitialExportTab] = useState<'share' | 'diff' | 'notes'>();
  const [noteSaveToast, setNoteSaveToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const viewerRef = useRef<ViewerHandle>(null);
  const containerRef = useRef<HTMLElement>(null);

  // Track active section for TOC highlighting
  const headingCount = useMemo(() => blocks.filter(b => b.type === 'heading').length, [blocks]);
  const activeSection = useActiveSection(containerRef, headingCount);

  // URL-based sharing
  const {
    isSharedSession,
    isLoadingShared,
    shareUrl,
    shareUrlSize,
    pendingSharedAnnotations,
    sharedGlobalAttachments,
    clearPendingSharedAnnotations,
    importFromShareUrl,
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

  // Fetch available agents for OpenCode (for validation on approve)
  const { agents: availableAgents, validateAgent, getAgentWarning } = useAgents(origin);

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

  const handleEditorModeChange = (mode: EditorMode) => {
    setEditorMode(mode);
    saveEditorMode(mode);
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
      .then((data: { plan: string; origin?: 'claude-code' | 'opencode'; sharingEnabled?: boolean; repoInfo?: { display: string; branch?: string } }) => {
        setMarkdown(data.plan);
        setIsApiMode(true);
        if (data.sharingEnabled !== undefined) {
          setSharingEnabled(data.sharingEnabled);
        }
        if (data.repoInfo) {
          setRepoInfo(data.repoInfo);
        }
        if (data.origin) {
          setOrigin(data.origin);
          // For Claude Code, check if user needs to configure permission mode
          if (data.origin === 'claude-code' && needsPermissionModeSetup()) {
            setShowPermissionModeSetup(true);
          } else if (needsUIFeaturesSetup()) {
            setShowUIFeaturesSetup(true);
          }
          // Load saved permission mode preference
          setPermissionMode(getPermissionModeSettings().mode);
        }
      })
      .catch(() => {
        // Not in API mode - use default content
        setIsApiMode(false);
      })
      .finally(() => setIsLoading(false));
  }, [isLoadingShared, isSharedSession]);

  useEffect(() => {
    const { frontmatter: fm } = extractFrontmatter(markdown);
    setFrontmatter(fm);
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
      const agentSwitchSettings = getAgentSwitchSettings();
      const planSaveSettings = getPlanSaveSettings();

      // Build request body - include integrations if enabled
      const body: { obsidian?: object; bear?: object; feedback?: string; agentSwitch?: string; planSave?: { enabled: boolean; customPath?: string }; permissionMode?: string } = {};

      // Include permission mode for Claude Code
      if (origin === 'claude-code') {
        body.permissionMode = permissionMode;
      }

      // Include agent switch setting for OpenCode (effective name handles custom agents)
      const effectiveAgent = getEffectiveAgentName(agentSwitchSettings);
      if (effectiveAgent) {
        body.agentSwitch = effectiveAgent;
      }

      // Include plan save settings
      body.planSave = {
        enabled: planSaveSettings.enabled,
        ...(planSaveSettings.customPath && { customPath: planSaveSettings.customPath }),
      };

      const effectiveVaultPath = getEffectiveVaultPath(obsidianSettings);
      if (obsidianSettings.enabled && effectiveVaultPath) {
        body.obsidian = {
          vaultPath: effectiveVaultPath,
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
      const planSaveSettings = getPlanSaveSettings();
      await fetch('/api/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedback: diffOutput,
          planSave: {
            enabled: planSaveSettings.enabled,
            ...(planSaveSettings.customPath && { customPath: planSaveSettings.customPath }),
          },
        })
      });
      setSubmitted('denied');
    } catch {
      setIsSubmitting(false);
    }
  };

  // Global keyboard shortcuts (Cmd/Ctrl+Enter to submit)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle Cmd/Ctrl+Enter
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;

      // Don't intercept if typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // Don't intercept if any modal is open
      if (showExport || showImport || showFeedbackPrompt || showClaudeCodeWarning ||
          showAgentWarning || showPermissionModeSetup || showUIFeaturesSetup || pendingPasteImage) return;

      // Don't intercept if already submitted or submitting
      if (submitted || isSubmitting) return;

      // Don't intercept in demo/share mode (no API)
      if (!isApiMode) return;

      e.preventDefault();

      // No annotations → Approve, otherwise → Send Feedback
      if (annotations.length === 0) {
        // Check if agent exists for OpenCode users
        if (origin === 'opencode') {
          const warning = getAgentWarning();
          if (warning) {
            setAgentWarningMessage(warning);
            setShowAgentWarning(true);
            return;
          }
        }
        handleApprove();
      } else {
        handleDeny();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    showExport, showImport, showFeedbackPrompt, showClaudeCodeWarning, showAgentWarning,
    showPermissionModeSetup, showUIFeaturesSetup, pendingPasteImage,
    submitted, isSubmitting, isApiMode, annotations.length,
    origin, getAgentWarning,
  ]);

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

  const handleEditAnnotation = (id: string, updates: Partial<Annotation>) => {
    setAnnotations(prev => prev.map(ann =>
      ann.id === id ? { ...ann, ...updates } : ann
    ));
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

  const handleTocNavigate = (blockId: string) => {
    // Navigation handled by TableOfContents component
    // This is just a placeholder for future custom logic
  };

  const diffOutput = useMemo(() => exportDiff(blocks, annotations, globalAttachments), [blocks, annotations, globalAttachments]);

  // Quick-save handlers for export dropdown and keyboard shortcut
  const handleDownloadDiff = () => {
    setShowExportDropdown(false);
    const blob = new Blob([diffOutput], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'annotations.diff';
    a.click();
    URL.revokeObjectURL(url);
    setNoteSaveToast({ type: 'success', message: 'Downloaded diff' });
    setTimeout(() => setNoteSaveToast(null), 3000);
  };

  const handleQuickSaveToNotes = async (target: 'obsidian' | 'bear') => {
    setShowExportDropdown(false);
    const body: { obsidian?: object; bear?: object } = {};

    if (target === 'obsidian') {
      const s = getObsidianSettings();
      const vaultPath = getEffectiveVaultPath(s);
      if (vaultPath) {
        body.obsidian = { vaultPath, folder: s.folder || 'plannotator', plan: markdown };
      }
    }
    if (target === 'bear') {
      body.bear = { plan: markdown };
    }

    try {
      const res = await fetch('/api/save-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      const result = data.results?.[target];
      if (result?.success) {
        setNoteSaveToast({ type: 'success', message: `Saved to ${target === 'obsidian' ? 'Obsidian' : 'Bear'}` });
      } else {
        setNoteSaveToast({ type: 'error', message: result?.error || 'Save failed' });
      }
    } catch {
      setNoteSaveToast({ type: 'error', message: 'Save failed' });
    }
    setTimeout(() => setNoteSaveToast(null), 3000);
  };

  // Cmd/Ctrl+S keyboard shortcut — save to default notes app
  useEffect(() => {
    const handleSaveShortcut = (e: KeyboardEvent) => {
      if (e.key !== 's' || !(e.metaKey || e.ctrlKey)) return;

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (showExport || showFeedbackPrompt || showClaudeCodeWarning ||
          showAgentWarning || showPermissionModeSetup || showUIFeaturesSetup || pendingPasteImage) return;

      if (submitted || !isApiMode) return;

      e.preventDefault();

      const defaultApp = getDefaultNotesApp();
      const obsOk = isObsidianConfigured();
      const bearOk = getBearSettings().enabled;

      if (defaultApp === 'download') {
        handleDownloadDiff();
      } else if (defaultApp === 'obsidian' && obsOk) {
        handleQuickSaveToNotes('obsidian');
      } else if (defaultApp === 'bear' && bearOk) {
        handleQuickSaveToNotes('bear');
      } else {
        setInitialExportTab('notes');
        setShowExport(true);
      }
    };

    window.addEventListener('keydown', handleSaveShortcut);
    return () => window.removeEventListener('keydown', handleSaveShortcut);
  }, [
    showExport, showFeedbackPrompt, showClaudeCodeWarning, showAgentWarning,
    showPermissionModeSetup, showUIFeaturesSetup, pendingPasteImage,
    submitted, isApiMode, markdown, diffOutput,
  ]);

  // Close export dropdown on click outside
  useEffect(() => {
    if (!showExportDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-export-dropdown]')) {
        setShowExportDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showExportDropdown]);

  const agentName = useMemo(() => {
    if (origin === 'opencode') return 'OpenCode';
    if (origin === 'claude-code') return 'Claude Code';
    return 'Coding Agent';
  }, [origin]);

  return (
    <ThemeProvider defaultTheme="dark">
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        {/* Tater sprites */}
        {taterMode && <TaterSpriteRunning />}
        {/* Minimal Header */}
        <header className="h-12 flex items-center justify-between px-2 md:px-4 border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-20">
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
                {agentName}
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
                  title="Send Feedback"
                >
                  <svg className="w-4 h-4 md:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <span className="hidden md:inline">{isSubmitting ? 'Sending...' : 'Send Feedback'}</span>
                </button>

                <div className="relative group/approve">
                  <button
                    onClick={() => {
                      // Show warning for Claude Code users with annotations
                      if (origin === 'claude-code' && annotations.length > 0) {
                        setShowClaudeCodeWarning(true);
                        return;
                      }

                      // Check if agent exists for OpenCode users
                      if (origin === 'opencode') {
                        const warning = getAgentWarning();
                        if (warning) {
                          setAgentWarningMessage(warning);
                          setShowAgentWarning(true);
                          return;
                        }
                      }

                      handleApprove();
                    }}
                    disabled={isSubmitting}
                    className={`px-2 py-1 md:px-2.5 rounded-md text-xs font-medium transition-all ${
                      isSubmitting
                        ? 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground'
                        : origin === 'claude-code' && annotations.length > 0
                          ? 'bg-success/50 text-success-foreground/70 hover:bg-success hover:text-success-foreground'
                          : 'bg-success text-success-foreground hover:opacity-90'
                    }`}
                  >
                    <span className="md:hidden">{isSubmitting ? '...' : 'OK'}</span>
                    <span className="hidden md:inline">{isSubmitting ? 'Approving...' : 'Approve'}</span>
                  </button>
                  {origin === 'claude-code' && annotations.length > 0 && (
                    <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-popover border border-border rounded-lg shadow-xl text-xs text-foreground w-56 text-center opacity-0 invisible group-hover/approve:opacity-100 group-hover/approve:visible transition-all pointer-events-none z-50">
                      <div className="absolute bottom-full right-4 border-4 border-transparent border-b-border" />
                      <div className="absolute bottom-full right-4 mt-px border-4 border-transparent border-b-popover" />
                      {agentName} doesn't support feedback on approval. Your annotations won't be seen.
                    </div>
                  )}
                </div>

                <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
              </>
            )}

            <ModeToggle />
            <Settings taterMode={taterMode} onTaterModeChange={handleTaterModeChange} onIdentityChange={handleIdentityChange} origin={origin} onUIPreferencesChange={setUiPrefs} />

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

            <div className="relative flex" data-export-dropdown>
              <button
                onClick={() => { setInitialExportTab(undefined); setShowExport(true); }}
                className="p-1.5 md:px-2.5 md:py-1 rounded-l-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors"
                title="Export"
              >
                <svg className="w-4 h-4 md:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                <span className="hidden md:inline">Export</span>
              </button>
              <button
                onClick={() => setShowExportDropdown(prev => !prev)}
                className="px-1 md:px-1.5 rounded-r-md text-xs bg-muted hover:bg-muted/80 border-l border-border/50 transition-colors flex items-center"
                title="Quick save options"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {showExportDropdown && (
                <div className="absolute top-full right-0 mt-1 w-48 bg-popover border border-border rounded-lg shadow-xl z-50 py-1">
                  {sharingEnabled && (
                    <button
                      onClick={async () => {
                        setShowExportDropdown(false);
                        try {
                          await navigator.clipboard.writeText(shareUrl);
                          setNoteSaveToast({ type: 'success', message: 'Share link copied' });
                        } catch {
                          setNoteSaveToast({ type: 'error', message: 'Failed to copy' });
                        }
                        setTimeout(() => setNoteSaveToast(null), 3000);
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors flex items-center gap-2"
                    >
                      <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                      </svg>
                      Copy Share Link
                    </button>
                  )}
                  <button
                    onClick={handleDownloadDiff}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors flex items-center gap-2"
                  >
                    <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download Diff
                  </button>
                  {isApiMode && isObsidianConfigured() && (
                    <button
                      onClick={() => handleQuickSaveToNotes('obsidian')}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors flex items-center gap-2"
                    >
                      <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                      </svg>
                      Save to Obsidian
                    </button>
                  )}
                  {isApiMode && getBearSettings().enabled && (
                    <button
                      onClick={() => handleQuickSaveToNotes('bear')}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors flex items-center gap-2"
                    >
                      <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                      </svg>
                      Save to Bear
                    </button>
                  )}
                  {isApiMode && !isObsidianConfigured() && !getBearSettings().enabled && (
                    <div className="px-3 py-2 text-[10px] text-muted-foreground">
                      No notes apps configured.
                    </div>
                  )}
                  {sharingEnabled && (
                    <>
                      <div className="my-1 border-t border-border" />
                      <button
                        onClick={() => {
                          setShowExportDropdown(false);
                          setShowImport(true);
                        }}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors flex items-center gap-2"
                      >
                        <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        Import Review
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Main Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Table of Contents */}
          {uiPrefs.tocEnabled && (
            <TableOfContents
              blocks={blocks}
              annotations={annotations}
              activeId={activeSection}
              onNavigate={handleTocNavigate}
              className="hidden lg:block w-60 sticky top-12 h-[calc(100vh-3rem)] flex-shrink-0"
            />
          )}

          {/* Document Area */}
          <main ref={containerRef} className="flex-1 overflow-y-auto bg-grid">
            <div className="min-h-full flex flex-col items-center px-4 py-3 md:px-10 md:py-8 xl:px-16">
              {/* Mode Switcher */}
              <div className="w-full max-w-[832px] 2xl:max-w-5xl mb-3 md:mb-4 flex justify-start">
                <ModeSwitcher mode={editorMode} onChange={handleEditorModeChange} taterMode={taterMode} />
              </div>

              <Viewer
                ref={viewerRef}
                blocks={blocks}
                markdown={markdown}
                frontmatter={frontmatter}
                annotations={annotations}
                onAddAnnotation={handleAddAnnotation}
                onSelectAnnotation={setSelectedAnnotationId}
                selectedAnnotationId={selectedAnnotationId}
                mode={editorMode}
                taterMode={taterMode}
                globalAttachments={globalAttachments}
                onAddGlobalAttachment={handleAddGlobalAttachment}
                onRemoveGlobalAttachment={handleRemoveGlobalAttachment}
                repoInfo={repoInfo}
                stickyActions={uiPrefs.stickyActionsEnabled}
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
            onEdit={handleEditAnnotation}
            shareUrl={shareUrl}
            sharingEnabled={sharingEnabled}
          />
        </div>

        {/* Export Modal */}
        <ExportModal
          isOpen={showExport}
          onClose={() => { setShowExport(false); setInitialExportTab(undefined); }}
          shareUrl={shareUrl}
          shareUrlSize={shareUrlSize}
          diffOutput={diffOutput}
          annotationCount={annotations.length}
          taterSprite={taterMode ? <TaterSpritePullup /> : undefined}
          sharingEnabled={sharingEnabled}
          markdown={markdown}
          isApiMode={isApiMode}
          initialTab={initialExportTab}
        />

        {/* Import Modal */}
        <ImportModal
          isOpen={showImport}
          onClose={() => setShowImport(false)}
          onImport={importFromShareUrl}
        />

        {/* Feedback prompt dialog */}
        <ConfirmDialog
          isOpen={showFeedbackPrompt}
          onClose={() => setShowFeedbackPrompt(false)}
          title="Add Annotations First"
          message={`To provide feedback, select text in the plan and add annotations. ${agentName} will use your annotations to revise the plan.`}
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
          message={<>{agentName} doesn't yet support feedback on approval. Your {annotations.length} annotation{annotations.length !== 1 ? 's' : ''} will be lost.</>}
          subMessage={
            <>
              To send feedback, use <strong>Send Feedback</strong> instead.
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

        {/* OpenCode agent not found warning dialog */}
        <ConfirmDialog
          isOpen={showAgentWarning}
          onClose={() => setShowAgentWarning(false)}
          onConfirm={() => {
            setShowAgentWarning(false);
            handleApprove();
          }}
          title="Agent Not Found"
          message={agentWarningMessage}
          subMessage={
            <>
              You can change the agent in <strong>Settings</strong>, or approve anyway and OpenCode will use the default agent.
            </>
          }
          confirmText="Approve Anyway"
          cancelText="Cancel"
          variant="warning"
          showCancel
        />

        {/* Save-to-notes toast */}
        {noteSaveToast && (
          <div className={`fixed top-16 right-4 z-50 px-3 py-2 rounded-lg text-xs font-medium shadow-lg transition-opacity ${
            noteSaveToast.type === 'success'
              ? 'bg-success/15 text-success border border-success/30'
              : 'bg-destructive/15 text-destructive border border-destructive/30'
          }`}>
            {noteSaveToast.message}
          </div>
        )}

        {/* Completion overlay - shown after approve/deny */}
        {submitted && (
          <div className="fixed inset-0 z-[100] bg-background flex items-center justify-center">
            <div className="text-center space-y-6 max-w-md px-8">
              <div className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center ${
                submitted === 'approved'
                  ? 'bg-success/20 text-success'
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
                    ? `${agentName} will proceed with the implementation.`
                    : `${agentName} will revise the plan based on your annotations.`}
                </p>
              </div>

              <div className="pt-4 border-t border-border space-y-2">
                <p className="text-sm text-muted-foreground">
                  You can close this tab and return to <span className="text-foreground font-medium">{agentName}</span>.
                </p>
                <p className="text-xs text-muted-foreground/60">
                  Your response has been sent.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Update notification */}
        <UpdateBanner origin={origin} />

        {/* Image Annotator for pasted images */}
        <ImageAnnotator
          isOpen={!!pendingPasteImage}
          imageSrc={pendingPasteImage?.blobUrl ?? ''}
          onAccept={handlePasteAnnotatorAccept}
          onClose={handlePasteAnnotatorClose}
        />

        {/* Permission Mode Setup (Claude Code first-time) */}
        <PermissionModeSetup
          isOpen={showPermissionModeSetup}
          onComplete={(mode) => {
            setPermissionMode(mode);
            setShowPermissionModeSetup(false);
            if (needsUIFeaturesSetup()) {
              setShowUIFeaturesSetup(true);
            }
          }}
        />

        {/* UI Features Setup (TOC & Sticky Actions) */}
        <UIFeaturesSetup
          isOpen={showUIFeaturesSetup}
          onComplete={(prefs) => {
            setUiPrefs(prefs);
            setShowUIFeaturesSetup(false);
          }}
        />
      </div>
    </ThemeProvider>
  );
};

export default App;
