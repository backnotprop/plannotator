/**
 * Each reveal's "Turn it on" save (revealTurnOn.ts), Settings' own: the switch's `POST /api/inbox/settings`, answering
 * the switch as saved. Code review's and Routines' read the "/" list again, as their Settings switches do (it gains the
 * review skills, or `/create-routine`).
 */
import { reloadSkillCatalog } from '@plannotator/ui/utils/skillCatalog';
import { inboxApi } from './api';
import type { RevealFeature } from './revealTurnOn';
import { saveRoutinesOn } from './routinesIntro';

export function revealFeatureSave(feature: RevealFeature): () => Promise<{ on: boolean }> {
  switch (feature) {
    case 'board':
      return () => inboxApi.saveBoard(true).then((saved) => saved.board);
    case 'steps':
      return () => inboxApi.saveSteps(true).then((saved) => saved.steps);
    case 'bro':
      return () => inboxApi.saveBro(true).then((saved) => saved.bro);
    case 'scheduled_threads':
      return saveRoutinesOn;
    case 'code_review':
      return () =>
        inboxApi.saveCodeReview(true).then((saved) => {
          reloadSkillCatalog();
          return saved.code_review;
        });
  }
}
