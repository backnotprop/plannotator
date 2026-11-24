/**
 * A skill emoji's card (approval "inbox-reactions-every-message", item 7): the pointer (or keyboard focus) on a skill
 * emoji in the face's strip, the tray or the menu shows what pressing it sends. One card for the whole thread pane.
 * It opens to the LEFT of the strip, tray or menu, its top in line with theirs, and goes to the right only when the
 * left has no room (Base UI's collision flip, measured only while the card is open). It takes no pointer and no focus.
 */
import { useEffect, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { skillPreviewText, type SkillPreviewText } from '../data/skillPreview';
import { useSkillPreview } from './messageReact';

export function SkillPreviewCard({ container }: { container: HTMLElement | null }) {
  const at = useSkillPreview();
  const skill = at?.reaction.skill ?? null;
  const machine = at?.machine ?? null;
  const [text, setText] = useState<{ skill: string; machine: string | null; text: SkillPreviewText } | null>(null);
  useEffect(() => {
    if (!skill) return;
    let live = true;
    void skillPreviewText(skill, machine).then((read) => live && setText({ skill, machine, text: read }));
    return () => {
      live = false;
    };
  }, [skill, machine]);
  const shown = text && text.skill === skill && text.machine === machine ? text.text : null;
  const open = !!at && at.anchor.isConnected;
  return (
    <Popover.Root open={open} modal={false}>
      <Popover.Portal container={container ?? undefined}>
        <Popover.Positioner className="ib-skcard-pos" anchor={at?.anchor} side="left" align="start" sideOffset={8} collisionPadding={8}>
          <Popover.Popup className="ib-skcard" data-skill-preview={skill ?? ''} initialFocus={false} finalFocus={false} aria-hidden="true">
            {at && (
              <>
                <div className="ib-skcard-head">
                  <span className="ib-skcard-e">{at.reaction.emoji}</span>
                  {at.reaction.label && <b className="ib-skcard-name">{at.reaction.label}</b>}
                  <span className="ib-skcard-slash">/{at.reaction.skill}</span>
                </div>
                {shown?.description && <p className="ib-skcard-desc">{shown.description}</p>}
                {shown?.excerpt && <p className="ib-skcard-body">{shown.excerpt}</p>}
                {shown?.missing && <p className="ib-skcard-body">Not in this computer's skills now: it goes as the words /{at.reaction.skill}.</p>}
                <p className="ib-skcard-foot">
                  {shown?.builtin ? 'Plannotator skill' : 'Your skill'} · sent to {at.agent} as a reply
                </p>
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
