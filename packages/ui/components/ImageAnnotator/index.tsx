import React, { useState, useCallback, useEffect, useId, useRef } from 'react';
import { Canvas } from './Canvas';
import { Toolbar } from './Toolbar';
import { renderStroke } from './utils';
import type { Point } from './types';
import { newUuid } from '../../utils/uuid';
import { useImageAnnotatorShortcuts } from '../../shortcuts';
import {
  DEFAULT_STROKE_HISTORY_STATE,
  clearStrokeHistory,
  recordStroke,
  redoStroke,
  undoStroke,
  type StrokeHistoryState,
} from './strokeHistory';

interface ImageAnnotatorProps {
  imageSrc: string;
  isOpen: boolean;
  onAccept: (blob: Blob, hasDrawings: boolean, name: string) => Promise<void>;
  onClose: () => void;
  /** Pre-populated image name (derived from filename) */
  initialName?: string;
  /**
   * Optional: Escape cancels (closes without accepting) and a click outside
   * closes only an empty drawing; Enter and the ✓ accept. Absent: Escape,
   * Enter and a click outside all accept, exactly as before.
   */
  escapeCancels?: boolean;
  /**
   * Optional, with `escapeCancels`: Escape on a drawing with strokes asks
   * first, in a row under the drawing ("Your drawing is not saved yet." Save
   * it, Discard it, Keep drawing; Escape there keeps drawing), so a drawing is
   * never thrown away by one key. An empty drawing still closes at once.
   * Absent: Escape cancels at once, exactly as before.
   */
  askBeforeDiscard?: boolean;
  /** Optional: the line under the image in place of "Press Esc or Enter or click outside to accept". */
  hint?: React.ReactNode;
}

export const ImageAnnotator: React.FC<ImageAnnotatorProps> = ({
  imageSrc,
  isOpen,
  onAccept,
  onClose,
  initialName = '',
  escapeCancels = false,
  askBeforeDiscard = false,
  hint,
}) => {
  const [state, setState] = useState<StrokeHistoryState>(DEFAULT_STROKE_HISTORY_STATE);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(initialName);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  /** Escape asked before throwing strokes away (`askBeforeDiscard`): the question row shows. */
  const [asking, setAsking] = useState(false);
  const askRef = useRef<HTMLDivElement>(null);
  const askTextId = useId();
  /** What held focus when Escape asked: Keep drawing puts it back. */
  const focusBeforeAsk = useRef<Element | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setState(DEFAULT_STROKE_HISTORY_STATE);
      setName(initialName);
      setAsking(false);
    }
  }, [isOpen, initialName]);

  // The question row takes focus on its first choice, as the Inbox's unsaved-comment row does.
  useEffect(() => {
    if (asking) askRef.current?.querySelector<HTMLButtonElement>('[data-pn-image-annotator-ask-save]')?.focus();
  }, [asking]);

  const keepDrawing = () => {
    setAsking(false);
    const before = focusBeforeAsk.current;
    focusBeforeAsk.current = null;
    if (before instanceof HTMLElement && before.isConnected) before.focus();
  };

  const handleStrokeStart = useCallback((point: Point) => {
    const id = newUuid();
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
      return recordStroke(s, s.currentStroke);
    });
  }, []);

  const handleUndo = useCallback(() => {
    setState(undoStroke);
  }, []);

  const handleRedo = useCallback(() => {
    setState(redoStroke);
  }, []);

  const handleClear = useCallback(() => {
    setState(clearStrokeHistory);
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
      const finalName = name.trim() || initialName || 'image';

      // If no drawings, just pass through original image
      if (!hasDrawings) {
        const response = await fetch(imageSrc);
        const blob = await response.blob();
        await onAccept(blob, false, finalName);
        onClose();
        return;
      }

      // Composite image + drawings
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context is unavailable');

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
  };

  const keyboardTargetIsInput = (event: KeyboardEvent): boolean =>
    event.composedPath()[0] instanceof HTMLInputElement;

  useImageAnnotatorShortcuts({
    handlers: {
      penTool: { when: (event) => isOpen && !saving && !keyboardTargetIsInput(event), handle: () => setState((current) => ({ ...current, tool: 'pen' })) },
      arrowTool: { when: (event) => isOpen && !saving && !keyboardTargetIsInput(event), handle: () => setState((current) => ({ ...current, tool: 'arrow' })) },
      circleTool: { when: (event) => isOpen && !saving && !keyboardTargetIsInput(event), handle: () => setState((current) => ({ ...current, tool: 'circle' })) },
      undo: {
        when: (event) => isOpen && !saving && !keyboardTargetIsInput(event) && state.strokes.length > 0,
        handle: handleUndo,
      },
      redo: {
        when: (event) => isOpen && !saving && !keyboardTargetIsInput(event) && state.futureStrokes.length > 0,
        handle: handleRedo,
      },
      save: {
        // While the question row shows, Enter belongs to its focused choice.
        when: (event) => isOpen && !saving && !keyboardTargetIsInput(event) && !(asking && event.key !== 'Escape'),
        handle: (event) => {
          if (escapeCancels && event.key === 'Escape') {
            // One layer at a time: Escape over the question keeps drawing; over strokes it asks before throwing them away.
            if (asking) keepDrawing();
            else if (askBeforeDiscard && state.strokes.length > 0) {
              focusBeforeAsk.current = document.activeElement;
              setAsking(true);
            } else onClose();
          } else void handleAccept();
        },
      },
    },
  });

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      // With escapeCancels, a click outside never takes a drawing away: it closes an empty one only.
      if (!escapeCancels) handleAccept();
      else if (state.strokes.length === 0) onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="pn-visible-viewport-overlay z-[200] flex items-center justify-center bg-background/90 backdrop-blur-sm"
      data-popover-layer
      onClick={handleBackdropClick}
    >
      {/* Canvas with image and toolbar */}
      <div
        data-pn-image-annotator-stage
        className="relative flex max-w-full flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Toolbar - above image */}
        <Toolbar
          tool={state.tool}
          color={state.color}
          strokeSize={state.strokeSize}
          canUndo={state.strokes.length > 0}
          canRedo={state.futureStrokes.length > 0}
          onToolChange={(tool) => setState(s => ({ ...s, tool }))}
          onColorChange={(color) => setState(s => ({ ...s, color }))}
          onStrokeSizeChange={(strokeSize) => setState(s => ({ ...s, strokeSize }))}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onClear={handleClear}
          onSave={handleAccept}
          saveKey={escapeCancels ? 'Enter' : 'Escape'}
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

        {/* Image name input */}
        {initialName && (
          <div className="flex items-center gap-2 w-full max-w-xs">
            <label className="text-xs text-muted-foreground whitespace-nowrap">Name</label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.currentTarget.blur();
                  return;
                }
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleAccept();
                }
              }}
              className="flex-1 px-2 py-1 text-xs bg-muted/50 border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Image name..."
            />
          </div>
        )}

        {asking && (
          <div
            ref={askRef}
            role="group"
            aria-labelledby={askTextId}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-foreground shadow-sm"
            data-pn-image-annotator-ask=""
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              e.stopPropagation();
              keepDrawing();
            }}
          >
            <span id={askTextId}>Your drawing is not saved yet.</span>
            <button
              type="button"
              className="rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground"
              data-pn-image-annotator-ask-save=""
              onClick={() => {
                setAsking(false);
                void handleAccept();
              }}
            >
              Save it
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 font-medium hover:bg-muted"
              data-pn-image-annotator-ask-discard=""
              onClick={() => {
                setAsking(false);
                onClose();
              }}
            >
              Discard it
            </button>
            <button
              type="button"
              className="rounded-md px-2 py-1 font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              data-pn-image-annotator-ask-keep=""
              onClick={keepDrawing}
            >
              Keep drawing
            </button>
          </div>
        )}

        {/* Accept hint */}
        <div className="text-xs text-muted-foreground" data-pn-image-annotator-hint>
          {hint ?? (
            <>
              Press <kbd className="px-1.5 py-0.5 bg-muted rounded text-foreground">Esc</kbd> or <kbd className="px-1.5 py-0.5 bg-muted rounded text-foreground">Enter</kbd> or click outside to accept
            </>
          )}
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
