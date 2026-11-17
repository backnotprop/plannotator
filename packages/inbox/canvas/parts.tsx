/**
 * The thread canvas's small parts in the thread (only while the canvas is on): the header's canvas button, the preview
 * card under the agent's message that drew a version, and the reply box's "Canvas marks N" chip, which sends what the
 * person did on the canvas with their reply (the words the agent's `canvas read` gives).
 */
import { useState } from 'react';
import type { InboxMessage } from '@plannotator/core/inbox-types';
import { canvasMarksBlock } from '@plannotator/core/canvas-skill';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { canvasApi, type CanvasVersionSummary } from './client';

export function CanvasButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Tip content={open ? 'Close the canvas' : 'Canvas: a whiteboard you and the agent draw on'}>
      <button type="button" className="ib-iconbtn ib-cvbtn" aria-pressed={open} aria-label={open ? 'Close the canvas' : 'Open the canvas'} onClick={onToggle} data-canvas-button="">
        <Icon name="brush" />
      </button>
    </Tip>
  );
}

/**
 * Which agent message carries which version's card: each agent message carries the latest agent version written at
 * or before it that no earlier message carries (an agent writes the canvas, then says so).
 */
export function canvasCardsByMessage(messages: readonly Pick<InboxMessage, 'id' | 'created_at' | 'author'>[], versions: readonly CanvasVersionSummary[]): Map<string, CanvasVersionSummary> {
  const agentVersions = versions.filter((v) => v.by === 'agent').sort((a, b) => a.n - b.n);
  const out = new Map<string, CanvasVersionSummary>();
  let next = 0;
  for (const m of messages) {
    if (m.author.kind !== 'agent') continue;
    let carried: CanvasVersionSummary | null = null;
    const at = Date.parse(m.created_at);
    while (next < agentVersions.length && Date.parse(agentVersions[next]!.at) <= at) carried = agentVersions[next++]!;
    if (carried) out.set(m.id, carried);
  }
  return out;
}

export function CanvasCard({ threadId, version, latest, showing, onOpen }: { threadId: string; version: CanvasVersionSummary; latest: boolean; showing: boolean; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <button type="button" className="ib-cvcard" onClick={onOpen} data-canvas-card={version.n} aria-label={`Open the canvas, version ${version.n}`}>
      <span className="ib-cvcard-pic">
        {version.picture && !broken ? <img src={canvasApi.pictureUrl(threadId, version.n)} alt="" loading="lazy" onError={() => setBroken(true)} /> : <Icon name="brush" size={28} />}
      </span>
      <span className="ib-cvcard-foot">
        <Icon name="brush" size={14} />
        <b>Canvas</b>
        <span className="ib-cvcard-v">version {version.n}</span>
        {version.changed ? <span className="ib-cvcard-changed">· {version.changed} {version.changed === 1 ? 'part' : 'parts'} changed</span> : null}
        <span className="ib-cvcard-state">{showing ? 'Showing' : latest ? 'Open' : 'Older'}</span>
      </span>
    </button>
  );
}

/** The marks a reply carries, as the agent reads them. */
export const canvasMarksFeedback = (lines: readonly string[]): string => (lines.length ? canvasMarksBlock(lines) : '');

export function CanvasMarksChip({ lines, agent, onRemove }: { lines: readonly string[]; agent: string; onRemove: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="ib-cvmarks" data-canvas-marks={lines.length}>
      <span className="ib-cvmarks-chip">
        <Icon name="brush" size={13} />
        Canvas marks <span className="ib-cvmarks-n">{lines.length}</span>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={open ? 'Hide the canvas marks' : 'Show the canvas marks'} data-canvas-marks-toggle="">
          <Icon name={open ? 'chevU' : 'chevD'} size={13} />
        </button>
        <button type="button" onClick={onRemove} aria-label="Remove the canvas marks from this reply" data-canvas-marks-remove="">
          <Icon name="x" size={13} />
        </button>
      </span>
      {open && (
        <div className="ib-cvmarks-words">
          <ul>
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <p>{agent} gets these words with your reply, and can ask for a picture of the canvas.</p>
        </div>
      )}
    </div>
  );
}
