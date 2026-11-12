/**
 * The window's side of the sidebar's items (the registry is core `INBOX_SIDEBAR_ITEMS`): each item's icon in the
 * menu and the Customize panel, and which items this Inbox draws now. An item it does not draw (Board with the
 * Board off, Reviews with Code review off, Shape, Usage without `cswap`, Search, New message, Copy prompt and the
 * keyboard button on a phone) is left out of the menu and the panel, and keeps its place in the layout for when it comes back.
 * Agents and Tags have no icon here: the panel draws the sections' own marks (the goggles, the tag's `#`).
 */
import { INBOX_SIDEBAR_ITEMS, type InboxSidebarItem } from '@plannotator/core/inbox-sidebar';
import type { IconName } from './icons';

export const SIDEBAR_ITEM_ICON: Record<Exclude<InboxSidebarItem, 'agents' | 'tags'>, IconName> = {
  logo: 'photo',
  search: 'search',
  'new-message': 'compose',
  inbox: 'inbox',
  board: 'board',
  shape: 'layers',
  reviews: 'reviews',
  artifacts: 'artifacts',
  drafts: 'doc',
  'copy-prompt': 'copy',
  feedback: 'comment',
  usage: 'user',
  settings: 'settings',
  shortcuts: 'keyboard',
  theme: 'moon',
};

export interface SidebarFeatures {
  board: boolean;
  reviews: boolean;
  shape: boolean;
  usage: boolean;
  /** Search and New message (absent in a sidebar drawn without them). */
  search?: boolean;
  compose?: boolean;
  feedback?: boolean;
  drafts?: boolean;
  /** Artifacts (approval "inbox-artifact-stars"): absent in a sidebar drawn without it. */
  artifacts?: boolean;
  shortcuts?: boolean;
  copyPrompt?: boolean;
  /** The Agents section: absent in a sidebar that has none to draw (an Inbox whose list names no agents). */
  agents?: boolean;
  /** The Tags section (approval "inbox-thread-tags"): absent until a tag holds a thread or the person made one. */
  tags?: boolean;
  phone: boolean;
}

/** The items this Inbox draws now, in registry order. */
export function drawnSidebarItems(features: SidebarFeatures): ReadonlySet<InboxSidebarItem> {
  const off = new Set<InboxSidebarItem>();
  if (!features.board) off.add('board');
  if (!features.reviews) off.add('reviews');
  if (!features.shape) off.add('shape');
  if (!features.usage) off.add('usage');
  // A phone's sheet holds neither (approval "inbox-phone-sidebar-sheet"): both are in the list's header there.
  if (features.phone || features.search === false) off.add('search');
  if (features.phone || features.compose === false) off.add('new-message');
  if (features.feedback === false) off.add('feedback');
  if (features.drafts === false) off.add('drafts');
  if (features.artifacts === false) off.add('artifacts');
  if (features.agents === false) off.add('agents');
  if (features.tags !== true) off.add('tags');
  if (features.phone || features.shortcuts === false) off.add('shortcuts');
  if (features.phone || features.copyPrompt === false) off.add('copy-prompt');
  return new Set(INBOX_SIDEBAR_ITEMS.map((spec) => spec.id).filter((id) => !off.has(id)));
}
