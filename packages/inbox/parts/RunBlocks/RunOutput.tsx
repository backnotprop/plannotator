/** A run's output on its card: the kept lines, the line still being written, and how many are not shown. */
import { useLayoutEffect, useRef } from 'react';
import type { RunView } from '../../data/runApi';

const count = (n: number) => n.toLocaleString('en-US');

export function RunOutput({ run }: { run: RunView }) {
  const ref = useRef<HTMLPreElement>(null);
  // Follows the end while the person has not scrolled up to read.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [run.lines.length, run.partial]);
  const live = run.state === 'starting' || run.state === 'running';
  const empty = run.lines.length === 0 && run.partial === '';
  return (
    <div className="ib-rb-out" data-run-output="">
      {run.total_lines > run.lines.length && (
        <p className="ib-rb-more" data-run-more="">
          {`Showing the last ${count(run.lines.length)} of ${count(run.total_lines)} lines`}
        </p>
      )}
      {empty ? (
        <p className="ib-rb-none">{live ? 'No output yet.' : 'It printed nothing.'}</p>
      ) : (
        <pre
          ref={ref}
          className="ib-rb-lines"
          tabIndex={0}
          aria-label="Output"
          onScroll={(event) => {
            const el = event.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {run.lines.join('\n')}
          {run.partial !== '' ? `${run.lines.length > 0 ? '\n' : ''}${run.partial}` : ''}
        </pre>
      )}
    </div>
  );
}
