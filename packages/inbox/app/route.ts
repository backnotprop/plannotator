/** The window's place, read from the address: which page, project, thread and file (App.tsx writes it with app/writeRoute.ts). */

import { tourStepOf } from '../tour/model';
import { systemRouteOf } from '../system/route';
import { withoutClickSignal } from '../history';
import { parseFileView } from '../fileView';
import { parseSettingsHash, type SettingsSection } from '../settingsRoute';
import type { SheetView } from '../prs/SheetPage';
import { pullFilterOf, type PullFilter } from '../pulls/model';
import { boardInitiativeOf, boardViewOf, type BoardView } from '../board/model';
import { shapeReviewAtOf, type ReviewAt } from '../shape/review';

export interface Route {
  page: 'inbox' | 'settings' | 'whats-new' | 'drafts' | 'tour' | 'board' | 'reviews' | 'shapes' | 'prs' | 'artifacts';
  /**
   * Pull requests (`#prs`, Code review on; approval "inbox-pr-dashboard"): Open or Merged (`&state=merged`), a stack's
   * page (`&stack=`, a layer's key), a PR opened from it (`&layer=`, `&scope=stack`), and `&from=sheet` when the PR was
   * opened from a tile (its Back is the Sheet, not the stack's page), `&from=reviews` when it was opened from the board in
   * Reviews' right pane (its Back is Reviews). On a desktop the board lives in Reviews' pane: a Back that would go to
   * the Sheet goes to Reviews there; `#prs` itself is a phone's way in (Reviews' "Pull requests" row).
   */
  prsView?: SheetView;
  prsFrom?: 'sheet' | 'stack' | 'reviews';
  /** The Artifacts wall on Pinned (`#artifacts=pinned`; approval "inbox-artifact-stars"); All is `#artifacts`. */
  pinned?: boolean;
  /**
   * Reviews (`#reviews`, Code review on; `#pulls` is its permanent alias): the stack open beside the list (`&stack=`, its top layer's key),
   * and the layer under review (`&layer=`, with `&scope=stack` for the whole stack up to it).
   */
  stack?: string | null;
  layer?: string | null;
  scope?: 'layer' | 'stack';
  /**
   * A thread opened from Reviews (`#reviews&thread=…`): the same thread and pane as the Inbox's (`page: 'inbox'`), with
   * Reviews' list beside it and its filter kept. It doesn't move threads: a different list on the same thread.
   */
  reviews?: { project: string | null; view: PullFilter } | null;
  /** `#reviews&new`: open the New review box (a link from outside, Workspaces among them). Taken off the address as it opens. */
  new?: boolean;
  /** Reviews' view (`&view=mine|review|others`; absent: All), beside `project`. */
  view?: PullFilter;
  /**
   * System in Reviews (approval "system-inbox", screens 4a and 4b): the project whose drawing is open in the pane
   * (`&system=prj_…`), the sheet on screen (`&sheet=C-001`) and the full window (`&full=1`). A stack opened over it
   * (`&stack=`) closes back to it.
   */
  system?: string | null;
  sheet?: string | null;
  full?: boolean;
  /**
   * Shape (approval "shape-inbox-placement"): the board open over its thread (`#thread=…&shape=shp_…`), or over
   * the grid for a board with no thread (`#shapes&shape=shp_…`). The grid alone is `#shapes`.
   */
  shape?: string | null;
  /** The Board's list (`#board`, `#board=done`, `#board=cancelled`; `#board=shipped` before the rename opens Done, `#board=icebox` from before v2 Cancelled). */
  board?: BoardView;
  /** The opened Board card (`#board&card=crd_…`), or on a thread the card it was opened from (its "‹ Board" way back). */
  card?: string | null;
  /**
   * On a thread opened from a Board card: the project the Board was filtered to (`&board-project=prj_…`), so its
   * way back lands on the same filtered Board. On the Board itself the filter is `project` (`#board&project=prj_…`).
   */
  boardProject?: string | null;
  /**
   * The Board's initiative filter (approval "board-initiatives"): on the Board `#board&initiative=ini_…` (or
   * `none`, the cards in none), beside `project`; on a thread opened from a card, `&board-initiative=`, so its
   * way back lands on the same filtered Board.
   */
  initiative?: string | null;
  boardInitiative?: string | null;
  /** The onboarding tour's step (`#tour=3`, approval "inbox-onboarding-tour"): 1 to 6. */
  step?: number;
  /** The release whose notes the What's new page shows (`#whats-new=0.28.12`). */
  version?: string | null;
  project: string | null;
  /**
   * Linked machines: the list shows one machine's threads (`#machine=ibx_…`), the sidebar's Machines filter. Beside
   * `project`, never instead of it.
   */
  machine?: string | null;
  /**
   * The sidebar's Agents section: the list shows one agent's threads (`#agent=<InboxAgent.id>`), every thread its
   * session (and the sessions its conversation had before) wrote in, was addressed in or took part in. Picked in
   * place of a project or a machine, never beside them.
   */
  agent?: string | null;
  thread: string | null;
  /**
   * An attachment open beside the thread: `file=att_…`, `v=sent` for the version the agent sent, `at=` an annotation to show,
   * `linked=` a page the attached HTML page links to, shown read-only over it (its path in the page's folder, `#fragment` kept),
   * `view=full|side` the view it is shown in (fileView.ts; absent: the remembered choice, then the rule by kind),
   * `set=<message id>:<question key>` a question's picture choices the viewer steps through (optionSets.ts; absent: every file of the thread).
   */
  file?: { id: string; version: 'current' | 'sent'; focus: string | null; linked?: string | null; view?: 'full' | 'side' | null; set?: string | null } | null;
  /** The message whose guided review is open over the window (`#thread=…&guide=msg_…`). */
  guide?: string | null;
  /**
   * Where that review opens (a Shape board's place in code, such as a drawn part's `data-code`): `&code=path:line`,
   * `&step=N` or `&files` (a context note's lines on the removed side add `&side=old`). Dropped from the address once
   * the review is there.
   */
  guideAt?: ReviewAt | null;
  /**
   * The thread's Artifacts view (`#thread=…&artifacts`, approval "inbox-thread-artifacts"): the grid of every
   * artifact in place of the messages. A file or a guided review opened from it keeps it, so their Back returns to it.
   */
  artifacts?: boolean;
  /** The Artifacts view on its links (`#thread=…&artifacts&links`). Means nothing without `artifacts`. */
  links?: boolean;
  /**
   * A message to land on (`#thread=…&msg=msg_…`, a search result): the thread
   * opens there, the message unfolded, centred, focused and ringed. Dropped
   * from the hash once landed, so a reload does not jump again.
   */
  msg?: string | null;
  /** Settings' section (`#settings/<section>`); null is `#settings` alone (settingsRoute.ts). */
  section?: SettingsSection | null;
  /** `#settings/devices/pair`: Pair a phone is open. */
  pair?: boolean;
  /** `#settings/experimental` (an old link): Capabilities, landing on its Experimental group. Never written to the address. */
  experimental?: boolean;
}

export function readRoute(): Route {
  return routeOf(window.location.hash);
}

export function routeOf(fullHash: string): Route {
  const hash = withoutClickSignal(fullHash).replace(/^#/, '');
  const settingsAt = parseSettingsHash(hash);
  if (settingsAt) return { page: 'settings', project: null, thread: null, section: settingsAt.section, pair: settingsAt.pair, experimental: settingsAt.experimental };
  const params = new URLSearchParams(hash);
  if (params.has('whats-new')) return { page: 'whats-new', project: null, thread: null, version: params.get('whats-new') };
  if (params.has('tour')) return { page: 'tour', project: null, thread: null, step: tourStepOf(params.get('tour')) };
  if (params.has('drafts')) return { page: 'drafts', project: null, thread: null };
  // The Artifacts wall (the sidebar's Artifacts row). `#thread=…&artifacts` is a thread's own grid, below.
  if (params.has('artifacts') && !params.get('thread')) return { page: 'artifacts', project: null, thread: null, pinned: params.get('artifacts') === 'pinned' };
  if (params.has('shapes')) return { page: 'shapes', project: null, thread: null, shape: params.get('shape') };
  if (params.has('prs')) {
    const stack = params.get('stack') || null;
    const layer = stack ? params.get('layer') || null : null;
    return {
      page: 'prs',
      project: null,
      thread: null,
      prsView: params.get('state') === 'merged' ? 'merged' : 'open',
      stack,
      layer,
      scope: layer && params.get('scope') === 'stack' ? 'stack' : 'layer',
      prsFrom: layer && params.get('from') === 'sheet' ? 'sheet' : layer && params.get('from') === 'reviews' ? 'reviews' : 'stack',
    };
  }
  // The Board's project filter rides the list's own key (`#board&project=prj_…`).
  // `#pulls…` is rewritten to this address on arrival (reviewsAlias): it may still be read here in the same breath.
  const fromReviews = params.has('reviews') || params.has('pulls');
  if (fromReviews && !params.get('thread')) {
    const stack = params.get('stack') || null;
    const layer = stack ? params.get('layer') || null : null;
    return {
      page: 'reviews',
      project: params.get('project') || null,
      view: pullFilterOf(params.get('view')),
      thread: null,
      stack,
      layer,
      scope: layer && params.get('scope') === 'stack' ? 'stack' : 'layer',
      new: params.has('new'),
      ...systemRouteOf(params),
    };
  }
  if (params.has('board'))
    return {
      page: 'board',
      project: params.get('project') || null,
      initiative: boardInitiativeOf(params.get('initiative'), null),
      thread: null,
      board: boardViewOf(params.get('board')),
      card: params.get('card'),
    };
  const thread = params.get('thread');
  const fileId = thread ? params.get('file') : null;
  return {
    page: 'inbox',
    reviews: fromReviews ? { project: params.get('project') || null, view: pullFilterOf(params.get('view')) } : null,
    project: fromReviews ? null : params.get('project'),
    machine: params.get('machine'),
    agent: fromReviews ? null : params.get('agent'),
    thread,
    file: fileId ? { id: fileId, version: params.get('v') === 'sent' ? 'sent' : 'current', focus: params.get('at'), linked: params.get('linked'), view: parseFileView(params.get('view')), set: params.get('set') } : null,
    guide: thread ? params.get('guide') : null,
    guideAt: thread && params.get('guide') ? shapeReviewAtOf(params) : null,
    shape: thread ? params.get('shape') : null,
    msg: thread ? params.get('msg') : null,
    artifacts: thread ? params.has('artifacts') : false,
    links: thread ? params.has('artifacts') && params.has('links') : false,
    card: thread ? params.get('card') : null,
    // The Board list the card was opened from (Done, Cancelled): the way back goes there.
    board: thread && params.get('card') ? boardViewOf(params.get('from')) : undefined,
    boardProject: thread && params.get('card') ? params.get('board-project') || null : null,
    boardInitiative: thread && params.get('card') ? boardInitiativeOf(params.get('board-initiative'), null) : null,
  };
}
