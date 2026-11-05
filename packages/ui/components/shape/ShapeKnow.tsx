// `views.know`, under the drawing in the Shape view: what the person needs to
// know, in a paragraph or two of plain prose. Each paragraph is a part the person
// can mark. An old board's Requirements show here too, as plain lines.
import React from 'react';
import { shapeKnowParagraphs, type ShapeRequirements } from '@plannotator/core/shape';
import type { MarkState } from './ShapeDrawn';
import { ShapeInline } from './inline';

const st = (i: number) => ({ 'data-step': '', style: { ['--i' as string]: i } as React.CSSProperties });

function markClass(id: string, marks: MarkState) {
  return ['mk', marks.erasing.has(id) && 'erasing', marks.fresh.has(id) && 'fresh', marks.noted.has(id) && 'noted'].filter(Boolean).join(' ');
}

export function ShapeKnow({ know, reqs, marks, onCode }: { know?: string; reqs?: ShapeRequirements; marks: MarkState; onCode?: (path: string, line: number) => void }) {
  let i = 0;
  return (
    <div className="shp-know">
      {shapeKnowParagraphs(know ?? '').map((text, n) => (
        <p key={n} data-mark={`know-${n + 1}`} className={markClass(`know-${n + 1}`, marks)} {...st(i++)}>
          <ShapeInline text={text} />
        </p>
      ))}
      {reqs && (
        <>
          {reqs.heading && <p {...st(i++)}>{reqs.heading}</p>}
          {reqs.groups.map((g) =>
            g.items.length ? (
              <section key={g.id} aria-label={g.label} {...st(i++)}>
                <h3>{g.label}</h3>
                {g.items.map((r) => (
                  <p key={r.id} data-mark={r.id} className={markClass(r.id, marks)}>
                    <ShapeInline text={r.text} />
                    {r.code && onCode && (
                      <button type="button" className="shp-to-code" onClick={() => onCode(r.code!.path, r.code!.line)} title={`Open ${r.code.path} at line ${r.code.line}`}>
                        {r.code.path.split('/').pop()}:{r.code.line}
                      </button>
                    )}
                  </p>
                ))}
              </section>
            ) : null,
          )}
          {reqs.foot?.map((f) => (
            <p key={f.label} {...st(i++)}>
              <b>{f.label}:</b> <ShapeInline text={f.text} />
            </p>
          ))}
        </>
      )}
    </div>
  );
}
