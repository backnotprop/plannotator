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
 * Keys: the picker sees a key first and takes only what it was aimed at (a
 * row arrowed onto, Escape after typing a query), so Enter, Tab and Mod+Enter
 * keep their meaning and the host's own `onKeyDown` gets everything else.
 * With no skills installed (or the route missing) `/` and `$` are plain text.
 */
import React, { useCallback, useId, useRef } from 'react';
import { ComposerTokenTextarea } from '@plannotator/ui/components/ComposerTokenTextarea';
import { HumanOnlySkillNotice, SkillReferenceMenu } from '@plannotator/ui/components/SkillReferenceMenu';
import { useSkillReferenceAutocomplete } from '@plannotator/ui/hooks/useSkillReferenceAutocomplete';

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
}

export function InboxComposerField({
  value,
  onChange,
  onKeyDown,
  textareaRef,
  placeholder,
  ariaLabel,
  ariaDescribedBy,
  destination,
}: InboxComposerFieldProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const attach = useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (textareaRef) textareaRef.current = el;
    },
    [textareaRef],
  );
  const skills = useSkillReferenceAutocomplete({ text: value, setText: onChange, textareaRef: innerRef, enabled: true });
  const listboxId = `ib-skills-${useId().replace(/:/g, '')}`;
  const active = skills.menu?.activeIndex;
  return (
    <div className="ib-cfield" data-composer-field="">
      {skills.menu && (
        <SkillReferenceMenu id={listboxId} items={skills.menu.items} activeIndex={skills.menu.activeIndex} onSelect={skills.select} />
      )}
      <ComposerTokenTextarea
        textareaRef={attach}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          skills.onSelect();
        }}
        onKeyDown={(event) => {
          if (skills.onKeyDown(event)) return;
          onKeyDown?.(event);
        }}
        onSelectCaret={skills.onSelect}
        placeholder={placeholder}
        sizeClassName=""
        textClassName=""
        inputClassName="ib-rtext"
        mirrorClassName="ib-rmirror"
        skillReferences
        tokens={skills.referenceTokens}
        mentionChips={null}
        listboxId={listboxId}
        listboxOpen={skills.menu !== null}
        activeOptionId={active === null || active === undefined ? undefined : `${listboxId}-option-${active}`}
        inputProps={{ 'aria-label': ariaLabel, 'aria-describedby': ariaDescribedBy, rows: 2 }}
      />
      <HumanOnlySkillNotice skills={skills.humanOnlyReferences} destination={destination} />
    </div>
  );
}
