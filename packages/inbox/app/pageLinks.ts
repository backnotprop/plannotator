/**
 * The sidebar's rows for the pages a switch turns on: each a link to its page while on, absent while off (no row, menu
 * item or Customize entry). The Board (approval "inbox-board": no count, the header has it), Plans, Grid (approval
 * "inbox-agent-grid", experimental), Routines, and Reviews (only while Code review is on; its count is the sidebar's
 * `pullsCount`).
 */
import type { Route } from './route';

export interface PageLinksOn {
  board: boolean;
  plans: boolean;
  grid: boolean;
  scheduled: boolean;
  reviews: boolean;
}

export function pageLinks(on: PageLinksOn, leave: (to: Route) => void) {
  const to = (page: Route['page'], shown: boolean) => (shown ? () => leave({ page, project: null, thread: null }) : undefined);
  return {
    onBoard: to('board', on.board),
    onPlans: to('plans', on.plans),
    onGrid: to('grid', on.grid),
    onScheduled: to('scheduled', on.scheduled),
    onPulls: to('reviews', on.reviews),
  };
}
