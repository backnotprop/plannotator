import { INBOX_SIDEBAR_ITEMS, type InboxSidebarItem } from '@plannotator/core/inbox-sidebar';
import type { IconName } from './icons';

export const SIDEBAR_ITEM_ICON: Record<Exclude<InboxSidebarItem, 'agents'>, IconName> = {
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
  search?: boolean;
  compose?: boolean;
  feedback?: boolean;
  drafts?: boolean;
  artifacts?: boolean;
  shortcuts?: boolean;
  copyPrompt?: boolean;
  agents?: boolean;
  phone: boolean;
}

export function drawnSidebarItems(features: SidebarFeatures): ReadonlySet<InboxSidebarItem> {
  const off = new Set<InboxSidebarItem>();
  if (!features.board) off.add('board');
  if (!features.reviews) off.add('reviews');
  if (!features.shape) off.add('shape');
  if (!features.usage) off.add('usage');
  if (features.phone || features.search === false) off.add('search');
  if (features.phone || features.compose === false) off.add('new-message');
  if (features.feedback === false) off.add('feedback');
  if (features.drafts === false) off.add('drafts');
  if (features.artifacts === false) off.add('artifacts');
  if (features.agents === false) off.add('agents');
  if (features.phone || features.shortcuts === false) off.add('shortcuts');
  if (features.phone || features.copyPrompt === false) off.add('copy-prompt');
  return new Set(INBOX_SIDEBAR_ITEMS.map((spec) => spec.id).filter((id) => !off.has(id)));
}
