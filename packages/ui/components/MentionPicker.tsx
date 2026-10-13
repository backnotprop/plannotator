import { createPortal } from 'react-dom';
import type { MentionPerson } from '../utils/mentions';

/**
 * The `@` menu over the comment composer's textarea.
 *
 * NOTHING IS PRESELECTED (`active === null` until the person arrows into the
 * list), the same rule `useSkillReferenceAutocomplete` keeps for `/` and `$`:
 * until then Enter and Tab mean what they always meant in a comment box.
 *
 * PORTALED AND FIXED, not absolute inside the composer: the popover clips its
 * own box and the expanded dialog scrolls, so a menu positioned inside the
 * textarea's wrapper is cut off at the card's edge. It is placed from the
 * textarea's measured rect instead — above it by default, below when the
 * composer sits too close to the top of the window for the menu to open
 * upward.
 */

export interface MentionAnchor {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
}

/** The menu's own height cap (max-h-48 = 12rem), in px. */
const MENU_MAX_PX = 192;
const MENU_GAP_PX = 4;

/** Measure the composer textarea for {@link MentionPicker}. Null closes the menu. */
export function mentionAnchorOf(element: HTMLElement | null): MentionAnchor | null {
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width };
}

/** The optional avatar column: an image, else initials on a tinted disc. */
function MentionAvatar({
  avatar,
  label,
}: {
  readonly avatar: NonNullable<MentionPerson['avatar']>;
  readonly label: string;
}) {
  if (avatar.url) {
    return (
      <img
        data-mention-avatar="image"
        src={avatar.url}
        alt=""
        aria-hidden="true"
        className="h-4 w-4 shrink-0 rounded-full object-cover"
      />
    );
  }
  const initials = (avatar.initials ?? label.trim().charAt(0)).slice(0, 2).toUpperCase();
  return (
    <span
      data-mention-avatar="initials"
      aria-hidden="true"
      style={avatar.tint ? { backgroundColor: avatar.tint } : undefined}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold leading-none ${
        avatar.tint ? 'text-white' : 'bg-muted text-foreground/80'
      }`}
    >
      {initials}
    </span>
  );
}

export function MentionPicker({
  id,
  people,
  emptyNotice,
  heading,
  active,
  anchor,
  onPick,
  onHover,
}: {
  /** Id referenced by the focused textarea's aria-controls attribute. */
  readonly id?: string;
  readonly people: readonly MentionPerson[];
  /** Shown as one non-selectable row when `people` is empty. */
  readonly emptyNotice?: string | null;
  /** Optional heading above the list. Absent → nothing rendered. */
  readonly heading?: string | null;
  /** Index of the arrow-focused row, or null for "nothing preselected". */
  readonly active: number | null;
  readonly anchor: MentionAnchor | null;
  readonly onPick: (person: MentionPerson) => void;
  readonly onHover: (index: number) => void;
}) {
  if (anchor === null || typeof document === 'undefined') return null;
  if (people.length === 0 && !emptyNotice) return null;
  const above = anchor.top >= MENU_MAX_PX + MENU_GAP_PX;
  const style = above
    ? { bottom: window.innerHeight - anchor.top + MENU_GAP_PX }
    : { top: anchor.bottom + MENU_GAP_PX };
  return createPortal(
    <div
      id={id}
      role="listbox"
      aria-label="People"
      data-mention-picker
      data-placement={above ? 'above' : 'below'}
      style={{ position: 'fixed', left: anchor.left, width: anchor.width, ...style }}
      className="z-[120] max-h-48 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-xl"
    >
      {heading && (
        <p data-mention-heading className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {heading}
        </p>
      )}
      {people.length === 0 ? (
        <p data-mention-empty className="px-2 py-1 text-[11px] text-muted-foreground">
          {emptyNotice}
        </p>
      ) : (
        people.map((person, index) => (
          <button
            key={person.id}
            type="button"
            role="option"
            id={id ? `${id}-option-${index}` : undefined}
            aria-selected={active === index}
            data-mention-option={person.id}
            // The pick must run before the textarea loses focus, or the blur
            // would close the menu and swallow the click.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(person);
            }}
            onMouseEnter={() => onHover(index)}
            className={`flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-xs transition-colors ${
              active === index ? 'bg-muted text-foreground' : 'text-foreground/85 hover:bg-muted/60'
            }`}
          >
            {person.avatar && <MentionAvatar avatar={person.avatar} label={person.label} />}
            <span className="min-w-0 flex-1 truncate">{person.label}</span>
            {person.detail && (
              // The NAME is what the person reads; the detail gives way first.
              <span className="min-w-0 max-w-[44%] shrink-0 truncate text-[10px] text-muted-foreground">
                {person.detail}
              </span>
            )}
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
