/**
 * A chart on the board: the shapes of `view/chart.ts` as SVG elements. The shapes say what role paints
 * them; the stylesheet answers with the theme's colours (`.pcv-ch-*` in `canvas.css`), and the object's
 * own colour is the accent, kept readable by the same rule as any other line.
 *
 * Every word in it is put there by React as text, never as markup.
 */
import React, { memo, useMemo } from 'react';
import type { ChartObject } from '../model/types';
import { chartShapes } from '../view/chart';

export interface ChartViewProps {
  object: ChartObject;
  /** False when the chart is too small on screen to read: its marks are drawn and none of its words. */
  rich: boolean;
}

export const ChartView = memo(function ChartView({ object, rich }: ChartViewProps) {
  const { mark, fields, rows, encode, stack, flip, dash, rules, title, unit, w, h } = object;
  // A move makes a new object and keeps every one of these: the chart is worked out again only when it changed.
  const shapes = useMemo(
    () => chartShapes(object, { detail: rich ? 'full' : 'marks' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mark, fields, rows, encode, stack, flip, dash, rules, title, unit, w, h, rich],
  );
  return (
    <svg className="pcv-chart-svg" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
      {shapes.map((shape, index) =>
        shape.kind === 'text' ? (
          <text key={index} x={shape.x} y={shape.y} fontSize={shape.size} fontWeight={shape.weight} textAnchor={shape.anchor} className={`pcv-ch-f-${shape.fill} pcv-ch-${shape.face}`}>
            {shape.text}
          </text>
        ) : (
          <path
            key={index}
            d={shape.d}
            className={`${shape.fill ? `pcv-ch-f-${shape.fill}` : 'pcv-ch-f-none'}${shape.stroke ? ` pcv-ch-s-${shape.stroke}` : ''}`}
            strokeWidth={shape.stroke ? (shape.width ?? 1) : undefined}
            opacity={shape.opacity !== undefined && shape.opacity < 1 ? shape.opacity : undefined}
            strokeDasharray={shape.dash}
          />
        ),
      )}
    </svg>
  );
});
