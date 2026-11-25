/**
 * The window's side of a project's look, the hue or picture source its mark's picker keeps
 * (packages/server/inbox-project-pictures.ts). It goes to the Inbox that has the project (inboxUrl), a linked
 * machine's too.
 */
import { get, post, type ProjectFolder } from '../api';
import { inboxUrl, machineOf } from '../inboxUrl';

const pictureUrl = (projectId: string, rest = '') => inboxUrl(`/projects/${encodeURIComponent(projectId)}/picture${rest}`, undefined, machineOf(projectId));

/** The project mark's picker: a hue (`hue:<n>`) or a picture source (`repo`, `github`) in place of any set picture. */
export const setProjectLook = (projectId: string, look: string) => post<{ project: ProjectFolder | null }>(pictureUrl(projectId), { look });

/** Which picture sources a project has (`{ repo, github }`), for its mark's picker. */
export const projectPictureSources = (projectId: string) => get<{ repo?: unknown; github?: unknown }>(pictureUrl(projectId, '/sources'));
