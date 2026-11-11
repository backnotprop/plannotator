import { Popover } from '@base-ui/react/popover';
import { useEffect, useState, type DragEvent } from 'react';
import { tooltipContainerOf } from '@plannotator/ui/components/HostTitle';
import { keepAgentFace, keepOwnPicture, removeOwnPicture, type AgentFaceRef } from './agentFaces';
import { isOwnFace, type AgentFace } from './faceChoices';
import { OWN_LABEL } from './FaceFan';
import { ownIconSrc, useOwnIcons } from './ownIcons';
import { focusBackTo } from './focusBack';

/**
 * "Your own…" (the face picker's last inner place): the pictures the person uploaded, any of which this agent can
 * show, and "+" to add one. A picture can also be dropped on the panel or pasted while it is open. A new one shows on
 * this agent at once. × takes a picture away, with no question: the agents that showed it go back to their own mark,
 * and choosing a face again undoes it. The refusals are Set picture…'s own words.
 *
 * Its keys are the browser's own (Tab, Enter, Space, Escape): it adds no shortcut. Each picture is drawn as its still,
 * as uploaded, scaled to fit its tile.
 */
export function OwnIconPanel({ anchor, open, agent, name, face, touch, onClose }: { anchor: HTMLElement; open: boolean; agent: AgentFaceRef; name: string; face: AgentFace; touch: boolean; onClose: () => void }) {
  const icons = useOwnIcons() ?? [];
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (open) setRefused(null);
  }, [open]);

  const take = async (file: File | null | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setRefused(null);
    const refusal = await keepOwnPicture(agent, file);
    setBusy(false);
    if (refusal) setRefused(refusal);
    else onClose();
  };
  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
    input.addEventListener('change', () => void take(input.files?.[0]), { once: true });
    input.click();
  };
  // A pasted picture, while the panel is open (the browser's own paste; nothing else is listened for).
  useEffect(() => {
    if (!open) return;
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/')) ?? event.clipboardData?.files?.[0];
      if (!file) return;
      event.preventDefault();
      void take(file);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    void take(event.dataTransfer.files?.[0]);
  };

  const current = isOwnFace(face) ? face.slice(4) : null;
  const container = tooltipContainerOf(anchor) ?? anchor.closest<HTMLElement>('.pn-inbox') ?? undefined;
  return (
    <Popover.Root open={open} onOpenChange={(next) => !next && onClose()} modal={false}>
      <Popover.Portal container={container}>
        <Popover.Positioner className="am-own-pos" anchor={anchor} side="right" align="start" sideOffset={10} collisionPadding={8}>
          <Popover.Popup
            className="am-own"
            aria-label={`${OWN_LABEL} ${name}`}
            data-touch={touch ? '' : undefined}
            data-over={over ? '' : undefined}
            data-busy={busy ? '' : undefined}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            finalFocus={focusBackTo(anchor, '.am-own')}
          >
            <div className="am-own-t">{OWN_LABEL}</div>
            <div className="am-own-g" role="radiogroup" aria-label={OWN_LABEL}>
              <button type="button" className="am-own-i am-own-up" aria-label="Upload…" title="Upload…" onClick={pick} disabled={busy}>
                <span className="am-own-add" aria-hidden="true" />
              </button>
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
                      keepAgentFace(agent, `own:${icon.id}`);
                      onClose();
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
            <div className="am-own-h" role="status">
              {refused ?? 'Drop or paste an image'}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
