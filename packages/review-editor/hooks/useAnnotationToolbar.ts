import { useState, useCallback, useRef, useEffect } from 'react';
import { CodeAnnotation, SelectedLineRange, CodeAnnotationType, TokenAnnotationMeta, ConventionalLabel, ConventionalDecoration } from '@plannotator/ui/types';
import { useDismissOnOutsideAndEscape } from '@plannotator/ui/hooks/useDismissOnOutsideAndEscape';
import { extractLinesFromPatch } from '../utils/patchParser';
import type { DiffTokenEventBaseProps } from '@pierre/diffs';

export interface TokenMeta {
  lineNumber: number;
  charStart: number;
  charEnd: number;
  tokenText: string;
  side: 'deletions' | 'additions';
}

export interface TokenSelection {
  anchor: TokenMeta;
  fullText: string;
}

export interface ToolbarState {
  position: { top: number; left: number };
  range: SelectedLineRange;
  tokenSelection?: TokenSelection;
}

interface UseAnnotationToolbarArgs {
  patch: string;
  filePath: string;
  isFocused: boolean;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel, decorations?: ConventionalDecoration[], tokenMeta?: TokenAnnotationMeta) => void;
  onEditAnnotation: (id: string, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel | null, decorations?: ConventionalDecoration[]) => void;
}

// Per-range draft storage (survives component remounts, e.g. file switches)
interface Draft {
  commentText: string;
  suggestedCode: string;
  showSuggestedCode: boolean;
  conventionalLabel: ConventionalLabel | null;
  decorations: ConventionalDecoration[];
  range: SelectedLineRange;
  position: { top: number; left: number };
  tokenSelection?: TokenSelection;
}

const draftStore = new Map<string, Draft>();
const restoreDraftKeyByFilePath = new Map<string, string>();

function draftKey(filePath: string, range: SelectedLineRange): string {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  return `${filePath}:${range.side}:${start}-${end}`;
}

export function useAnnotationToolbar({ patch, filePath, isFocused, onLineSelection, onAddAnnotation, onEditAnnotation }: UseAnnotationToolbarArgs) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const lastMousePosition = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const tokenAnchorRef = useRef<TokenMeta | null>(null);

  const [toolbarState, setToolbarState] = useState<ToolbarState | null>(null);
  const [commentText, setCommentText] = useState('');
  const [suggestedCode, setSuggestedCode] = useState('');
  const [showSuggestedCode, setShowSuggestedCode] = useState(false);
  const [selectedOriginalCode, setSelectedOriginalCode] = useState('');
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [modalLayout, setModalLayout] = useState<'horizontal' | 'vertical'>('horizontal');
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [conventionalLabel, setConventionalLabel] = useState<ConventionalLabel | null>(null);
  const [decorations, setDecorations] = useState<ConventionalDecoration[]>([]);

  // Refs to avoid stale closures in saveDraft
  const formRef = useRef({ commentText, suggestedCode, showSuggestedCode, conventionalLabel, decorations });
  formRef.current = { commentText, suggestedCode, showSuggestedCode, conventionalLabel, decorations };
  const toolbarStateRef = useRef(toolbarState);
  toolbarStateRef.current = toolbarState;
  const editingRef = useRef(editingAnnotationId);
  editingRef.current = editingAnnotationId;
  const currentDraftKeyRef = useRef<string | null>(null);
  const wasFocusedRef = useRef(isFocused);

  const saveDraft = useCallback(() => {
    const range = toolbarStateRef.current?.range;
    if (!range || editingRef.current) return;
    const form = formRef.current;
    const key = draftKey(filePath, range);
    if (form.commentText.trim() || form.suggestedCode.trim() || form.conventionalLabel) {
      draftStore.set(key, {
        ...form,
        range,
        position: toolbarStateRef.current?.position ?? { top: 0, left: 0 },
        tokenSelection: toolbarStateRef.current?.tokenSelection,
      });
      currentDraftKeyRef.current = key;
    } else {
      draftStore.delete(key);
      if (currentDraftKeyRef.current === key) {
        currentDraftKeyRef.current = null;
      }
    }
  }, [filePath]);

  const clearDraft = useCallback(() => {
    const range = toolbarStateRef.current?.range;
    if (!range) return;
    const key = draftKey(filePath, range);
    draftStore.delete(key);
    restoreDraftKeyByFilePath.delete(filePath);
    if (currentDraftKeyRef.current === key) {
      currentDraftKeyRef.current = null;
    }
  }, [filePath]);

  // Save draft on unmount (e.g. file switch)
  useEffect(() => {
    return () => saveDraft();
  }, [saveDraft]);

  // Clear token anchor on file switch
  useEffect(() => {
    tokenAnchorRef.current = null;
  }, [filePath]);

  const resetForm = useCallback(() => {
    setToolbarState(null);
    setCommentText('');
    setSuggestedCode('');
    setSelectedOriginalCode('');
    setShowSuggestedCode(false);
    setShowCodeModal(false);
    setEditingAnnotationId(null);
    setConventionalLabel(null);
    setDecorations([]);
  }, []);

  // Track mouse position continuously for toolbar placement.
  // Structural type so the same handler accepts both React synthetic events
  // (parent JSX onMouseMove) and native MouseEvents (ToolbarHost window listener).
  const handleMouseMove = useCallback((e: { clientX: number; clientY: number }) => {
    lastMousePosition.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Shared: save current draft, restore form for new range, set toolbar state, notify parent
  const openToolbar = useCallback((
    range: SelectedLineRange,
    position: { top: number; left: number },
    tokenSelection?: TokenSelection,
  ) => {
    saveDraft();
    setEditingAnnotationId(null);

    const draft = draftStore.get(draftKey(filePath, range));
    if (draft) {
      setCommentText(draft.commentText);
      setSuggestedCode(draft.suggestedCode);
      setShowSuggestedCode(draft.showSuggestedCode);
      setConventionalLabel(draft.conventionalLabel);
      setDecorations(draft.decorations);
    } else {
      setCommentText('');
      setSuggestedCode('');
      setShowSuggestedCode(false);
      setConventionalLabel(null);
      setDecorations([]);
    }

    setToolbarState({ position, range, tokenSelection });
    currentDraftKeyRef.current = draftKey(filePath, range);
    restoreDraftKeyByFilePath.delete(filePath);

    const side = range.side === 'additions' ? 'new' : 'old';
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    setSelectedOriginalCode(extractLinesFromPatch(patch, start, end, side as 'old' | 'new'));

    onLineSelection(range);
  }, [patch, filePath, onLineSelection, saveDraft]);

  // Handle line selection end (gutter clicks)
  const handleLineSelectionEnd = useCallback((range: SelectedLineRange | null) => {
    tokenAnchorRef.current = null;

    if (!range) {
      setToolbarState(null);
      onLineSelection(null);
      return;
    }

    const mousePos = lastMousePosition.current;
    openToolbar(range, { top: mousePos.y + 10, left: mousePos.x });
  }, [onLineSelection, openToolbar]);

  // Handle annotation submission (create or update)
  const handleSubmitAnnotation = useCallback(() => {
    const hasComment = commentText.trim().length > 0;
    const hasCode = suggestedCode.trim().length > 0;
    if (!toolbarState || (!hasComment && !hasCode)) return;

    const text = hasComment ? commentText.trim() : undefined;
    const code = hasCode ? suggestedCode : undefined;
    const original = hasCode && selectedOriginalCode ? selectedOriginalCode : undefined;

    if (editingAnnotationId) {
      // Edit path: pass null explicitly so a cleared label is removed from the annotation
      onEditAnnotation(editingAnnotationId, text, code, original, conventionalLabel, decorations);
    } else {
      const tokenSel = toolbarState.tokenSelection;
      const tokenMeta = tokenSel ? {
        charStart: tokenSel.anchor.charStart,
        charEnd: tokenSel.anchor.charEnd,
        tokenText: tokenSel.fullText,
      } : undefined;
      onAddAnnotation(
        'comment',
        text,
        code,
        original,
        conventionalLabel ?? undefined,
        decorations.length > 0 ? decorations : undefined,
        tokenMeta,
      );
    }

    clearDraft();
    resetForm();
  }, [toolbarState, commentText, suggestedCode, selectedOriginalCode, editingAnnotationId, conventionalLabel, decorations, onAddAnnotation, onEditAnnotation, clearDraft, resetForm]);

  // Start editing an existing annotation
  const startEdit = useCallback((annotation: CodeAnnotation) => {
    setEditingAnnotationId(annotation.id);
    setCommentText(annotation.text || '');
    setSuggestedCode(annotation.suggestedCode || '');
    setSelectedOriginalCode(annotation.originalCode || '');
    setShowSuggestedCode(!!annotation.suggestedCode);
    setShowCodeModal(false);
    setConventionalLabel(annotation.conventionalLabel || null);
    setDecorations(annotation.decorations || []);

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

  useEffect(() => {
    const wasFocused = wasFocusedRef.current;
    wasFocusedRef.current = isFocused;

    if (wasFocused && !isFocused) {
      const key = currentDraftKeyRef.current;
      if (key && draftStore.has(key)) {
        restoreDraftKeyByFilePath.set(filePath, key);
      }
      return;
    }

    if (!wasFocused && isFocused && !toolbarStateRef.current) {
      const key = restoreDraftKeyByFilePath.get(filePath);
      const draft = key ? draftStore.get(key) : undefined;
      if (!draft) return;

      setCommentText(draft.commentText);
      setSuggestedCode(draft.suggestedCode);
      setShowSuggestedCode(draft.showSuggestedCode);
      setConventionalLabel(draft.conventionalLabel);
      setDecorations(draft.decorations);
      setEditingAnnotationId(null);
      setShowCodeModal(false);
      setToolbarState({
        position: draft.position,
        range: draft.range,
        tokenSelection: draft.tokenSelection,
      });
      currentDraftKeyRef.current = key;
      restoreDraftKeyByFilePath.delete(filePath);

      const side = draft.range.side === 'additions' ? 'new' : 'old';
      const start = Math.min(draft.range.start, draft.range.end);
      const end = Math.max(draft.range.start, draft.range.end);
      setSelectedOriginalCode(extractLinesFromPatch(patch, start, end, side as 'old' | 'new'));
      onLineSelection(draft.range);
    }
  }, [filePath, isFocused, onLineSelection, patch]);

  // Handle single token click — opens toolbar for one token
  const handleTokenClick = useCallback((props: DiffTokenEventBaseProps, event: MouseEvent) => {
    const clickedToken: TokenMeta = {
      lineNumber: props.lineNumber,
      charStart: props.lineCharStart,
      charEnd: props.lineCharEnd,
      tokenText: props.tokenText,
      side: props.side,
    };

    // Same token clicked twice → deselect
    const anchor = tokenAnchorRef.current;
    if (anchor && anchor.lineNumber === clickedToken.lineNumber
      && anchor.charStart === clickedToken.charStart
      && anchor.side === clickedToken.side) {
      tokenAnchorRef.current = null;
      setToolbarState(null);
      onLineSelection(null);
      return;
    }

    tokenAnchorRef.current = clickedToken;
    openToolbar(
      { start: clickedToken.lineNumber, end: clickedToken.lineNumber, side: clickedToken.side },
      { top: event.clientY + 10, left: event.clientX },
      { anchor: clickedToken, fullText: clickedToken.tokenText },
    );
  }, [onLineSelection, openToolbar]);

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
    conventionalLabel,
    setConventionalLabel,
    decorations,
    setDecorations,
    // Refs
    toolbarRef,
    // Handlers
    handleMouseMove,
    handleLineSelectionEnd,
    handleTokenClick,
    handleSubmitAnnotation,
    handleDismiss,
    handleCancel,
    startEdit,
  };
}
