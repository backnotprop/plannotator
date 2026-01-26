/**
 * useAnnotations - State management for annotations
 * Can be used with Zustand in Happy or standalone with useState
 */

import { useState, useCallback, useMemo } from 'react';
import { Annotation, AnnotationType } from '@plannotator/core';

export interface UseAnnotationsReturn {
  annotations: Annotation[];
  addAnnotation: (annotation: Annotation) => void;
  removeAnnotation: (id: string) => void;
  updateAnnotation: (id: string, updates: Partial<Annotation>) => void;
  clearAnnotations: () => void;
  getAnnotationsByBlock: (blockId: string) => Annotation[];
  annotationCount: number;
}

/**
 * Hook for managing annotation state
 */
export function useAnnotations(initialAnnotations: Annotation[] = []): UseAnnotationsReturn {
  const [annotations, setAnnotations] = useState<Annotation[]>(initialAnnotations);

  const addAnnotation = useCallback((annotation: Annotation) => {
    setAnnotations(prev => [...prev, annotation]);
  }, []);

  const removeAnnotation = useCallback((id: string) => {
    setAnnotations(prev => prev.filter(a => a.id !== id));
  }, []);

  const updateAnnotation = useCallback((id: string, updates: Partial<Annotation>) => {
    setAnnotations(prev =>
      prev.map(a => (a.id === id ? { ...a, ...updates } : a))
    );
  }, []);

  const clearAnnotations = useCallback(() => {
    setAnnotations([]);
  }, []);

  const getAnnotationsByBlock = useCallback(
    (blockId: string) => annotations.filter(a => a.blockId === blockId),
    [annotations]
  );

  const annotationCount = useMemo(() => annotations.length, [annotations]);

  return {
    annotations,
    addAnnotation,
    removeAnnotation,
    updateAnnotation,
    clearAnnotations,
    getAnnotationsByBlock,
    annotationCount,
  };
}

/**
 * Helper to create a new annotation
 */
export function createAnnotation(params: {
  blockId: string;
  type: AnnotationType;
  originalText: string;
  startOffset: number;
  endOffset: number;
  text?: string;
  author?: string;
  imagePaths?: string[];
}): Annotation {
  return {
    id: `ann-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    blockId: params.blockId,
    type: params.type,
    originalText: params.originalText,
    startOffset: params.startOffset,
    endOffset: params.endOffset,
    text: params.text,
    author: params.author,
    imagePaths: params.imagePaths,
    createdAt: Date.now(),
  };
}
