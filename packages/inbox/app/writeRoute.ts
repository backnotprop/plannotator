/** The route written back to the address, as a new history entry or in place. */

import { systemHashOf } from '../system/route';
import { pushScreen, whileWritingRoute } from '../history';
import { withFullMark, type FullMark } from '../fullScreenOrigin';
import { settingsHash } from '../settingsRoute';
import { boardFilterHash } from '../board/model';
import { writeShapeReviewAt } from '../shape/review';
import { readRoute, type Route } from './route';

/** The route's hash, `#thread=…` (empty for the list at rest). */
export function hashOf(route: Route): string {
  let hash = '';
  if (route.page === 'settings') hash = settingsHash({ section: route.section ?? null, pair: route.pair });
  else if (route.page === 'whats-new') hash = new URLSearchParams({ 'whats-new': route.version ?? '' }).toString();
  else if (route.page === 'drafts') hash = 'drafts';
  else if (route.page === 'artifacts') hash = route.pinned ? 'artifacts=pinned' : 'artifacts';
  else if (route.page === 'shapes') hash = route.shape ? `shapes&shape=${encodeURIComponent(route.shape)}` : 'shapes';
  else if (route.page === 'board')
    hash =
      (route.board && route.board !== 'lanes' ? `board=${route.board}` : 'board') +
      boardFilterHash({ project: route.project, initiative: route.initiative }) +
      (route.card ? `&card=${encodeURIComponent(route.card)}` : '');
  else if (route.page === 'reviews')
    hash =
      'reviews' +
      (route.project ? `&project=${encodeURIComponent(route.project)}` : '') +
      (route.view && route.view !== 'all' ? `&view=${route.view}` : '') +
      (route.stack ? `&stack=${encodeURIComponent(route.stack)}` : '') +
      (route.stack && route.layer ? `&layer=${encodeURIComponent(route.layer)}${route.scope === 'stack' ? '&scope=stack' : ''}` : '') +
      systemHashOf(route) +
      (route.new ? '&new' : '');
  else if (route.page === 'prs')
    hash =
      'prs' +
      (route.prsView === 'merged' ? '&state=merged' : '') +
      (route.stack ? `&stack=${encodeURIComponent(route.stack)}` : '') +
      (route.stack && route.layer ? `&layer=${encodeURIComponent(route.layer)}${route.scope === 'stack' ? '&scope=stack' : ''}${route.prsFrom === 'sheet' ? '&from=sheet' : route.prsFrom === 'reviews' ? '&from=reviews' : ''}` : '');
  else if (route.page === 'tour') hash = `tour=${route.step ?? 1}`;
  else {
    const params = new URLSearchParams();
    if (route.reviews) {
      if (route.reviews.project) params.set('project', route.reviews.project);
      if (route.reviews.view !== 'all') params.set('view', route.reviews.view);
    }
    if (route.machine) params.set('machine', route.machine);
    if (route.agent) params.set('agent', route.agent);
    if (route.project) params.set('project', route.project);
    if (route.thread) params.set('thread', route.thread);
    if (route.thread && route.msg) params.set('msg', route.msg);
    if (route.thread && route.artifacts) params.set('artifacts', '');
    if (route.thread && route.artifacts && route.links) params.set('links', '');
    if (route.thread && route.file) {
      params.set('file', route.file.id);
      if (route.file.version === 'sent') params.set('v', 'sent');
      if (route.file.focus) params.set('at', route.file.focus);
      if (route.file.linked) params.set('linked', route.file.linked);
      // The view rides the address (fileView.ts), so a reload or a shared link opens the same way.
      if (route.file.view) params.set('view', route.file.view);
      // A question's picture choices (optionSets.ts): a reload and Back keep stepping through them.
      if (route.file.set) params.set('set', route.file.set);
    }
    if (route.thread && route.guide) params.set('guide', route.guide);
    if (route.thread && route.guide) writeShapeReviewAt(params, route.guideAt);
    if (route.thread && route.shape) params.set('shape', route.shape);
    // A thread opened from a Board card: its way back is the card (`&card=crd_…`).
    if (route.thread && route.card) params.set('card', route.card);
    if (route.thread && route.card && route.board && route.board !== 'lanes') params.set('from', route.board);
    if (route.thread && route.card && route.boardProject) params.set('board-project', route.boardProject);
    if (route.thread && route.card && route.boardInitiative) params.set('board-initiative', route.boardInitiative);
    // `&artifacts`, `&links` and `&files`, flags: written without their empty `=`.
    hash = params.toString().replace(/(^|&)(artifacts|links|files)=(?=&|$)/g, '$1$2');
    if (route.reviews) hash = hash ? `reviews&${hash}` : 'reviews';
  }
  return hash ? `#${hash}` : '';
}

/** The hash the page shows now, in hashOf's spelling (`#` alone reads as none). */
export function currentHash(): string {
  return window.location.hash === '#' ? '' : window.location.hash;
}

/**
 * Write the route to the hash. `replace` swaps the current history entry
 * instead of adding one: stepping between a thread's attachments, so one
 * Back returns to the thread rather than through every file. The entry keeps
 * its state (the screen it was opened from, history.ts), so that Back is still
 * the browser's Back on a phone.
 */
export function writeRoute(route: Route, options: { replace?: boolean; fullMark?: FullMark | null } = {}): void {
  // The Artifacts view belongs to the thread it was opened in: another thread, or a message to land on, opens on the messages.
  if (route.artifacts && (route.thread !== readRoute().thread || route.msg)) route = { ...route, artifacts: false };
  const hash = hashOf(route);
  const next = hash || window.location.pathname + window.location.search;
  // Leaving the tour takes the tour's own entry, whatever leads out of it (a sidebar row, a search result, a link),
  // so the browser's Back never reopens #tour=N.
  const leavingTour = readRoute().page === 'tour' && route.page !== 'tour';
  // `fullMark`: the entry's full-screen mark (fullScreenOrigin.ts). Absent: a replace keeps the one on screen, a push sets none.
  const mark = options.fullMark;
  if (options.replace || leavingTour) {
    const state = mark === undefined ? window.history.state : withFullMark(window.history.state, mark);
    if (hash !== currentHash() || state !== window.history.state) window.history.replaceState(state, '', next);
  } else {
    // Each entry remembers the one it was opened from, so a phone's way back can be the browser's own Back (closeTo).
    pushScreen(hash, currentHash(), next, window.history, mark ? withFullMark(null, mark) : undefined);
  }
  // Its own hashchange: a Back still on its way does not land in it (history.ts settleLanding).
  whileWritingRoute(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
}
