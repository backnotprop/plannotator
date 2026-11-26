import { useRef, useState } from 'react';
import { FaceFan, OWN_CHOICE, OWN_LABEL, SETS_CHOICE, SETS_LABEL, type FanPlace } from '../agents/FaceFan';
import { PROJECT_NO_FACE } from '../agents/iconTarget';
import { useFanOpener } from '../agents/useFanOpener';
import { projectPictureSources } from '../data/projectLookApi';
import type { AgentIconPlace } from '../agents/AgentIconDialog';
import { HUES, hueOf, LetterMark } from '../letterMarks';
import { projectLookOf, projectSourceUrl } from '../projectPictures';

/** The picker's words: the project menu's own "Remove picture", and Settings → Rows' names for the two sources. */
export const PROJECT_PLACE_WORDS = {
  remove: 'Remove picture',
  hue: (n: number) => `Colour ${n + 1}`,
  repo: 'Logo from the repo',
  github: 'GitHub picture',
} as const;

/**
 * The project mark's own button, over the mark in its sidebar row (ProjectRow.tsx), never the row's click: it opens
 * the picker an agent's mark opens (agents/FaceFan.tsx, agents/useFanOpener.ts). Inside: "Your own…" and "Sets",
 * which open the icon dialog, and, while a picture or a look is set, the project's letters first, which take it away.
 * Outside: the letters in each of the eight hues, then the repo's logo and the GitHub owner's picture when the project
 * has them (asked of its Inbox as the picker opens). A hue or a source is the project's look (`onLook`), in place of
 * any set picture. The look shown is checked: a picked one, else the name's own hue while no picture is set.
 */
export function ProjectMarkPicker({ projectId, name, hasPicture, paused, onDialog, onRemove, onLook }: { projectId: string; name: string; hasPicture: boolean; paused: boolean; onDialog: (place: AgentIconPlace) => void; onRemove: () => void; onLook?: (look: string) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const [sources, setSources] = useState<{ repo: boolean; github: boolean }>({ repo: false, github: false });
  const { fan, closeFan, onMark, handlers } = useFanOpener({
    paused,
    onOpen: () => {
      projectPictureSources(projectId).then(
        (answer) => setSources({ repo: answer.repo === true, github: answer.github === true }),
        // An older Inbox, or one asleep: the hues alone.
        () => setSources({ repo: false, github: false }),
      );
    },
  });
  const open = (place: AgentIconPlace) => {
    closeFan();
    button.current?.focus({ preventScroll: true });
    onDialog(place);
  };
  const pick = (run: () => void) => () => {
    closeFan();
    run();
  };
  const tile = (hue?: number, picture?: string) => <LetterMark name={name} seed={projectId} size={20} hue={hue} picture={picture} />;
  const inner: FanPlace[] = [
    ...(hasPicture ? [{ id: 'letters', label: PROJECT_PLACE_WORDS.remove, node: tile(), onPick: pick(onRemove) }] : []),
    { id: OWN_CHOICE, label: OWN_LABEL, node: <span className="am-own-add" />, onPick: () => open('own') },
    {
      id: SETS_CHOICE,
      label: SETS_LABEL,
      node: (
        <span className="am-sets-add">
          <i />
          <i />
          <i />
          <i />
        </span>
      ),
      onPick: () => open('sets'),
    },
  ];
  const look = (id: string) => pick(() => onLook?.(id));
  const outer: FanPlace[] = onLook
    ? [
        ...Array.from({ length: HUES }, (_, n) => ({ id: `hue:${n}`, label: PROJECT_PLACE_WORDS.hue(n), node: tile(n), onPick: look(`hue:${n}`) })),
        ...(sources.repo ? [{ id: 'repo', label: PROJECT_PLACE_WORDS.repo, node: tile(undefined, projectSourceUrl(projectId, 'repo')), onPick: look('repo') }] : []),
        ...(sources.github ? [{ id: 'github', label: PROJECT_PLACE_WORDS.github, node: tile(undefined, projectSourceUrl(projectId, 'github')), onPick: look('github') }] : []),
      ]
    : [];
  const checked = projectLookOf(projectId) ?? (hasPicture ? null : `hue:${hueOf(projectId)}`);
  return (
    <>
      <button ref={button} type="button" className="ib-pmark" aria-label={`${name}: icon`} aria-haspopup="dialog" aria-expanded={fan?.open ?? false} data-project-icon={projectId} data-fan-open={fan?.open ? '' : undefined} {...handlers} />
      {fan && button.current && (
        <FaceFan anchor={button.current} open={fan.open} openedBy={fan.by} host={null} name={name} face={PROJECT_NO_FACE} sources={null} onChoose={() => closeFan()} onSets={() => open('sets')} onMark={onMark} onClose={() => closeFan()} project={{ inner, outer, checked }} />
      )}
    </>
  );
}
