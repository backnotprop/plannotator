/**
 * The Inbox's one composer field (approval "inbox-skill-references"): the
 * reply box, New message, and compose (a message the person starts) all
 * render this. It is Plannotator's comment composer field, unchanged in
 * behavior: the `/` and `$` skill picker at the start of a word
 * (`useSkillReferenceAutocomplete`, `SkillReferenceMenu`), the highlight
 * layer that paints a reference (`ComposerTokenTextarea`, a dotted underline
 * on a human-only skill), and the quiet "Includes skill instructions" line
 * under it. The text stays plain: `$write-better` is the reference, and the
 * Send composes the block (skills.ts).
 *
 * With `tags` (the reply box; approval "inbox-tag-agents"), `@` at the start
 * of a word opens the agent picker (TagPicker), driven by ui's
 * `useMentionAutocomplete` with agents offered: a pick becomes a readable
 * `@Pi` chip in the text, and the field reports the sessions still tagged.
 * Under the field, "Goes to" and the heads-ups (TagNotes).
 *
 * Keys: the pickers see a key first and take only what it was aimed at (a
 * row arrowed onto, Escape with a picker open), so Enter, Tab and Mod+Enter
 * keep their meaning and the host's own `onKeyDown` gets everything else.
 * With no skills installed (or the route missing) `/` and `$` are plain text.
 *
 * Where the picker opens: never inside the field's own boxes (FloatingSkillMenu
 * portals it out, so no scrolling foot or stacking context can cut or cover
 * it). By default it hangs off the field's own box (the reply box, two lines
 * tall, so that is at the caret), inside the room the person really sees (the
 * visual viewport, under the thread's header). A tall field in a modal dialog
 * (compose) passes `caretMenu`: the picker then opens at the caret's line,
 * kept inside the box `caretMenu.bounds` names (compose: the viewport on a
 * desktop, so it floats over the footer; the sheet above its footer on a
 * phone).
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ComposerTokenTextarea } from '@plannotator/ui/components/ComposerTokenTextarea';
import { HumanOnlySkillNotice, SkillReferenceMenu } from '@plannotator/ui/components/SkillReferenceMenu';
import { useMentionAutocomplete } from '@plannotator/ui/hooks/useMentionAutocomplete';
import { useSkillReferenceAutocomplete } from '@plannotator/ui/hooks/useSkillReferenceAutocomplete';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import type { MentionPerson, MentionSource } from '@plannotator/ui/utils/mentions';
import { TAG_UPDATE_WORDS, tagPeople, tagPickedWords, type TagOption } from '../tags';
import { caretAnchor, caretLineRect, fieldAnchor, fieldInSight, phoneSkillListHeight, seenBox, skillListRoom, visibleBox, type AnchorBox, type VerticalBox } from '../caretMenu';
import { TagNotes, TagPicker } from './TagPicker';
import { VoiceNote, voiceHidesCaret, voicePaint } from './VoiceMic';
import type { VoiceHandle } from '../voice';
import { textareaField } from '../voiceField';
import { isPhone, isTouchScreen } from '../phone';
import { inboxSkillFilter } from '../skills';
import { hashtagMenuLeft, useHashtagPicker, useInitiativeTags } from '../hashtags';

/** The chip class a tag gets in the composer's highlight layer (inbox.css: colour, background and box-shadow only). */
export const TAG_TOKEN_CLASS = 'ib-tg-tok';

export interface CaretMenuOptions {
  /** Which side of the caret's line the picker tries first. */
  prefer: 'above' | 'below';
  /** The box the picker stays inside, in viewport coordinates. */
  bounds: () => VerticalBox | null;
  /** Cap on the list's height (a phone's 4½ rows). */
  maxListHeight?: number;
}

export interface InboxComposerTags {
  /** The rows the picker offers (tags.ts `tagOptions`). */
  options: readonly TagOption[];
  /** The sessions the text still tags, in order, every time they change. */
  onChange: (ids: readonly string[]) => void;
  /**
   * The reply box's one line under the field (approval "inbox-tag-handoff",
   * A2), drawn in place of TagNotes while the text tags an agent that does
   * not own the thread. Absent: TagNotes, as before.
   */
  /** `focusField` puts focus back in the field (a link that switched the line is gone after the click). */
  note?: (props: { id: string; tagged: readonly TagOption[]; focusField: () => void }) => React.ReactNode;
}

/**
 * A command of the Inbox's own in the `/` list (the reply box's `/side`): a window action, not a skill. Picking it
 * sends nothing to the agent: the typed `/…` leaves the words and `run` gets what is left.
 */
export interface ComposerCommand {
  /** The name typed after `/`. */
  name: string;
  /** The list's one line. */
  description: string;
  run: (words: string) => void;
}

export interface InboxComposerFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** The host's keys (Mod+Enter sends, Escape closes); called only for keys the picker did not take. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** The textarea, for the host's focus calls. */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  ariaLabel: string;
  ariaDescribedBy?: string;
  /** What the human-only line says the instructions go with: "your reply", "your message". */
  destination: string;
  /** Tag agents with `@` (the reply box). Absent: `@` is plain text, as before. */
  tags?: InboxComposerTags;
  /** Open the picker at the caret's line, inside the open dialog that holds the field (see the header). */
  caretMenu?: CaretMenuOptions;
  /** Escape closes an open picker even before a query was typed (compose: Escape would ask about a draft). */
  escapeClosesMenu?: boolean;
  /** Voice dictation (voice.ts): the host's session, whose button sits in the host's toolbar. */
  voice?: VoiceHandle;
  /** The voice note opens and closes in one motion (the reply box, approval "inbox-reply-box"). */
  voiceNoteGlide?: boolean;
  /** Which skills this field offers and paints (skills.ts `inboxSkillFilter`); all by default. Keep its identity stable. */
  skillFilter?: (entry: SkillCatalogEntry) => boolean;
  /** The Inbox's own commands this field lists with the skills after a `/` (`ComposerCommand`). Absent: none. Keep its identity stable. */
  commands?: readonly ComposerCommand[];
}

const NO_PEOPLE: readonly MentionPerson[] = [];
/** Where no thread says a review happened (New message, compose, a comment): `/review-recheck` is not offered. */
const OUTSIDE_A_REVIEW = inboxSkillFilter(false);

export function InboxComposerField({
  value,
  onChange,
  onKeyDown,
  textareaRef,
  placeholder,
  ariaLabel,
  ariaDescribedBy,
  destination,
  tags,
  caretMenu,
  escapeClosesMenu = false,
  voice,
  voiceNoteGlide = false,
  skillFilter = OUTSIDE_A_REVIEW,
  commands,
}: InboxComposerFieldProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const attach = useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (textareaRef) textareaRef.current = el;
    },
    [textareaRef],
  );
  // The field going away (the box closed, Reply to Comment in full screen) ends the session's run and drops its clip;
  // a host with a `late` keeps a take being transcribed (voiceSession.ts `attach`).
  const voiceSession = voice?.session;
  useEffect(() => {
    if (!voiceSession || !innerRef.current) return;
    return voiceSession.attach(textareaField(innerRef.current, isTouchScreen));
  }, [voiceSession]);
  const voiceLive = voice ? voiceHidesCaret(voice.view) : false;
  // The commands as the list's rows: the built-ins' own row ("Plannotator" at its right end), and never a reference.
  const commandRows = useMemo<SkillCatalogEntry[] | undefined>(
    () => (commands?.length ? commands.map((command) => ({ name: command.name, root: 'plannotator', description: command.description, humanOnly: false })) : undefined),
    [commands],
  );
  const runCommand = useCallback((row: SkillCatalogEntry, words: string) => commands?.find((command) => command.name === row.name)?.run(words), [commands]);
  const skills = useSkillReferenceAutocomplete({
    text: value,
    setText: onChange,
    textareaRef: innerRef,
    enabled: true,
    bareEscapeDismisses: escapeClosesMenu,
    catalogFilter: skillFilter,
    commands: commandRows,
    onCommand: runCommand,
  });
  const [announce, setAnnounce] = useState('');
  const options = tags?.options;
  const onTagsChange = tags?.onChange;
  const people = useMemo(() => (options ? tagPeople(options) : NO_PEOPLE), [options]);
  const source = useMemo<MentionSource | undefined>(
    () =>
      options
        ? {
            people,
            kinds: ['agent'],
            matchDetail: false,
            // Only a bare `@` with nobody to offer says so; a query nobody matches closes the picker (prose after a tag).
            emptyNotice: options.length === 0 ? 'No agent to tag: none is live, and none reads the Inbox yet.' : null,
            tokenClassName: TAG_TOKEN_CLASS,
            onMentionsChange: (ids) => onTagsChange?.(ids),
            // A session on an older Plannotator: nothing is inserted; say why.
            onPickBlocked: (person) => setAnnounce(`${person.label}: ${TAG_UPDATE_WORDS}.`),
          }
        : undefined,
    [options, people, onTagsChange],
  );
  const mention = useMentionAutocomplete({ text: value, setText: onChange, textareaRef: innerRef, source });
  // `#` names an initiative (approval "board-hashtags"): the skill list's menu, the skill list's keys.
  const initiativeTags = useInitiativeTags();
  const hash = useHashtagPicker({ text: value, setText: onChange, fieldRef: innerRef, tags: initiativeTags, bareEscapeDismisses: escapeClosesMenu });
  const hashListboxId = `ib-hash-${useId().replace(/:/g, '')}`;
  const hashMenu = hash.menu && !mention.menu && !skills.menu ? hash.menu : null;
  const [hashShown, setHashShown] = useState(false);
  const hashMenuShown = hashMenu !== null && hashShown;
  // The agents can arrive after the person typed `@` (the list is read when the box opens): read the caret then.
  const tagsReady = source !== undefined;
  const readMentionCaret = mention.onSelect;
  useEffect(() => {
    if (tagsReady) readMentionCaret();
  }, [tagsReady, readMentionCaret]);
  const skillListboxId = `ib-skills-${useId().replace(/:/g, '')}`;
  const tagListboxId = `ib-tags-${useId().replace(/:/g, '')}`;
  const notesId = `ib-tagnotes-${useId().replace(/:/g, '')}`;
  const tagged = useMemo(() => (options ? mention.mentions.flatMap((p) => options.filter((o) => o.id === p.id)) : []), [options, mention.mentions]);
  const owner = options?.find((o) => o.owner) ?? null;
  const showNotes = tagged.some((t) => !t.owner);
  const skillActive = skills.menu?.activeIndex;
  const tagMenu = mention.menu;
  const listboxId = tagMenu ? tagListboxId : hashMenu ? hashListboxId : skillListboxId;
  const activeOption =
    tagMenu && tagMenu.activeIndex !== null
      ? `${tagListboxId}-option-${tagMenu.activeIndex}`
      : hashMenu
        ? hashMenu.activeIndex !== null
          ? `${hashListboxId}-option-${hashMenu.activeIndex}`
          : undefined
        : !tagMenu && skillActive !== null && skillActive !== undefined
          ? `${skillListboxId}-option-${skillActive}`
          : undefined;
  const select = (index: number) => {
    const person = tagMenu?.items[index];
    const option = person ? options?.find((o) => o.id === person.id) : undefined;
    mention.select(index);
    if (option?.taggable) setAnnounce(tagPickedWords(option));
  };
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Whether the skill list is drawn (FloatingSkillMenu draws it only while the field is in sight): its keys and
  // `aria-expanded` follow what the person sees, so arrows never move through a list nobody can see.
  const [skillShown, setSkillShown] = useState(false);
  const skillMenuShown = skills.menu !== null && skillShown;
  const textarea = innerRef.current;
  const wrap = wrapRef.current;
  const host = textarea ? skillMenuHost(textarea) : null;
  const describedBy = [ariaDescribedBy, showNotes ? notesId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="ib-cfield" ref={wrapRef} data-composer-field="" data-voice-live={voiceLive ? '' : undefined}>
      {skills.menu && !tagMenu && textarea && wrap && host ? (
        <FloatingSkillMenu textarea={textarea} wrap={wrap} host={host} caret={caretMenu ?? null} onShown={setSkillShown}>
          {(boundary, maxListHeight) => (
            <SkillReferenceMenu
              id={skillListboxId}
              items={skills.menu!.items}
              activeIndex={skills.menu!.activeIndex}
              onSelect={skills.select}
              boundary={boundary}
              prefer={caretMenu?.prefer ?? 'above'}
              maxListHeight={maxListHeight}
            />
          )}
        </FloatingSkillMenu>
      ) : null}
      {hashMenu && textarea && wrap && host ? (
        <FloatingSkillMenu
          textarea={textarea}
          wrap={wrap}
          host={host}
          caret={caretMenu ?? null}
          onShown={setHashShown}
          kind="hashtag"
          left={(box) => hashtagMenuLeft(textarea, hashMenu.start, box.left, box.width)}
        >
          {(boundary, maxListHeight) => (
            <SkillReferenceMenu
              id={hashListboxId}
              items={hashMenu.items}
              activeIndex={hashMenu.activeIndex}
              onSelect={hash.select}
              boundary={boundary}
              prefer={caretMenu?.prefer ?? 'above'}
              maxListHeight={maxListHeight}
            />
          )}
        </FloatingSkillMenu>
      ) : null}
      {tagMenu && options && <TagPicker id={tagListboxId} menu={tagMenu} options={options} onSelect={select} />}
      <ComposerTokenTextarea
        textareaRef={attach}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          skills.onSelect();
          mention.onSelect();
          hash.onSelect();
        }}
        onKeyDown={(event) => {
          if (tagMenu && (event.key === 'Enter' || event.key === 'Tab') && !event.metaKey && !event.ctrlKey && !event.altKey && tagMenu.activeIndex !== null) {
            event.preventDefault();
            select(tagMenu.activeIndex);
            return;
          }
          if (mention.onKeyDown(event)) return;
          if (hashMenuShown && hash.onKeyDown(event)) return;
          if (skillMenuShown && skills.onKeyDown(event)) return;
          onKeyDown?.(event);
        }}
        onSelectCaret={() => {
          skills.onSelect();
          mention.onSelect();
          hash.onSelect();
        }}
        placeholder={voiceLive ? '' : placeholder}
        mirrorPaint={voice ? voicePaint(voice.view, voice.session, value) : undefined}
        sizeClassName=""
        textClassName=""
        inputClassName="ib-rtext"
        mirrorClassName="ib-rmirror"
        skillReferences
        tokens={hash.tokens.length > 0 ? [...skills.referenceTokens, ...hash.tokens].sort((a, b) => a.start - b.start) : skills.referenceTokens}
        mentionChips={source ? { people: mention.mentions, tokenClassName: TAG_TOKEN_CLASS } : null}
        listboxId={listboxId}
        listboxOpen={skillMenuShown || hashMenuShown || tagMenu !== null}
        activeOptionId={activeOption}
        inputProps={{ 'aria-label': ariaLabel, 'aria-describedby': describedBy, rows: 2 }}
      />
      {voice && <VoiceNote voice={voice} glide={voiceNoteGlide} />}
      <HumanOnlySkillNotice skills={skills.humanOnlyReferences} destination={destination} />
      {options && showNotes && (tags?.note ? tags.note({ id: notesId, tagged, focusField: () => innerRef.current?.focus() }) : <TagNotes id={notesId} tagged={tagged} owner={owner} />)}
      {options && (
        <div className="ib-sr" role="status" aria-live="polite" data-tag-live="">
          {tagMenu ? `${tagMenu.items.length} ${tagMenu.items.length === 1 ? 'agent' : 'agents'}${announce ? `. ${announce}` : ''}` : announce}
        </div>
      )}
    </div>
  );
}

/**
 * Where the list is drawn: an open modal dialog (compose) when the field is in
 * one, since a dialog is in the top layer and anything outside it renders
 * under it; else the Inbox's root, which carries the theme's colours. Never
 * inside the field's own boxes: the reply foot scrolls in its own box on an
 * iPhone with the keyboard up, and its `z-index` traps anything inside it
 * under the thread's header, so a list drawn there was cut at the foot's top
 * edge (only the last row's bottom showed) and hidden behind the header.
 */
function skillMenuHost(field: HTMLElement): HTMLElement {
  return field.closest<HTMLElement>('dialog[open]') ?? field.closest<HTMLElement>('.pn-inbox') ?? field.ownerDocument.body;
}

/** The space the list keeps from the field above it (inbox.css once set it with a margin: 8 px, 10 on a phone); the menu's own gap is 6. */
const FIELD_GAP_EXTRA = 2;
const PHONE_FIELD_GAP_EXTRA = 4;
/** What the menu spends around its list on one side: its 6 px gap, 8 px from the room's edge, its border. */
const SIDE_CHROME = 16;
/** The least list ever shown: one whole row and the list's padding (a 44 px phone row, until a row is measured). */
const MIN_LIST_ROOM = 56;
/** The list's own padding above and below its rows (SkillReferenceMenu's `p-1.5`). */
const LIST_PADDING = 12;

interface MenuFrame {
  box: AnchorBox;
  room: VerticalBox | null;
  cap: number | undefined;
  /** One whole row and the list's padding: the list is never shorter (a sliver of a row is never shown). */
  least: number;
  /** fieldInSight: the field has focus and nothing covers it. */
  shown: boolean;
}

// Object.is: a reading that is NaN (a viewport mid-rotation) still equals itself, so the commit loop converges.
const sameFrame = (a: MenuFrame, b: MenuFrame) =>
  a.shown === b.shown &&
  a.least === b.least &&
  Object.is(a.box.top, b.box.top) &&
  Object.is(a.box.bottom, b.box.bottom) &&
  Object.is(a.box.left, b.box.left) &&
  Object.is(a.box.width, b.box.width) &&
  Object.is(a.cap, b.cap) &&
  Object.is(a.room?.top, b.room?.top) &&
  Object.is(a.room?.bottom, b.room?.bottom);

/**
 * The list, portaled to `host` (skillMenuHost) and laid over a box: the
 * field's box (the reply box, New message, full screen's card, a page
 * comment), or with `caret` the caret's line (compose's tall field).
 * SkillReferenceMenu hangs the list above or below that box by the room it
 * really has (read at every measure: the visual viewport under the thread's
 * header, skillListRoom; compose's own bounds with `caret`) and caps the list
 * to it, so all of the list is on screen and scrolls in what is left. The box
 * and the room follow the field on every render and on anything that moves
 * them: a scroll anywhere, a resize, the visual viewport (the keyboard opening
 * or closing), a change of the field's size, and the root's keyboard state
 * (phone.ts pins the page a frame after the keyboard opens).
 *
 * It is drawn only while the field has focus and is in sight (fieldInSight):
 * at the root it is above the whole shell, so anything that covers the field
 * (full view, a tucked card, a sheet, an action note that hides the reply foot
 * on a phone) would otherwise leave it floating, and pressable, over that.
 * Focus moves, the shell's own changes and the end of a transition re-check.
 * `onShown` tells the field, which then leaves the list's keys alone.
 */
function FloatingSkillMenu({
  textarea,
  wrap,
  host,
  caret,
  onShown,
  children,
  kind = 'skill',
  left,
}: {
  textarea: HTMLTextAreaElement;
  wrap: HTMLElement;
  host: HTMLElement;
  caret: CaretMenuOptions | null;
  /** `hashtag`: the initiatives (inbox.css draws `#` in place of the skill icon, without the source column). */
  kind?: 'skill' | 'hashtag';
  /** The list's left edge inside the anchor, from the anchor's box in viewport x (the `#` list: under the `#`). */
  left?: (box: { left: number; width: number }) => number;
  onShown: (shown: boolean) => void;
  children: (boundary: () => VerticalBox | null, maxListHeight: number | undefined) => React.ReactNode;
}) {
  const [frame, setFrame] = useState<MenuFrame | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef(caret);
  caretRef.current = caret;
  // Set by update() when not even the caret's line leaves one whole row under the thread's header: the room is then
  // all that is visible, the header included, since a whole row over the header beats a sliver of one.
  const overHeaderRef = useRef(false);
  const room = useCallback((): VerticalBox | null => {
    const own = caretRef.current;
    if (own) return own.bounds();
    return overHeaderRef.current ? seenBox(textarea.ownerDocument.defaultView ?? window) : skillListRoom(textarea);
  }, [textarea]);

  const update = useCallback(() => {
    const own = caretRef.current;
    const phone = isPhone();
    const atCaret = (): AnchorBox => {
      const field = textarea.getBoundingClientRect();
      // Not laid out (a test DOM): the field's top edge, so the menu still renders.
      const line = caretLineRect(textarea) ?? { top: field.top, bottom: field.top };
      return caretAnchor(line, visibleBox(textarea, host), { left: field.left, width: field.width });
    };
    let anchor = own ? atCaret() : fieldAnchor(wrap, host, phone ? PHONE_FIELD_GAP_EXTRA : FIELD_GAP_EXTRA, phone ? 1 : 0);
    // One whole row, as drawn (a phone's row is two lines), and the list's padding.
    const row = anchorRef.current?.querySelector<HTMLElement>('[data-skill-item]')?.getBoundingClientRect().height ?? 0;
    const least = row > 0 ? row + LIST_PADDING : MIN_LIST_ROOM;
    const fits = (a: AnchorBox, r: VerticalBox) => Math.max(a.top - r.top, r.bottom - a.bottom) - SIDE_CHROME >= least;
    const side = (a: AnchorBox, r: VerticalBox) => Math.max(a.top - r.top, r.bottom - a.bottom);
    overHeaderRef.current = false;
    let r = room();
    let tight = false;
    // Too little room on both sides of the box for one whole row (a phone on its side with the keyboard up: ~110 to
    // 140 px visible): hang the list off the caret's line instead, over the rest of the box. Still too little under
    // the thread's header: the room is all that is visible, over the header, and the list is one row that scrolls.
    // Too little even then: the list's edge moves onto the caret's line just far enough for that one row.
    if (!own && r && !fits(anchor, r)) {
      const line = atCaret();
      if (side(line, r) > side(anchor, r)) anchor = line;
      if (!fits(anchor, r)) {
        const all = seenBox(textarea.ownerDocument.defaultView ?? window);
        overHeaderRef.current = true;
        tight = true;
        r = all;
        anchor = side(line, all) >= side(anchor, all) ? line : anchor;
        if (!fits(anchor, all)) {
          const need = least + SIDE_CHROME;
          const edge = anchor.top - all.top >= all.bottom - anchor.bottom ? all.top + need : all.bottom - need;
          anchor = { ...anchor, top: edge, bottom: edge };
        }
      }
    }
    // In the host's coordinates: an absolute box is placed against its padding box.
    const h = host.getBoundingClientRect();
    const box: AnchorBox = {
      top: Math.round(anchor.top - h.top - host.clientTop + host.scrollTop),
      bottom: Math.round(anchor.bottom - h.top - host.clientTop + host.scrollTop),
      left: Math.round(anchor.left - h.left - host.clientLeft + host.scrollLeft),
      width: Math.round(anchor.width),
    };
    const seen = seenBox(textarea.ownerDocument.defaultView ?? window);
    const phoneCap = phone ? phoneSkillListHeight(seen.bottom - seen.top) : undefined;
    const cap = own ? own.maxListHeight : tight ? least : Number.isFinite(phoneCap) ? phoneCap : undefined;
    const shown = fieldInSight(textarea, textarea.closest('.ib-pfoot, dialog') ?? wrap, host, anchorRef.current);
    const next: MenuFrame = { box, room: r, cap, least, shown };
    setFrame((prev) => (prev && sameFrame(prev, next) ? prev : next));
  }, [host, textarea, wrap, room]);

  // Every commit: the caret moved or the text changed (the equality guard above converges).
  useLayoutEffect(() => {
    update();
  });

  useEffect(() => {
    const view = textarea.ownerDocument.defaultView ?? window;
    const viewport = view.visualViewport;
    let raf = 0;
    // Now, and again once the page has laid itself out for the change (phone.ts applies the keyboard a frame later).
    const soon = () => {
      update();
      view.cancelAnimationFrame(raf);
      raf = view.requestAnimationFrame(() => {
        update();
        raf = view.requestAnimationFrame(update);
      });
    };
    view.addEventListener('scroll', soon, true);
    view.addEventListener('resize', soon);
    viewport?.addEventListener('resize', soon);
    viewport?.addEventListener('scroll', soon);
    const watch = typeof MutationObserver === 'function' ? new MutationObserver(soon) : null;
    watch?.observe(textarea.ownerDocument.documentElement, { attributes: true, attributeFilter: ['style', 'data-ib-keyboard', 'data-ib-keyboard-pin'] });
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : null;
    sized?.observe(wrap);
    // What can cover the field or take its focus: focus moving, the shell drawing something new (full view, a sheet,
    // a card tucked with `inert`), and a slide-in finishing.
    const doc = textarea.ownerDocument;
    doc.addEventListener('focusin', soon);
    doc.addEventListener('focusout', soon);
    doc.addEventListener('transitionend', soon, true);
    doc.addEventListener('animationend', soon, true);
    const shell = typeof MutationObserver === 'function' ? new MutationObserver(soon) : null;
    shell?.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'hidden', 'class', 'open'] });
    return () => {
      doc.removeEventListener('focusin', soon);
      doc.removeEventListener('focusout', soon);
      doc.removeEventListener('transitionend', soon, true);
      doc.removeEventListener('animationend', soon, true);
      shell?.disconnect();
      view.cancelAnimationFrame(raf);
      view.removeEventListener('scroll', soon, true);
      view.removeEventListener('resize', soon);
      viewport?.removeEventListener('resize', soon);
      viewport?.removeEventListener('scroll', soon);
      watch?.disconnect();
      sized?.disconnect();
    };
  }, [update, textarea, wrap]);

  const shown = frame?.shown ?? false;
  useEffect(() => {
    onShown(shown);
  }, [onShown, shown]);
  useEffect(() => () => onShown(false), [onShown]);

  if (!frame || !frame.shown) return null;
  const { box } = frame;
  return createPortal(
    <div
      ref={anchorRef}
      // A press on the list's own chrome (its padding, its scrollbar) keeps the caret in the field; rows insert on pointerdown.
      onMouseDown={(event) => event.preventDefault()}
      className="ib-skanchor"
      data-skill-menu-anchor={caret ? 'caret' : 'field'}
      data-hashtag-menu={kind === 'hashtag' ? '' : undefined}
      style={
        {
          top: box.top,
          left: box.left,
          width: box.width,
          height: Math.max(0, box.bottom - box.top),
          '--ib-skill-list-least': `${frame.least}px`,
          ...(left ? { '--ib-hash-x': `${left({ left: box.left + host.getBoundingClientRect().left + host.clientLeft - host.scrollLeft, width: box.width })}px` } : {}),
        } as React.CSSProperties
      }
    >
      {children(room, frame.cap)}
    </div>,
    host,
  );
}
