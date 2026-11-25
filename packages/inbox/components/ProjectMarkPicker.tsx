import { useRef, type ReactNode } from 'react';
import { FaceFan, LETTERS_CHOICE, OWN_CHOICE, SETS_CHOICE, type FanChoice } from '../agents/FaceFan';
import { PROJECT_NO_FACE } from '../agents/iconTarget';
import { useFanOpener } from '../agents/useFanOpener';
import type { AgentIconPlace } from '../agents/AgentIconDialog';

const WITH_PICTURE: readonly FanChoice[] = [LETTERS_CHOICE, OWN_CHOICE, SETS_CHOICE];
const NO_PICTURE: readonly FanChoice[] = [OWN_CHOICE, SETS_CHOICE];

/**
 * The project mark's own button, over the mark in its sidebar row (ProjectRow.tsx), never the row's click: it opens
 * the picker an agent's mark opens (agents/FaceFan.tsx, agents/useFanOpener.ts), with a project's places on one arc:
 * "Your own…" and "Sets", which open the icon dialog, and, while a picture is set, the project's letters, which take
 * the picture away. `paused`: the dialog is open.
 */
export function ProjectMarkPicker({ projectId, name, hasPicture, letters, paused, onDialog, onRemove }: { projectId: string; name: string; hasPicture: boolean; letters: ReactNode; paused: boolean; onDialog: (place: AgentIconPlace) => void; onRemove: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const { fan, closeFan, onMark, handlers } = useFanOpener({ paused });
  const open = (place: AgentIconPlace) => {
    closeFan();
    button.current?.focus({ preventScroll: true });
    onDialog(place);
  };
  return (
    <>
      <button ref={button} type="button" className="ib-pmark" aria-label={`${name}: icon`} aria-haspopup="dialog" aria-expanded={fan?.open ?? false} data-project-icon={projectId} data-fan-open={fan?.open ? '' : undefined} {...handlers} />
      {fan && button.current && (
        <FaceFan
          anchor={button.current}
          open={fan.open}
          openedBy={fan.by}
          host={null}
          name={name}
          face={PROJECT_NO_FACE}
          sources={null}
          onChoose={() => closeFan()}
          onOwn={() => open('own')}
          onSets={() => open('sets')}
          onMark={onMark}
          onClose={() => closeFan()}
          project={{
            kinds: hasPicture ? WITH_PICTURE : NO_PICTURE,
            letters,
            onLetters: () => {
              closeFan();
              onRemove();
            },
          }}
        />
      )}
    </>
  );
}
