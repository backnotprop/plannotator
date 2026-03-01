import { useState, useCallback, useRef, useEffect } from 'react';
import { CodeAnnotation, SelectedLineRange, CodeAnnotationType } from '@plannotator/ui/types';
import { useDismissOnOutsideAndEscape } from '@plannotator/ui/hooks/useDismissOnOutsideAndEscape';
import { extractLinesFromPatch } from '../utils/patchParser';

export interface ToolbarState {
  position: { top: number; left: number };
  range: SelectedLineRange;
}

interface UseAnnotationToolbarArgs {
  patch: string;
  filePath: string;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string) => void;
  onEditAnnotation: (id: string, text?: string, suggestedCode?: string, originalCode?: string) => void;
}

// Per-range draft storage (survives component remounts, e.g. file switches)
interface Draft {
  commentText: string;
  suggestedCode: string;
  showSuggestedCode: boolean;
}

const draftStore = new Map<string, Draft>();

function draftKey(filePath: string, range: SelectedLineRange): string {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  return `${filePath}:${range.side}:${start}-${end}`;
}

export function useAnnotationToolbar({ patch, filePath, onLineSelection, onAddAnnotation, onEditAnnotation }: UseAnnotationToolbarArgs) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const lastMousePosition = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [toolbarState, setToolbarState] = useState<ToolbarState | null>(null);
  const [commentText, setCommentText] = useState('');
  const [suggestedCode, setSuggestedCode] = useState('');
  const [showSuggestedCode, setShowSuggestedCode] = useState(false);
  const [selectedOriginalCode, setSelectedOriginalCode] = useState('');
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [modalLayout, setModalLayout] = useState<'horizontal' | 'vertical'>('horizontal');
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);

  // Refs to avoid stale closures in saveDraft
  const formRef = useRef({ commentText, suggestedCode, showSuggestedCode });
  formRef.current = { commentText, suggestedCode, showSuggestedCode };
  const toolbarStateRef = useRef(toolbarState);
  toolbarStateRef.current = toolbarState;
  const editingRef = useRef(editingAnnotationId);
  editingRef.current = editingAnnotationId;

  const saveDraft = useCallback(() => {
    const range = toolbarStateRef.current?.range;
    if (!range || editingRef.current) return;
    const form = formRef.current;
    const key = draftKey(filePath, range);
    if (form.commentText.trim() || form.suggestedCode.trim()) {
      draftStore.set(key, { ...form });
    } else {
      draftStore.delete(key);
    }
  }, [filePath]);

  const clearDraft = useCallback(() => {
    const range = toolbarStateRef.current?.range;
    if (!range) return;
    draftStore.delete(draftKey(filePath, range));
  }, [filePath]);

  // Save draft on unmount (e.g. file switch)
  useEffect(() => {
    return () => saveDraft();
  }, [saveDraft]);

  const resetForm = useCallback(() => {
    setToolbarState(null);
    setCommentText('');
    setSuggestedCode('');
    setSelectedOriginalCode('');
    setShowSuggestedCode(false);
    setShowCodeModal(false);
    setEditingAnnotationId(null);
  }, []);

  // Track mouse position continuously for toolbar placement
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    lastMousePosition.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Handle line selection end
  const handleLineSelectionEnd = useCallback((range: SelectedLineRange | null) => {
    if (!range) {
      setToolbarState(null);
      onLineSelection(null);
      return;
    }

    // Save current draft before switching
    saveDraft();
    setEditingAnnotationId(null);

    // Restore draft for new range or start fresh
    const draft = draftStore.get(draftKey(filePath, range));
    if (draft) {
      setCommentText(draft.commentText);
      setSuggestedCode(draft.suggestedCode);
      setShowSuggestedCode(draft.showSuggestedCode);
    } else {
      setCommentText('');
      setSuggestedCode('');
      setShowSuggestedCode(false);
    }

    const mousePos = lastMousePosition.current;
    setToolbarState({
      position: {
        top: mousePos.y + 10,
        left: mousePos.x,
      },
      range,
    });

    // Pre-extract original code from selected lines
    const side = range.side === 'additions' ? 'new' : 'old';
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    setSelectedOriginalCode(extractLinesFromPatch(patch, start, end, side as 'old' | 'new'));

    onLineSelection(range);
  }, [patch, filePath, onLineSelection, saveDraft]);

  // Handle annotation submission (create or update)
  const handleSubmitAnnotation = useCallback(() => {
    const hasComment = commentText.trim().length > 0;
    const hasCode = suggestedCode.trim().length > 0;
    if (!toolbarState || (!hasComment && !hasCode)) return;

    const text = hasComment ? commentText.trim() : undefined;
    const code = hasCode ? suggestedCode : undefined;
    const original = hasCode && selectedOriginalCode ? selectedOriginalCode : undefined;

    if (editingAnnotationId) {
      onEditAnnotation(editingAnnotationId, text, code, original);
    } else {
      onAddAnnotation('comment', text, code, original);
    }

    clearDraft();
    resetForm();
  }, [toolbarState, commentText, suggestedCode, selectedOriginalCode, editingAnnotationId, onAddAnnotation, onEditAnnotation, clearDraft, resetForm]);

  // Start editing an existing annotation
  const startEdit = useCallback((annotation: CodeAnnotation) => {
    setEditingAnnotationId(annotation.id);
    setCommentText(annotation.text || '');
    setSuggestedCode(annotation.suggestedCode || '');
    setSelectedOriginalCode(annotation.originalCode || '');
    setShowSuggestedCode(!!annotation.suggestedCode);
    setShowCodeModal(false);

    // Position toolbar near the annotation using last known mouse position
    const mousePos = lastMousePosition.current;
    setToolbarState({
      position: { top: mousePos.y + 10, left: mousePos.x },
      range: {
        start: annotation.lineStart,
        end: annotation.lineEnd,
        side: annotation.side === 'new' ? 'additions' : 'deletions',
      },
    });
  }, []);

  // Dismiss: save draft and hide toolbar
  const handleDismiss = useCallback(() => {
    saveDraft();
    setToolbarState(null);
    onLineSelection(null);
  }, [onLineSelection, saveDraft]);

  // Cancel: explicit discard via X button -- clears draft and form
  const handleCancel = useCallback(() => {
    clearDraft();
    resetForm();
    onLineSelection(null);
  }, [onLineSelection, clearDraft, resetForm]);

  useDismissOnOutsideAndEscape({
    enabled: !!toolbarState && !showCodeModal,
    ref: toolbarRef,
    onDismiss: handleDismiss,
  });

  return {
    // State
    toolbarState,
    commentText,
    setCommentText,
    suggestedCode,
    setSuggestedCode,
    showSuggestedCode,
    setShowSuggestedCode,
    selectedOriginalCode,
    showCodeModal,
    setShowCodeModal,
    modalLayout,
    setModalLayout,
    editingAnnotationId,
    // Refs
    toolbarRef,
    // Handlers
    handleMouseMove,
    handleLineSelectionEnd,
    handleSubmitAnnotation,
    handleDismiss,
    handleCancel,
    startEdit,
  };
}
