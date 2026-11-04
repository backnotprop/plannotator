// Requirements: a spec, not a log. Grouped in reading order under small
// headings, terse lines, no times; each line can open the code where it is
// built. Every line is a part the person can mark.
import React from 'react';
import type { ShapeRequirements as Reqs } from '@plannotator/core/shape';
import type { MarkState } from './ShapeDrawn';
import { ShapeInline } from './inline';

const st = (i: number) => ({ 'data-step': '', style: { ['--i' as string]: i } as React.CSSProperties });

function markClass(id: string, marks: MarkState) {
  return ['mk', marks.erasing.has(id) && 'erasing', marks.fresh.has(id) && 'fresh', marks.noted.has(id) && 'noted'].filter(Boolean).join(' ');
}

export function ShapeRequirements({ reqs, marks, onCode }: { reqs: Reqs; marks: MarkState; onCode?: (path: string, line: number) => void }) {
  let i = 0;
  return (
    <div className="shp-reqs">
      {reqs.heading && <div className="shp-req-head" {...st(i++)}>{reqs.heading}</div>}
      {reqs.groups.map((g) =>
        g.items.length ? (
          <section key={g.id} className="shp-req-group" aria-label={g.label} {...st(i++)}>
            <h3>{g.label}</h3>
            <ul>
              {g.items.map((r) => (
                <li key={r.id} data-mark={r.id} className={markClass(r.id, marks)}>
                  <span className="t"><ShapeInline text={r.text} /></span>
                  {r.code && onCode && (
                    <button type="button" className="shp-to-code" onClick={() => onCode(r.code!.path, r.code!.line)} title={`Open ${r.code.path} at line ${r.code.line}`}>
                      {r.code.path.split('/').pop()}:{r.code.line}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
      {reqs.foot?.length ? (
        <div className="shp-req-foot" {...st(i++)}>
          {reqs.foot.map((f) => (
            <div key={f.label}>
              <span className="k">{f.label}</span>
              <span><ShapeInline text={f.text} /></span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
