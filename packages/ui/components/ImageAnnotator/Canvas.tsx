import React, { useRef, useEffect, useCallback } from 'react';
import type { Point, Stroke, Tool } from './types';
import { renderStroke } from './utils';

interface CanvasProps {
  imageSrc: string;
  strokes: Stroke[];
  currentStroke: Stroke | null;
  tool: Tool;
  color: string;
  onStrokeStart: (point: Point) => void;
  onStrokeMove: (point: Point) => void;
  onStrokeEnd: () => void;
  onImageLoad: (img: HTMLImageElement) => void;
}

export const Canvas: React.FC<CanvasProps> = ({
  imageSrc,
  strokes,
  currentStroke,
  onStrokeStart,
  onStrokeMove,
  onStrokeEnd,
  onImageLoad,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const isDrawing = useRef(false);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    strokes.forEach(stroke => renderStroke(ctx, stroke));

    if (currentStroke) {
      renderStroke(ctx, currentStroke);
    }
  }, [strokes, currentStroke]);

  useEffect(() => {
    render();
  }, [render]);

  const handleImageLoad = () => {
    const img = imageRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;

    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;

    onImageLoad(img);
    render();
  };

  const getPoint = (e: React.PointerEvent): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure,
    };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    isDrawing.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    onStrokeStart(getPoint(e));
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDrawing.current) return;
    onStrokeMove(getPoint(e));
  };

  const handlePointerUp = () => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    onStrokeEnd();
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      <img
        ref={imageRef}
        src={imageSrc}
        alt="Annotate"
        onLoad={handleImageLoad}
        className="max-w-[85vw] max-h-[70vh] rounded-lg"
        draggable={false}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-crosshair touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      />
    </div>
  );
};
