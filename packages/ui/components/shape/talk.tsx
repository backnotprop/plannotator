/**
 * What was asked or changed on a part of the board, and what came back, in that part's comment box (above the
 * words). The board's side panel is References only (the owner, 2026-11-16: "Honestly, it's just the reference
 * panel"), so a part's Ask answers here: on the part it was asked about, streaming as it comes; the board's Global
 * comment box lists every question and change on the board. Read-only: the box under it asks again.
 */
import { renderChatMarkdown } from '../../utils/aiChatFormat';
import { Pebble } from './Pebble';

export interface ShapeTalkEntry {
  id: string;
  /** Where on the board ("Shape · “Save”", "The whole board"). */
  label: string;
  /** The person's words. */
  words: string;
  change: boolean;
  /** The answer so far (markdown); empty while it waits. */
  answer: string;
  streaming: boolean;
  /** A change's state ("Sent to Claude Code", "Waits for the agent"). */
  status?: string;
  error?: string;
  /** The part it is on (its view and mark id; null: the whole board or a whole view). */
  view: string | null;
  part: string | null;
}

/** The entries on one part (a part's box), or every one (the whole board's). */
export function talkOn(entries: readonly ShapeTalkEntry[], on: { view: string | null; part: string | null } | null): ShapeTalkEntry[] {
  return on ? entries.filter((e) => e.part !== null && e.view === on.view && e.part === on.part) : entries.slice();
}

/** `who`: who answers an Ask; `whoAlways`: said before any question too (the session ended: what happens to one). */
export function ShapeTalk({ entries, who, whoAlways = false, onCode }: { entries: readonly ShapeTalkEntry[]; who: string | null; whoAlways?: boolean; onCode: (path: string, line: number) => void }) {
  if (entries.length === 0 && !(whoAlways && who)) return null;
  return (
    <div
      className="shp-talk"
      data-shape-talk=""
      onClickCapture={(e) => {
        // A `code:path#L12` link in an answer opens the code there.
        const a = (e.target as Element).closest('a');
        const m = a?.getAttribute('href')?.match(/^code:([^#]+)#L(\d+)/);
        if (m) {
          e.preventDefault();
          onCode(m[1]!, Number(m[2]));
        }
      }}
    >
      {who && <p className="shp-talk-who">{who}</p>}
      {entries.map((e) => (
        <article key={e.id} className="shp-talk-entry" data-shape-talk-entry={e.id}>
          <p className="shp-talk-where">{e.label}</p>
          <p className="shp-talk-q">{e.change ? `Change: ${e.words}` : e.words}</p>
          {e.error ? (
            <p className="shp-talk-error" role="alert">{e.error}</p>
          ) : e.answer ? (
            <div className="shp-talk-a" aria-live={e.streaming ? 'polite' : undefined}>{renderChatMarkdown(e.answer)}</div>
          ) : e.streaming ? (
            <p className="shp-talk-wait" role="status"><Pebble alive reshaping size={13} />Answering…</p>
          ) : e.status ? (
            <p className="shp-talk-status">{e.status}</p>
          ) : null}
        </article>
      ))}
    </div>
  );
}
