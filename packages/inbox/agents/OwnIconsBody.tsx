import { useEffect, useState } from 'react';
import { keepAgentFace, keepOwnPicture, removeOwnPicture, type AgentFaceRef } from './agentFaces';
import { isOwnFace, type AgentFace } from './faceChoices';
import { OWN_LABEL } from './FaceFan';
import { fitPicture } from './fitPicture';
import { ownIconSrc, useOwnIcons } from './ownIcons';

/**
 * "Your own…" in the agent icon dialog (AgentIconDialog.tsx): a large drop area (a click picks a file; a picture can
 * also be dropped anywhere on the dialog, or pasted while it is open), then the pictures already uploaded, any of
 * which this agent can show. A new picture, or one picked, shows on this agent at once and the dialog closes (`onDone`).
 * × takes a picture away, with no question: the agents that showed it go back to their own mark. The refusals are Set
 * picture…'s own words. Each picture is drawn as its still, as uploaded, scaled to fit its tile.
 */
export function OwnIconsBody({ agent, face, onDone, onPick }: { agent: AgentFaceRef; face: AgentFace; onDone: () => void; onPick?: (face: AgentFace) => void }) {
  const icons = useOwnIcons() ?? [];
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  const take = async (file: File | null | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setRefused(null);
    // A still photo over the limit (a phone's) is shrunk here first (fitPicture.ts); the upload checks what comes out.
    const fitted = await fitPicture(file);
    const refusal = 'refused' in fitted ? fitted.refused : await keepOwnPicture(agent, fitted.file, onPick);
    setBusy(false);
    if (refusal) setRefused(refusal);
    else if (!onPick) onDone();
  };
  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
    input.addEventListener('change', () => void take(input.files?.[0]), { once: true });
    input.click();
  };
  // A pasted picture, or one dropped anywhere (the dialog covers the window), while the dialog shows this: the
  // browser's own paste and drop, nothing else listened for.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/')) ?? event.clipboardData?.files?.[0];
      if (!file) return;
      event.preventDefault();
      void take(file);
    };
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
      setOver(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!event.relatedTarget) setOver(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setOver(false);
      void take(event.dataTransfer?.files?.[0]);
    };
    document.addEventListener('paste', onPaste);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
    };
  });

  const current = isOwnFace(face) ? face.slice(4) : null;
  return (
    <div className="ib-agi-own" data-over={over ? '' : undefined} data-busy={busy ? '' : undefined}>
      <button type="button" className="ib-agi-drop am-own-up" aria-label="Upload…" onClick={pick} disabled={busy}>
        {busy ? <span className="ib-spin" aria-hidden="true" /> : <span className="am-own-add" aria-hidden="true" />}
        <span className="ib-agi-drop-l">Drop or paste an image</span>
        <span className="ib-agi-drop-b">Upload…</span>
      </button>
      <div className="ib-agi-status" role="status">
        {refused}
      </div>
      {icons.length > 0 && (
        <div className="am-own-g" role="radiogroup" aria-label={OWN_LABEL}>
          {icons.map((icon, i) => (
            <span key={icon.id} className="am-own-c">
              <button
                type="button"
                role="radio"
                aria-checked={icon.id === current}
                aria-label={`Picture ${icons.length - i}`}
                className="am-own-i"
                data-own-icon={icon.id}
                onClick={() => {
                  if (onPick) return onPick(`own:${icon.id}`);
                  keepAgentFace(agent, `own:${icon.id}`);
                  onDone();
                }}
              >
                <img src={ownIconSrc(icon.id, true)} alt="" draggable={false} decoding="async" />
              </button>
              <button
                type="button"
                className="am-own-x"
                aria-label="Remove"
                title="Remove"
                data-own-remove={icon.id}
                onClick={async () => {
                  const refusal = await removeOwnPicture(icon.id);
                  if (refusal) setRefused(refusal);
                }}
              >
                <svg viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
