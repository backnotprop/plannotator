/**
 * A chart on the board: the shapes of `view/chart.ts` as SVG elements. The shapes say what role paints
 * them; the stylesheet answers with the theme's colours (`.pcv-ch-*` in `canvas.css`), and the object's
 * own colour is the accent, kept readable by the same rule as any other line.
 *
 * Every word in it is put there by React as text, never as markup.
 */
import React, { memo, useMemo } from 'react';
import type { ChartObject } from '../model/types';
import { type ChartDrawOptions, chartShapes } from '../view/chart';

export interface ChartViewProps {
  object: ChartObject;
  /**
   * How much of it is written out (`ChartDrawOptions.detail`): everything; its title and key only, set
   * large, when it is drawn small (a figure in a plan, a phone); or no words at all on a crowded board far out.
   */
  detail: ChartDetail;
}

export type ChartDetail = NonNullable<ChartDrawOptions['detail']>;

export const ChartView = memo(function ChartView({ object, detail }: ChartViewProps) {
  const { mark, fields, rows, encode, stack, flip, dash, rules, title, unit, w, h } = object;
  // A move makes a new object and keeps every one of these: the chart is worked out again only when it changed.
  const shapes = useMemo(
    () => chartShapes(object, { detail }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mark, fields, rows, encode, stack, flip, dash, rules, title, unit, w, h, detail],
  );
  // A path is keyed by its place among the paths and a word by its place among the words. So when the
  // detail changes (words come or go, a key is added) no element turns from a word into a mark or back:
  // the marks that are still there are the same elements, with new numbers in them at most.
  let words = 0;
  let marks = 0;
  return (
    <svg className="pcv-chart-svg" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
      {shapes.map((shape) =>
        shape.kind === 'text' ? (
          <text key={`t${(words += 1)}`} x={shape.x} y={shape.y} fontSize={shape.size} fontWeight={shape.weight} textAnchor={shape.anchor} className={`pcv-ch-f-${shape.fill} pcv-ch-${shape.face}`}>
            {shape.text}
          </text>
        ) : (
          <path
            key={`p${(marks += 1)}`}
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
