import React, { useState, useCallback, useRef } from 'react';
import { Canvas } from './Canvas';
import { Toolbar } from './Toolbar';
import { renderStroke } from './utils';
import type { Point, AnnotatorState } from './types';
import { DEFAULT_STATE } from './types';
import { useImageAnnotatorShortcuts } from '../../shortcuts';

interface ImageAnnotatorProps {
  imageSrc: string;
  isOpen: boolean;
  onAccept: (blob: Blob, hasDrawings: boolean, name: string) => Promise<void>;
  onClose: () => void;
  initialName?: string;
}

interface OpenImageAnnotatorProps {
  imageSrc: string;
  onAccept: (blob: Blob, hasDrawings: boolean, name: string) => Promise<void>;
  onClose: () => void;
  initialName: string;
}

const OpenImageAnnotator: React.FC<OpenImageAnnotatorProps> = ({
  imageSrc,
  onAccept,
  onClose,
  initialName,
}) => {
  const [state, setState] = useState<AnnotatorState>(DEFAULT_STATE);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(initialName);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const isAnnotatorTextInputTarget = (target: EventTarget | null) => target instanceof HTMLElement && target.tagName === 'INPUT';

  const handleUndo = useCallback(() => {
    setState(s => ({
      ...s,
      strokes: s.strokes.slice(0, -1),
    }));
  }, []);

  const handleAccept = useCallback(async () => {
    if (saving) return;
    setSaving(true);

    try {
      const img = imageRef.current;
      if (!img) {
        onClose();
        return;
      }

      const hasDrawings = state.strokes.length > 0;
      const finalName = name.trim() || initialName || 'image';

      if (!hasDrawings) {
        const response = await fetch(imageSrc);
        const blob = await response.blob();
        await onAccept(blob, false, finalName);
        onClose();
        return;
      }

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;

      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);

      const scale = img.naturalWidth / img.clientWidth;
      state.strokes.forEach(stroke => {
        renderStroke(ctx, stroke, scale);
      });

      canvas.toBlob(async (blob) => {
        if (blob) {
          await onAccept(blob, true, finalName);
        }
        onClose();
      }, 'image/png');
    } catch (err) {
      console.error('Failed to save annotated image:', err);
      onClose();
    } finally {
      setSaving(false);
    }
  }, [imageSrc, initialName, name, onAccept, onClose, saving, state.strokes]);

  useImageAnnotatorShortcuts({
    handlers: {
      save: (e) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT') {
          if (e.key === 'Escape') {
            target.blur();
            e.preventDefault();
          }
          return;
        }

        e.preventDefault();
        void handleAccept();
      },
      undo: {
        when: (e) => !isAnnotatorTextInputTarget(e.target),
        handle: (e) => {
          e.preventDefault();
          handleUndo();
        },
      },
      penTool: {
        when: (e) => !isAnnotatorTextInputTarget(e.target),
        handle: () => {
          setState(s => ({ ...s, tool: 'pen' }));
        },
      },
      arrowTool: {
        when: (e) => !isAnnotatorTextInputTarget(e.target),
        handle: () => {
          setState(s => ({ ...s, tool: 'arrow' }));
        },
      },
      circleTool: {
        when: (e) => !isAnnotatorTextInputTarget(e.target),
        handle: () => {
          setState(s => ({ ...s, tool: 'circle' }));
        },
      },
    },
  });

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

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      void handleAccept();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-background/90 backdrop-blur-sm"
      data-popover-layer
      onClick={handleBackdropClick}
    >
      <div className="relative flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
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
          onSave={() => void handleAccept()}
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

        {initialName && (
          <div className="flex items-center gap-2 w-full max-w-xs">
            <label className="text-xs text-muted-foreground whitespace-nowrap">Name</label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleAccept();
                }
              }}
              className="flex-1 px-2 py-1 text-xs bg-muted/50 border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Image name..."
            />
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          Press <kbd className="px-1.5 py-0.5 bg-muted rounded text-foreground">Esc</kbd> or <kbd className="px-1.5 py-0.5 bg-muted rounded text-foreground">Enter</kbd> or click outside to accept
        </div>
      </div>

      {saving && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50">
          <div className="text-sm text-muted-foreground">Saving...</div>
        </div>
      )}
    </div>
  );
};

export const ImageAnnotator: React.FC<ImageAnnotatorProps> = ({
  imageSrc,
  isOpen,
  onAccept,
  onClose,
  initialName = '',
}) => {
  if (!isOpen) return null;

  return (
    <OpenImageAnnotator
      imageSrc={imageSrc}
      onAccept={onAccept}
      onClose={onClose}
      initialName={initialName}
    />
  );
};

export default ImageAnnotator;
