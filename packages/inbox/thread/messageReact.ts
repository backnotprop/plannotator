/**
 * Reactions on every agent message (approval "inbox-reactions-every-message", 2026-11-24). What the message's face,
 * its menu's emoji row and the thread's one shared tray call (`MessageReactApi`, made by the thread pane), and two
 * tiny stores the one shared host draws from: the face that is open into the person's emoji (`faceStrip`), and the
 * skill emoji the pointer rests on (`skillPreview`). Nothing here measures layout or listens per message.
 */
import { useSyncExternalStore } from 'react';
import type { InboxMessageWire, InboxReaction } from '@plannotator/core/inbox-types';

export interface MessageReactApi {
  /** The message takes a reaction here: an agent's message, live, whose reaction was not sent yet. */
  offered: (message: InboxMessageWire) => boolean;
  /**
   * Plain emoji (👍 and the saved ones without a skill) are offered too: not while a question or action item in the
   * thread waits on the person (the foot's 👍 and the store's `question_open`, as always). Skill emoji still are.
   */
  plain: () => boolean;
  /** React: null is 👍 Looks good; a saved emoji with a skill sends a reply with that skill. `from`: where the press was. */
  react: (message: InboxMessageWire, reaction: InboxReaction | null, from: Element | null) => void;
  /** Open the full tray (the face at the end of the emoji), anchored on the message's face. */
  openTray: (message: InboxMessageWire) => void;
  /** The head's Reply, from the menu. */
  reply: (message: InboxMessageWire) => void;
  /** The agent's name, for the skill preview's last line. */
  agentOf: (message: InboxMessageWire) => string;
  /** Reply's own rule: not a message from before an archive. */
  live: (message: InboxMessageWire) => boolean;
  /** Mark or take back as the foot's tray does (its flight already flown): `was` only when it was marked. */
  ack: (message: InboxMessageWire, on: boolean, reaction: InboxReaction | null, was?: InboxReaction | null) => void;
}

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The face open into the emoji: the message, and the face's own slot the strip is drawn into (no layout read). */
export type FaceStripAt = { messageId: string; slot: HTMLElement };
export const faceStrip = store<FaceStripAt | null>(null);
export const useFaceStrip = () => useSyncExternalStore(faceStrip.subscribe, faceStrip.get, () => null);

/** The pointer rests on a face this long before it opens (a flick across it opens nothing). */
export const FACE_OPEN_MS = 100;
/** The grace after the pointer leaves the face or the strip, so moving from one to the other keeps it open. */
export const FACE_CLOSE_MS = 140;
/** A face a click opened: its emoji take no press this long, so a double-click on the words under it reacts with nothing. */
export const STRIP_SETTLE_MS = 300;

/**
 * A press on an opened face's emoji that is a deliberate single press: not the second click of a double-click, not a
 * Shift-click (that extends a selection), and not right after a click opened it (`STRIP_SETTLE_MS`).
 */
export const deliberatePress = (e: { detail: number; shiftKey: boolean }): boolean =>
  e.detail <= 1 && !e.shiftKey && Date.now() - clickOpenedAt >= STRIP_SETTLE_MS;

/** No face opens (thread/facePress.ts): '*' while a press selects text; a message's id once one is let go over its face. */
let hushed: string | null = null;
let clickOpenedAt = 0;
let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
const clearTimers = () => {
  if (openTimer) clearTimeout(openTimer);
  if (closeTimer) clearTimeout(closeTimer);
  openTimer = closeTimer = null;
};

/**
 * The face's hover: open after `FACE_OPEN_MS` on it, cancelled if the pointer leaves first; once open, close when
 * the pointer is on neither the face nor the strip for `FACE_CLOSE_MS`. Timers only: nothing measured.
 */
export const faceHover = {
  enter(at: FaceStripAt) {
    if (hushed === '*' || at.messageId === hushed) return;
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    const open = faceStrip.get();
    if (open && open.messageId === at.messageId) return;
    if (openTimer) clearTimeout(openTimer);
    openTimer = setTimeout(() => {
      openTimer = null;
      skillPreview.set(null);
      faceStrip.set(at);
    }, FACE_OPEN_MS);
  },
  leave() {
    if (hushed !== '*') hushed = null;
    if (openTimer) clearTimeout(openTimer);
    openTimer = null;
    if (!faceStrip.get() || closeTimer) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      faceHover.close();
    }, FACE_CLOSE_MS);
  },
  /** A click: open now. Its emoji take no press for `STRIP_SETTLE_MS` (`deliberate`). */
  openNow(at: FaceStripAt) {
    clearTimers();
    clickOpenedAt = Date.now();
    faceStrip.set(at);
  },
  close() {
    clearTimers();
    skillPreview.set(null);
    faceStrip.set(null);
  },
  /**
   * No face opens: '*' while a press selects text; a message's id after a text drag let go over its face, until the
   * pointer leaves it; null, as before (thread/facePress.ts).
   */
  hush(which: '*' | string | null) {
    hushed = which;
  },
};

/** A skill emoji under the pointer (or keyboard focus): its card opens beside `anchor`, to the left first. */
export type SkillPreviewAt = { reaction: InboxReaction & { skill: string }; agent: string; anchor: Element; machine?: string | null };
export const skillPreview = store<SkillPreviewAt | null>(null);
export const useSkillPreview = () => useSyncExternalStore(skillPreview.subscribe, skillPreview.get, () => null);

/** A saved emoji that carries a skill. */
export const hasSkill = (reaction: InboxReaction | null | undefined): reaction is InboxReaction & { skill: string } =>
  !!reaction && typeof (reaction as { skill?: unknown }).skill === 'string' && (reaction as { skill: string }).skill !== '';

/** A skill emoji's tooltip and accessible name (approved words): "/bro", or "Test it /test-it" when it is named too. */
export const skillTip = (reaction: InboxReaction & { skill: string }): string => (reaction.label ? `${reaction.label} /${reaction.skill}` : `/${reaction.skill}`);
export const skillSaid = (reaction: InboxReaction & { skill: string }): string => (reaction.label ? `${reaction.label}, skill ${reaction.skill}` : `/${reaction.skill}`);

/** The field's words for a saved emoji: its name, then its skill. */
export const nameAndSkillText = (reaction: InboxReaction | undefined): string =>
  [reaction?.label ?? '', hasSkill(reaction) ? `/${reaction.skill}` : ''].filter(Boolean).join(' ');
