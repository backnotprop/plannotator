/**
 * Whose icon the icon dialog (AgentIconDialog.tsx) changes: an agent's face, or a project's picture (its letter mark,
 * letterMarks.tsx). The dialog's parts are the same for both; only keeping an icon and asking for one differ here.
 *
 * A project keeps a picture's bytes, not a face: Use this icon reads the picked icon from this Inbox (an uploaded
 * picture or a set's icon) and sends it as Set picture… does, to the Inbox that has the project (a linked machine's
 * through the forward). So every window, a phone and a linked machine read it from the project's own picture address.
 */
import { InboxApiError } from '../apiError';
import { inboxApi } from '../api';
import { askIconAnimate } from '../data/iconApi';
import { linkedMachineFacts, machineOf } from '../inboxUrl';
import { learnProjects, pictureFromFile } from '../projectPictures';
import { errorText } from '../toastError';
import { keepAgentFace, type AgentFaceRef } from './agentFaces';
import { isOwnFace, type AgentFace } from './faceChoices';
import { isSetFace, setFaceParts, setIconSrc, setLookOf } from './iconSets';
import { ownIconSrc } from './ownIcons';

export type IconTarget = { kind: 'agent'; agent: AgentFaceRef } | { kind: 'project'; project: string; name: string };

/** A project shows no face: the dialog's parts read this as "nothing picked". */
export const PROJECT_NO_FACE: AgentFace = 'agent';

/**
 * A one-colour set's icon is drawn in the text colour (a CSS mask); a project's picture is an image, which cannot take
 * it. The icon is given a dark colour, and a light one where the viewer's system is dark.
 */
export function inkMonoSvg(text: string): string {
  const style = '<style>svg{color:#2f3440}@media (prefers-color-scheme: dark){svg{color:#e4e7ec}}</style>';
  return text.replace(/<svg\b[^>]*>/, (open) => `${open}${style}`);
}

/** The bytes of an icon the dialog offers (an uploaded picture or a set's icon), as a project keeps them. */
async function pictureOf(face: AgentFace): Promise<Blob> {
  const src = isOwnFace(face) ? ownIconSrc(face, false) : isSetFace(face) ? setIconSrc(setFaceParts(face).set, setFaceParts(face).icon) : null;
  if (!src) throw new Error('not a picture');
  const answer = await fetch(src);
  if (!answer.ok) throw new Error(String(answer.status));
  const blob = await answer.blob();
  if (isSetFace(face) && setLookOf(setFaceParts(face).set)?.mono) return new Blob([inkMonoSvg(await blob.text())], { type: 'image/svg+xml' });
  return blob;
}

/** The words for a project's picture that did not change: a linked machine too old for it is named. */
export function projectRefusal(project: string, cause: unknown): string {
  const home = machineOf(project);
  if (home && cause instanceof InboxApiError && cause.code === 'device_route_not_found') {
    return `${linkedMachineFacts(home)?.name ?? 'That machine'} needs an update to set this picture.`;
  }
  return errorText(cause, 'The picture did not change.');
}

/** Keep `face` as the target's icon. Resolves to null once kept, else the words to show. */
export async function keepIcon(target: IconTarget, face: AgentFace): Promise<string | null> {
  if (target.kind === 'agent') {
    keepAgentFace(target.agent, face);
    return null;
  }
  try {
    const read = await pictureFromFile(await pictureOf(face));
    if ('refused' in read) return read.refused;
    const answer = await inboxApi.setProjectPicture(target.project, read.picture);
    if (answer.project) learnProjects([answer.project]);
    return null;
  } catch (cause) {
    return projectRefusal(target.project, cause);
  }
}

/** The agent's id and the sessions it is, as a request names them. */
function agentOf(agent: AgentFaceRef): { agent: string; sessions: string[] } {
  const ref = typeof agent === 'string' ? { id: agent, session: agent, continues: [] as string[] } : agent;
  return { agent: ref.id, sessions: [...new Set([ref.session, ...(ref.continues ?? [])].filter((id): id is string => !!id && id !== ref.id))] };
}

/** Animate it: a request about `icon` for the target. Resolves to its id. */
export async function askAnimate(target: IconTarget, icon: string): Promise<string> {
  const answer = await askIconAnimate(target.kind === 'agent' ? { icon, ...agentOf(target.agent) } : { icon, project: target.project });
  if (typeof answer.request !== 'string') throw new Error('no request');
  return answer.request;
}

/** Why a request about the target was not made: a linked machine too old for it is named, else null. */
export function askRefusal(target: IconTarget, cause: unknown): string | null {
  if (target.kind !== 'project') return null;
  const home = machineOf(target.project);
  return home && cause instanceof InboxApiError && cause.code === 'device_route_not_found' ? `${linkedMachineFacts(home)?.name ?? 'That machine'} needs an update to ask for a picture.` : null;
}
