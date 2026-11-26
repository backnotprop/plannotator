import type { InboxAgent } from '@plannotator/core/inbox-types';
import { InboxApiError, InboxHeldError, inboxApi } from './api';
import { keepAgentName } from './agents/agentFaces';
import { formatCount } from './format';
import { setProjectLook as keepProjectLook } from './data/projectLookApi';
import { projectRefusal } from './agents/iconTarget';
import { learnProjects, pictureFromFile } from './projectPictures';
import { errorToast } from './toastError';
import type { InboxToastModel } from './components/Toast';
import type { ListModel } from './api';

interface ProjectWritesHost {
  showToast: (toast: Omit<InboxToastModel, 'id'>) => void;
  dismissToast: () => void;
  refreshList: (adopt: boolean) => Promise<unknown>;
  say: (text: string) => void;
  latestRef: { readonly current: ListModel | null };
}

export function projectWrites({ showToast, dismissToast, refreshList, say, latestRef }: ProjectWritesHost) {
  const renameProject = async (projectId: string, name: string | null): Promise<boolean> => {
    try {
      await inboxApi.renameProject(projectId, name);
    } catch (cause) {
      showToast(errorToast(cause, 'The name did not change.'));
      return false;
    }
    await refreshList(false);
    const now = latestRef.current?.projects.find((p) => p.id === projectId)?.name;
    say(name === null ? `Name reset${now ? ` to ${now}` : ''}.` : `Renamed to ${name}.`);
    return true;
  };

  const renameAgent = async (agent: InboxAgent, name: string | null, own: string): Promise<boolean> => {
    try {
      await keepAgentName(agent, name);
    } catch (cause) {
      showToast(errorToast(cause, 'The name did not change.'));
      return cause instanceof InboxHeldError;
    }
    say(name === null ? `Name reset${own ? ` to ${own}` : ''}.` : `Renamed to ${name}.`);
    return true;
  };

  const setProjectPicture = async (projectId: string, file: File | null): Promise<boolean> => {
    try {
      const read = file ? await pictureFromFile(file) : { picture: null };
      if ('refused' in read) {
        showToast({ icon: 'warn', lead: read.refused, wrap: true });
        return false;
      }
      await inboxApi.setProjectPicture(projectId, read.picture);
    } catch (cause) {
      // A linked machine too old to take a picture is named, as the icon dialog names it.
      showToast(cause instanceof InboxApiError && cause.code === 'device_route_not_found' ? { icon: 'warn', lead: projectRefusal(projectId, cause), wrap: true } : errorToast(cause, 'The picture did not change.'));
      return false;
    }
    await refreshList(false);
    return true;
  };

  /** The project mark's picker: a hue or a picture source. A refusal is the toast (an older linked machine named). */
  const setProjectLook = async (projectId: string, look: string): Promise<boolean> => {
    try {
      const answer = await keepProjectLook(projectId, look);
      if (answer.project) learnProjects([answer.project]);
    } catch (cause) {
      showToast(cause instanceof InboxApiError && cause.code === 'device_route_not_found' ? { icon: 'warn', lead: projectRefusal(projectId, cause), wrap: true } : errorToast(cause, 'The picture did not change.'));
      return false;
    }
    await refreshList(false);
    return true;
  };

  const combineProjects = async (pairs: readonly { from: string; into: string; intoName: string }[]): Promise<string | null> => {
    const write = async (steps: readonly { project: string; into: string | null }[]) => {
      const done: { project: string; into: string | null }[] = [];
      for (const step of steps) {
        try {
          await inboxApi.combineProject(step.project, step.into);
          done.push(step);
        } catch (cause) {
          return { done, failed: cause };
        }
      }
      return { done, failed: null };
    };
    const { done, failed } = await write(pairs.map((pair) => ({ project: pair.from, into: pair.into })));
    await refreshList(false);
    const failure = failed === null ? null : failed instanceof Error ? failed.message : 'The projects did not change.';
    if (done.length === 0) {
      showToast(errorToast(failed, 'The projects did not change.'));
      return failure;
    }
    const lead = done.length === 1 ? `Combined into ${pairs[0]!.intoName}` : `Combined ${formatCount(done.length)} projects`;
    const undo = done.map((step) => ({ project: step.project, into: null }));
    showToast({
      icon: 'check',
      lead,
      onUndo: () => {
        void (async () => {
          const back = await write(undo);
          await refreshList(false);
          if (back.failed !== null) {
            showToast(errorToast(back.failed, 'The projects did not change.'));
            return;
          }
          dismissToast();
          say('Combine undone.');
        })();
      },
    });
    say(`${lead}.`);
    return failure;
  };
  /** The sidebar's project picture props: Remove picture, and the mark picker's look. */
  const projectPictureProps = { onProjectPicture: setProjectPicture, onProjectLook: setProjectLook };
  return { renameProject, renameAgent, projectPictureProps, combineProjects };
}
