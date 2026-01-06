import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Canvas } from './Canvas';
import { Toolbar } from './Toolbar';
import { renderStroke } from './utils';
import type { Point, Stroke, Tool, AnnotatorState } from './types';
import { DEFAULT_STATE } from './types';

interface ImageAnnotatorProps {
  imageSrc: string;
  isOpen: boolean;
  onAccept: (blob: Blob, hasDrawings: boolean) => Promise<void>;
  onClose: () => void;
}

export const ImageAnnotator: React.FC<ImageAnnotatorProps> = ({
  imageSrc,
  isOpen,
  onAccept,
  onClose,
}) => {
  const [state, setState] = useState<AnnotatorState>(DEFAULT_STATE);
  const [saving, setSaving] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setState(DEFAULT_STATE);
    }
  }, [isOpen]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape or Enter to accept
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        handleAccept();
        return;
      }

      // Cmd+Z to undo
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        handleUndo();
        return;
      }

      // 1/2/3 to switch tools
      if (e.key === '1') setState(s => ({ ...s, tool: 'pen' }));
      if (e.key === '2') setState(s => ({ ...s, tool: 'arrow' }));
      if (e.key === '3') setState(s => ({ ...s, tool: 'circle' }));
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, state.strokes]);

  const handleStrokeStart = useCallback((point: Point) => {
    const id = crypto.randomUUID();
    setState(s => ({
      ...s,
      currentStroke: {
        id,
        tool: s.tool,
        points: [point],
        color: s.color,
        size: s.strokeSize,
      },
    }));
  }, []);

  const handleStrokeMove = useCallback((point: Point) => {
    setState(s => {
      if (!s.currentStroke) return s;
      return {
        ...s,
        currentStroke: {
          ...s.currentStroke,
          points: [...s.currentStroke.points, point],
        },
      };
    });
  }, []);

  const handleStrokeEnd = useCallback(() => {
    setState(s => {
      if (!s.currentStroke || s.currentStroke.points.length < 2) {
        return { ...s, currentStroke: null };
      }
      return {
        ...s,
        strokes: [...s.strokes, s.currentStroke],
        currentStroke: null,
      };
    });
  }, []);

  const handleUndo = useCallback(() => {
    setState(s => ({
      ...s,
      strokes: s.strokes.slice(0, -1),
    }));
  }, []);

  const handleClear = useCallback(() => {
    setState(s => ({
      ...s,
      strokes: [],
      currentStroke: null,
    }));
  }, []);

  const handleImageLoad = useCallback((img: HTMLImageElement) => {
    imageRef.current = img;
  }, []);

  const handleAccept = async () => {
    if (saving) return;
    setSaving(true);

    try {
      const img = imageRef.current;
      if (!img) {
        onClose();
        return;
      }

      const hasDrawings = state.strokes.length > 0;

      // If no drawings, just pass through original image
      if (!hasDrawings) {
        const response = await fetch(imageSrc);
        const blob = await response.blob();
        await onAccept(blob, false);
        onClose();
        return;
      }

      // Composite image + drawings
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;

      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;

      // Draw original image
      ctx.drawImage(img, 0, 0);

      // Scale factor from display size to natural size
      const scale = img.naturalWidth / img.clientWidth;

      // Draw all strokes at full resolution
      state.strokes.forEach(stroke => {
        renderStroke(ctx, stroke, scale);
      });

      // Convert to blob
      canvas.toBlob(async (blob) => {
        if (blob) {
          await onAccept(blob, true);
        }
        onClose();
      }, 'image/png');
    } catch (err) {
      console.error('Failed to save annotated image:', err);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleAccept();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-background/90 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      {/* Canvas with image and toolbar */}
      <div className="relative flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {/* Toolbar - above image */}
        <Toolbar
          tool={state.tool}
          color={state.color}
          strokeSize={state.strokeSize}
          canUndo={state.strokes.length > 0}
          onToolChange={(tool) => setState(s => ({ ...s, tool }))}
          onColorChange={(color) => setState(s => ({ ...s, color }))}
          onStrokeSizeChange={(strokeSize) => setState(s => ({ ...s, strokeSize }))}
          onUndo={handleUndo}
          onClear={handleClear}
          onSave={handleAccept}
        />

        <Canvas
          imageSrc={imageSrc}
          strokes={state.strokes}
          currentStroke={state.currentStroke}
          tool={state.tool}
          color={state.color}
          onStrokeStart={handleStrokeStart}
          onStrokeMove={handleStrokeMove}
          onStrokeEnd={handleStrokeEnd}
          onImageLoad={handleImageLoad}
        />

        {/* Accept hint */}
        <div className="text-xs text-muted-foreground">
          Press <kbd className="px-1.5 py-0.5 bg-muted rounded text-foreground">Esc</kbd> or <kbd className="px-1.5 py-0.5 bg-muted rounded text-foreground">Enter</kbd> or click outside to accept
        </div>
      </div>

      {/* Loading overlay */}
      {saving && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50">
          <div className="text-sm text-muted-foreground">Saving...</div>
        </div>
      )}
    </div>
  );
};

export default ImageAnnotator;
