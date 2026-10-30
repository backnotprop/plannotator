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
 * Where the picker opens: by default against the field's own box (the reply
 * box, two lines tall, so that is at the caret). A tall field in a modal
 * dialog (compose) passes `caretMenu`: the picker then opens at the caret's
 * line, portaled into the dialog so the field's scroll container cannot clip
 * it, and kept inside the box `caretMenu.bounds` names (compose: the viewport
 * on a desktop, so it floats over the footer; the sheet above its footer on a
 * phone).
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ComposerTokenTextarea } from '@plannotator/ui/components/ComposerTokenTextarea';
import { HumanOnlySkillNotice, SkillReferenceMenu } from '@plannotator/ui/components/SkillReferenceMenu';
import { useMentionAutocomplete } from '@plannotator/ui/hooks/useMentionAutocomplete';
import { useSkillReferenceAutocomplete } from '@plannotator/ui/hooks/useSkillReferenceAutocomplete';
import type { MentionPerson, MentionSource } from '@plannotator/ui/utils/mentions';
import { TAG_UPDATE_WORDS, tagPeople, tagPickedWords, type TagOption } from '../tags';
import { caretAnchor, caretLineRect, visibleBox, type AnchorBox, type VerticalBox } from '../caretMenu';
import { TagNotes, TagPicker } from './TagPicker';

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
}

const NO_PEOPLE: readonly MentionPerson[] = [];

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
}: InboxComposerFieldProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const attach = useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (textareaRef) textareaRef.current = el;
    },
    [textareaRef],
  );
  const skills = useSkillReferenceAutocomplete({
    text: value,
    setText: onChange,
    textareaRef: innerRef,
    enabled: true,
    bareEscapeDismisses: escapeClosesMenu,
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
  const listboxId = tagMenu ? tagListboxId : skillListboxId;
  const activeOption =
    tagMenu && tagMenu.activeIndex !== null
      ? `${tagListboxId}-option-${tagMenu.activeIndex}`
      : !tagMenu && skillActive !== null && skillActive !== undefined
        ? `${skillListboxId}-option-${skillActive}`
        : undefined;
  const select = (index: number) => {
    const person = tagMenu?.items[index];
    const option = person ? options?.find((o) => o.id === person.id) : undefined;
    mention.select(index);
    if (option?.taggable) setAnnounce(tagPickedWords(option));
  };
  const host = caretMenu ? (innerRef.current?.closest('dialog') ?? null) : null;
  const describedBy = [ariaDescribedBy, showNotes ? notesId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="ib-cfield" data-composer-field="">
      {skills.menu && !tagMenu && caretMenu && host && innerRef.current ? (
        <CaretSkillMenu textarea={innerRef.current} host={host} options={caretMenu}>
          {(boundary) => (
            <SkillReferenceMenu
              id={skillListboxId}
              items={skills.menu!.items}
              activeIndex={skills.menu!.activeIndex}
              onSelect={skills.select}
              boundary={boundary}
              prefer={caretMenu.prefer}
              maxListHeight={caretMenu.maxListHeight}
            />
          )}
        </CaretSkillMenu>
      ) : skills.menu && !tagMenu ? (
        <SkillReferenceMenu id={skillListboxId} items={skills.menu.items} activeIndex={skills.menu.activeIndex} onSelect={skills.select} />
      ) : null}
      {tagMenu && options && <TagPicker id={tagListboxId} menu={tagMenu} options={options} onSelect={select} />}
      <ComposerTokenTextarea
        textareaRef={attach}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          skills.onSelect();
          mention.onSelect();
        }}
        onKeyDown={(event) => {
          if (tagMenu && (event.key === 'Enter' || event.key === 'Tab') && !event.metaKey && !event.ctrlKey && !event.altKey && tagMenu.activeIndex !== null) {
            event.preventDefault();
            select(tagMenu.activeIndex);
            return;
          }
          if (mention.onKeyDown(event)) return;
          if (skills.onKeyDown(event)) return;
          onKeyDown?.(event);
        }}
        onSelectCaret={() => {
          skills.onSelect();
          mention.onSelect();
        }}
        placeholder={placeholder}
        sizeClassName=""
        textClassName=""
        inputClassName="ib-rtext"
        mirrorClassName="ib-rmirror"
        skillReferences
        tokens={skills.referenceTokens}
        mentionChips={source ? { people: mention.mentions, tokenClassName: TAG_TOKEN_CLASS } : null}
        listboxId={listboxId}
        listboxOpen={skills.menu !== null || tagMenu !== null}
        activeOptionId={activeOption}
        inputProps={{ 'aria-label': ariaLabel, 'aria-describedby': describedBy, rows: 2 }}
      />
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
 * The picker at the caret: a box laid over the caret's line, absolutely
 * positioned in the dialog (a modal dialog is in the top layer, so a portal
 * to the body would render under it), with the menu hanging above or below it
 * as SkillReferenceMenu decides against `options.bounds`. The box follows the
 * caret on every render (typing, a caret move) and on any scroll or resize.
 */
function CaretSkillMenu({
  textarea,
  host,
  options,
  children,
}: {
  textarea: HTMLTextAreaElement;
  host: HTMLElement;
  options: CaretMenuOptions;
  children: (boundary: () => VerticalBox | null) => React.ReactNode;
}) {
  const [box, setBox] = useState<AnchorBox | null>(null);
  const boundsRef = useRef(options.bounds);
  boundsRef.current = options.bounds;
  const boundary = useCallback(() => boundsRef.current(), []);

  const update = useCallback(() => {
    const field = textarea.getBoundingClientRect();
    // Not laid out (a test DOM): the field's top edge, so the menu still renders.
    const line = caretLineRect(textarea) ?? { top: field.top, bottom: field.top };
    const visible = visibleBox(textarea, host);
    const anchor = caretAnchor(line, visible, { left: field.left, width: field.width });
    // In the host's coordinates: an absolute box is placed against its padding box.
    const h = host.getBoundingClientRect();
    const next: AnchorBox = {
      top: Math.round(anchor.top - h.top - host.clientTop + host.scrollTop),
      bottom: Math.round(anchor.bottom - h.top - host.clientTop + host.scrollTop),
      left: Math.round(anchor.left - h.left - host.clientLeft + host.scrollLeft),
      width: Math.round(anchor.width),
    };
    setBox((prev) =>
      prev && prev.top === next.top && prev.bottom === next.bottom && prev.left === next.left && prev.width === next.width ? prev : next,
    );
  }, [host, textarea]);

  // Every commit: the caret moved or the text changed (the equality guard above converges).
  useLayoutEffect(() => {
    update();
  });

  useEffect(() => {
    const viewport = window.visualViewport;
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, [update]);

  if (!box) return null;
  return createPortal(
    <div
      className="ib-skanchor"
      data-skill-menu-anchor=""
      style={{ top: box.top, left: box.left, width: box.width, height: Math.max(0, box.bottom - box.top) }}
    >
      {children(boundary)}
    </div>,
    host,
  );
}
