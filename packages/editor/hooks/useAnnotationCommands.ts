import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { configStore } from '@plannotator/ui/config';
import type { ViewerHandle } from '@plannotator/ui/components/Viewer';
import type { CodeFileAnnotationInput } from '@plannotator/ui/components/CodeFilePopout';
import type { AnnotationHistoryApi, OverrideSnapshot } from '@plannotator/ui/hooks/useAnnotationHistory';
import type { Annotation, CodeAnnotation, ImageAttachment } from '@plannotator/ui/types';
import { generateId } from '@plannotator/ui/utils/generateId';
import type { CheckboxToggleRecord } from './useCheckboxOverrides';

interface UseAnnotationCommandsOptions {
  history: Pick<AnnotationHistoryApi, 'push'>;
  viewerRef: RefObject<ViewerHandle | null>;
  allAnnotations: Annotation[];
  externalAnnotations: Annotation[];
  codeAnnotationsRef: RefObject<CodeAnnotation[]>;
  annotationsRef: RefObject<Annotation[]>;
  selectedAnnotationIdRef: RefObject<string | null>;
  selectedCodeAnnotationIdRef: RefObject<string | null>;
  globalAttachments: ImageAttachment[];
  setAnnotations: Dispatch<SetStateAction<Annotation[]>>;
  setCodeAnnotations: Dispatch<SetStateAction<CodeAnnotation[]>>;
  setGlobalAttachments: Dispatch<SetStateAction<ImageAttachment[]>>;
  setSelectedAnnotationId: (id: string | null) => void;
  setSelectedCodeAnnotationId: (id: string | null) => void;
  deleteExternalAnnotation: (id: string) => void;
  updateExternalAnnotation: (id: string, updates: Partial<Annotation>) => void;
  getCheckboxOverrides: () => OverrideSnapshot;
  revertCheckboxOverride: (blockId: string) => void;
}

export interface AnnotationCommands {
  addAnnotationRaw: (ann: Annotation) => void;
  removeAnnotationRaw: (id: string) => void;
  recordCheckboxToggle: (record: CheckboxToggleRecord) => void;
  addAnnotation: (ann: Annotation) => void;
  deleteAnnotation: (id: string) => void;
  editAnnotation: (id: string, updates: Partial<Annotation>) => void;
  addCodeAnnotation: (input: CodeFileAnnotationInput) => void;
  deleteCodeAnnotation: (id: string) => void;
  editCodeAnnotation: (id: string, updates: Partial<CodeAnnotation>) => void;
  addGlobalAttachment: (image: ImageAttachment) => void;
  removeGlobalAttachment: (path: string) => void;
  changeIdentity: (oldIdentity: string, newIdentity: string) => void;
}

export function useAnnotationCommands({
  history,
  viewerRef,
  allAnnotations,
  externalAnnotations,
  codeAnnotationsRef,
  annotationsRef,
  selectedAnnotationIdRef,
  selectedCodeAnnotationIdRef,
  globalAttachments,
  setAnnotations,
  setCodeAnnotations,
  setGlobalAttachments,
  setSelectedAnnotationId,
  setSelectedCodeAnnotationId,
  deleteExternalAnnotation,
  updateExternalAnnotation,
  getCheckboxOverrides,
  revertCheckboxOverride,
}: UseAnnotationCommandsOptions): AnnotationCommands {
  const addAnnotationRaw = useCallback((ann: Annotation) => {
    setAnnotations(prev => [...prev, ann]);
    setSelectedAnnotationId(ann.id);
    setSelectedCodeAnnotationId(null);
  }, [setAnnotations, setSelectedAnnotationId, setSelectedCodeAnnotationId]);

  const removeAnnotationRaw = useCallback((id: string) => {
    viewerRef.current?.removeHighlight(id);
    setAnnotations(prev => prev.filter(a => a.id !== id));
    if (selectedAnnotationIdRef.current === id) setSelectedAnnotationId(null);
  }, [selectedAnnotationIdRef, setAnnotations, setSelectedAnnotationId, viewerRef]);

  const recordCheckboxToggle = useCallback((record: CheckboxToggleRecord) => {
    history.push({ kind: 'checkbox-toggle', ...record });
  }, [history]);

  const addAnnotation = useCallback((ann: Annotation) => {
    const prevSelectedId = selectedAnnotationIdRef.current;
    const prevSelectedCodeId = selectedCodeAnnotationIdRef.current;
    addAnnotationRaw(ann);
    history.push({ kind: 'add-annotation', ann, prevSelectedId, prevSelectedCodeId });
  }, [addAnnotationRaw, history, selectedAnnotationIdRef, selectedCodeAnnotationIdRef]);

  const addCodeAnnotation = useCallback((input: CodeFileAnnotationInput) => {
    const prevSelectedId = selectedAnnotationIdRef.current;
    const prevSelectedCodeId = selectedCodeAnnotationIdRef.current;
    const annotation: CodeAnnotation = {
      id: generateId('code-ann'),
      type: 'comment',
      scope: 'line',
      filePath: input.filePath,
      lineStart: input.lineStart,
      lineEnd: input.lineEnd,
      side: 'new',
      text: input.text,
      images: input.images,
      originalCode: input.originalCode,
      createdAt: Date.now(),
      author: configStore.get('displayName') || undefined,
    };

    setCodeAnnotations(prev => [...prev, annotation]);
    setSelectedAnnotationId(null);
    setSelectedCodeAnnotationId(annotation.id);
    history.push({ kind: 'add-code-annotation', ann: annotation, prevSelectedId, prevSelectedCodeId });
  }, [
    history,
    selectedAnnotationIdRef,
    selectedCodeAnnotationIdRef,
    setCodeAnnotations,
    setSelectedAnnotationId,
    setSelectedCodeAnnotationId,
  ]);

  const deleteCodeAnnotation = useCallback((id: string) => {
    const ann = codeAnnotationsRef.current.find(a => a.id === id);
    const prevSelectedCodeId = selectedCodeAnnotationIdRef.current;
    setCodeAnnotations(prev => prev.filter(a => a.id !== id));
    if (prevSelectedCodeId === id) setSelectedCodeAnnotationId(null);
    if (ann) history.push({ kind: 'delete-code-annotation', ann, prevSelectedCodeId });
  }, [codeAnnotationsRef, history, selectedCodeAnnotationIdRef, setCodeAnnotations, setSelectedCodeAnnotationId]);

  const editCodeAnnotation = useCallback((id: string, updates: Partial<CodeAnnotation>) => {
    const prevAnn = codeAnnotationsRef.current.find(a => a.id === id);
    setCodeAnnotations(prev => prev.map(a => a.id === id ? { ...a, ...updates } : a));
    if (prevAnn) history.push({ kind: 'update-code-annotation', prevAnn, nextAnn: { ...prevAnn, ...updates } });
  }, [codeAnnotationsRef, history, setCodeAnnotations]);

  const deleteAnnotation = useCallback((id: string) => {
    const ann = allAnnotations.find(a => a.id === id);
    // External annotations live in the SSE hook, not local annotation state.
    if (ann?.source && externalAnnotations.some(e => e.id === id)) {
      deleteExternalAnnotation(id);
      if (selectedAnnotationIdRef.current === id) setSelectedAnnotationId(null);
      return;
    }

    if (id.startsWith('ann-checkbox-') && ann) {
      const prevOverrides = getCheckboxOverrides();
      const nextOverrides = prevOverrides.filter(([bid]) => bid !== ann.blockId);
      revertCheckboxOverride(ann.blockId);
      removeAnnotationRaw(id);
      history.push({
        kind: 'checkbox-toggle',
        blockId: ann.blockId,
        prevOverrides,
        nextOverrides,
        prevCheckboxAnns: [ann],
        nextCheckboxAnns: [],
      });
      return;
    }

    const prevSelectedId = selectedAnnotationIdRef.current;
    removeAnnotationRaw(id);
    if (ann) history.push({ kind: 'delete-annotation', ann, prevSelectedId });
  }, [
    allAnnotations,
    deleteExternalAnnotation,
    externalAnnotations,
    getCheckboxOverrides,
    history,
    removeAnnotationRaw,
    revertCheckboxOverride,
    selectedAnnotationIdRef,
    setSelectedAnnotationId,
  ]);

  const editAnnotation = useCallback((id: string, updates: Partial<Annotation>) => {
    const ann = allAnnotations.find(a => a.id === id);
    if (ann?.source && externalAnnotations.some(e => e.id === id)) {
      updateExternalAnnotation(id, updates);
      return;
    }

    if (ann) {
      const nextAnn: Annotation = { ...ann, ...updates };
      setAnnotations(prev => prev.map(a => a.id === id ? nextAnn : a));
      history.push({ kind: 'update-annotation', prevAnn: ann, nextAnn });
    } else {
      setAnnotations(prev => prev.map(a => a.id === id ? { ...a, ...updates } : a));
    }
  }, [allAnnotations, externalAnnotations, history, setAnnotations, updateExternalAnnotation]);

  const changeIdentity = useCallback((oldIdentity: string, newIdentity: string) => {
    const affectedAnnIds = annotationsRef.current.filter(a => a.author === oldIdentity).map(a => a.id);
    const affectedCodeAnnIds = codeAnnotationsRef.current.filter(a => a.author === oldIdentity).map(a => a.id);
    setAnnotations(prev => prev.map(ann =>
      ann.author === oldIdentity ? { ...ann, author: newIdentity } : ann
    ));
    setCodeAnnotations(prev => prev.map(ann =>
      ann.author === oldIdentity ? { ...ann, author: newIdentity } : ann
    ));
    if (affectedAnnIds.length > 0 || affectedCodeAnnIds.length > 0) {
      history.push({ kind: 'identity-change', oldIdentity, newIdentity, affectedAnnIds, affectedCodeAnnIds });
    }
  }, [annotationsRef, codeAnnotationsRef, history, setAnnotations, setCodeAnnotations]);

  const addGlobalAttachment = useCallback((image: ImageAttachment) => {
    setGlobalAttachments(prev => [...prev, image]);
    history.push({ kind: 'add-global-attachment', img: image });
  }, [history, setGlobalAttachments]);

  const removeGlobalAttachment = useCallback((path: string) => {
    const img = globalAttachments.find(p => p.path === path);
    setGlobalAttachments(prev => prev.filter(p => p.path !== path));
    if (img) history.push({ kind: 'remove-global-attachment', img });
  }, [globalAttachments, history, setGlobalAttachments]);

  return {
    addAnnotationRaw,
    removeAnnotationRaw,
    recordCheckboxToggle,
    addAnnotation,
    deleteAnnotation,
    editAnnotation,
    addCodeAnnotation,
    deleteCodeAnnotation,
    editCodeAnnotation,
    addGlobalAttachment,
    removeGlobalAttachment,
    changeIdentity,
  };
}
