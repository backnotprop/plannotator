/**
 * A tag's colour, in its sidebar right-click menu (approval "inbox-thread-tags", step 3; the picker: approval
 * "inbox-tag-colors-picker", `.product/approved/inbox-tag-colors-picker/picker.html`): the Highlight rows item, which
 * names the colour, and the list it swaps the menu for in place, as Add tag and Snooze do. `‹ Highlight rows` goes
 * back; twelve quick swatches (the first row vivid, the second calm), the person's own colours (the last three, on
 * any tag), a two-dimensional square (ColorSquare.tsx), a hue strip and a Hex field; a line that says what is on;
 * None. A pick shows at once and the menu stays open. Every swatch and None is one radio of the menu (its arrows reach
 * them); the square, the strip and the field take their own keys, and Up and Down step out of them at their edges to
 * the swatches and None. Draw inside a Base UI `ContextMenu.Popup`.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Menu } from '@base-ui/react/menu';
import { inboxTagHex, isInboxTagPreset } from '@plannotator/core/inbox-types';
import { focusAfterSwap } from '@plannotator/ui/components/inbox-thread/SnoozeMenu';
import { Icon } from '../icons';
import { swatchInk, tagColourCaption, tagColourLong, tagColourName, tagOwnRecent, tagShownHex, TAG_PRESET_NAMES, TAG_SWATCHES } from '../tagColours';
import { hexToHsv, hsvToHex } from '../tagColourMap';
import { ColorSquare } from './ColorSquare';
import type { TagColourControls } from '../useThreadTagsHost';
import type { ListTag } from '../threadTags';

/** The tag menu's Highlight rows item: the colour's name at its right ("Green", "Custom"), nothing with None. */
export function TagColourItem({ colour, onOpen }: { colour: string | null; onOpen: () => void }) {
  return (
    <Menu.Item className="ib-pmi" label="Highlight rows" closeOnClick={false} onClick={onOpen} data-tag-action="colour">
      <Icon name="sun" size={15} />
      Highlight rows
      <span className="ib-zsub">
        {colour && <span className="ib-tagm-n">{tagColourName(colour)}</span>}
        <Icon name="chevR" size={13} />
      </span>
    </Menu.Item>
  );
}

const NONE = 'none';

/** The swapped-in list. */
export function TagColourList({ tag, colours, onBack }: { tag: ListTag; colours: TagColourControls; onBack: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const colour = colours.colourOf(tag.id);
  // What the colour shows as: a stored name (an earlier Inbox's) as its calm colour, so accent checks Indigo.
  const shown = colour ? tagShownHex(colour) : null;
  const quick = shown !== null && TAG_SWATCHES.some((sw) => sw.hex === shown);
  const own = shown && !quick ? shown : null;
  const [typed, setTyped] = useState(shown ?? '');
  // The square and the strip: hue, saturation, brightness (whole percents). A grey keeps the hue it had.
  const [hsv, setHsv] = useState(() => hsvOf(shown ?? DEFAULT_HEX, 30));
  // Focus starts on the colour that is on (else the first): the menu keeps the index of Highlight rows across the swap.
  useLayoutEffect(() => focusAfterSwap(() => body.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? body.current?.querySelector<HTMLElement>('[role="menuitemradio"]')), []);
  // The square or the strip moved by keys or a screen reader's swipe is kept once it rests, so each step is not its
  // own colour among the recent ones; dragged, it is kept when let go.
  const dragging = useRef(false);
  const stripKeep = useRef<{ timer: ReturnType<typeof setTimeout>; hex: string } | null>(null);
  const keepStrip = (hex: string, wait: number) => {
    if (stripKeep.current) clearTimeout(stripKeep.current.timer);
    stripKeep.current = null;
    if (wait === 0) return pick(hex);
    stripKeep.current = { hex, timer: setTimeout(() => pick(hex), wait) };
  };
  // Closing the menu keeps a strip move still resting; a colour only tried (Escape in the field) goes with it.
  useEffect(
    () => () => {
      const pending = stripKeep.current;
      if (pending) {
        clearTimeout(pending.timer);
        colours.set(tag, pending.hex);
      }
      colours.preview(tag, undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on close only; `set` and `preview` reach the live host
    [],
  );
  // The own colours: the recent ones (never a quick swatch), with the one on first when it is not among them.
  const mine = tagOwnRecent(colours.recent);
  const recent = own && !mine.includes(own) ? [own, ...mine].slice(0, 3) : mine.slice(0, 3);
  // A code typed and not yet kept: leaving the field keeps it. Once kept (or another colour picked), leaving does nothing.
  const typedOpen = useRef(false);
  const pick = (next: string | null) => {
    typedOpen.current = false;
    if (stripKeep.current) clearTimeout(stripKeep.current.timer);
    stripKeep.current = null;
    colours.set(tag, next);
    if (next) {
      const hex = tagShownHex(next);
      setTyped(hex);
      // A move on the square kept as is: the thumb stays where it was (a code read back can round a percent).
      setHsv((was) => (hsvToHex(was.h, was.s / 100, was.v / 100) === hex ? was : hsvOf(hex, was.h)));
    }
  };
  // A move on the square or the strip: shown on the rows at once, kept when let go (`wait` 0) or once it rests.
  const tryHsv = (next: Hsv, wait: number | null) => {
    setHsv(next);
    const hex = hsvToHex(next.h, next.s / 100, next.v / 100);
    setTyped(hex);
    colours.preview(tag, hex);
    if (wait !== null) keepStrip(hex, wait);
  };
  const radios = () => [...(body.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
  // Up and Down leave the strip and the field for the swatch above or None below; every other key is theirs.
  const stepOut = (event: KeyboardEvent<HTMLInputElement>, up: () => HTMLElement | null | undefined, down: () => HTMLElement | null | undefined) => {
    if (event.key === 'Escape') return;
    event.stopPropagation();
    const to = event.key === 'ArrowUp' ? up() : event.key === 'ArrowDown' ? down() : null;
    if (!to) return;
    event.preventDefault();
    to.focus({ preventScroll: true });
  };
  const lastSwatch = () => radios().filter((r) => r.getAttribute('data-colour') !== NONE).at(-1);
  const noneItem = () => body.current?.querySelector<HTMLElement>(`[data-colour="${NONE}"]`);
  const square = () => body.current?.querySelector<HTMLElement>('[data-tag-colour-square]');
  const ownName = (hex: string) => (colour && isInboxTagPreset(colour) && hex === shown ? TAG_PRESET_NAMES[colour] : tagColourLong(hex));
  return (
    <div ref={body} data-tag-colour-list="">
      <Menu.Item className="ib-pmi ib-zb" label="Highlight rows" closeOnClick={false} onClick={onBack} data-tag-colour-back="">
        <Icon name="chevL" size={14} />
        Highlight rows
      </Menu.Item>
      <Menu.Separator className="ib-pm-sep" />
      <Menu.RadioGroup value={shown ?? NONE} onValueChange={(next: string) => pick(next === NONE ? null : next)} aria-label={`Highlight color for ${tag.name}`}>
        {[TAG_SWATCHES.slice(0, 6), TAG_SWATCHES.slice(6)].map((line, i) => (
          <div key={i} className={`ib-tagc-sw${i > 0 ? ' ib-tagc-sw2' : ''}`}>
            {line.map((sw) => (
              <Swatch key={sw.hex} value={sw.hex} name={sw.name} on={shown === sw.hex} />
            ))}
          </div>
        ))}
        {recent.length > 0 && (
          <div className="ib-tagc-sw ib-tagc-sw2">
            {recent.map((hex) => (
              <Swatch key={hex} value={hex} name={ownName(hex)} on={shown === hex} />
            ))}
          </div>
        )}
        <ColorSquare
          hue={hsv.h}
          s={hsv.s}
          v={hsv.v}
          onMove={(s, v, by) => tryHsv({ ...hsv, s, v }, by === 'key' ? 800 : null)}
          onLetGo={(s, v) => tryHsv({ ...hsv, s, v }, 0)}
          onStepUp={() => lastSwatch()?.focus({ preventScroll: true })}
          onStepDown={() => strip.current?.focus({ preventScroll: true })}
          onBlur={() => stripKeep.current && keepStrip(stripKeep.current.hex, 0)}
        />
        <div className="ib-tagc-hue">
          <input
            ref={strip}
            type="range"
            min={0}
            max={359}
            value={Math.round(hsv.h)}
            aria-label="Hue"
            aria-valuetext={`Hue ${Math.round(hsv.h)}`}
            data-tag-colour-hue=""
            onChange={(event) => {
              // Moved without a pointer (keys, a screen reader's swipe): kept once it rests.
              tryHsv({ ...hsv, h: Number(event.target.value) }, dragging.current ? null : 800);
            }}
            // The rows follow the strip while it moves; the colour is kept when it is let go.
            onPointerDown={() => (dragging.current = true)}
            onPointerUp={(event) => {
              dragging.current = false;
              tryHsv({ ...hsv, h: Number(event.currentTarget.value) }, 0);
            }}
            onPointerCancel={(event) => {
              dragging.current = false;
              tryHsv({ ...hsv, h: Number(event.currentTarget.value) }, 0);
            }}
            // Leaving the strip keeps a move still resting.
            onBlur={() => stripKeep.current && keepStrip(stripKeep.current.hex, 0)}
            onKeyUp={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) keepStrip(hsvToHex(Number(event.currentTarget.value), hsv.s / 100, hsv.v / 100), 800);
            }}
            onKeyDown={(event) => stepOut(event, square, () => field.current)}
          />
        </div>
        <label className="ib-tagc-hex">
          <span className="ib-tagc-hexl">Hex</span>
          <input
            ref={field}
            value={typed}
            placeholder="#rrggbb"
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            aria-label="Hex color"
            data-tag-colour-hex=""
            onChange={(event) => {
              setTyped(event.target.value);
              typedOpen.current = true;
              // A part-typed code does nothing; a whole one shows at once.
              const hex = inboxTagHex(event.target.value);
              if (hex && /^#?[0-9a-f]{6}$/i.test(event.target.value.trim())) {
                colours.preview(tag, hex);
                setHsv((was) => hsvOf(hex, was.h));
              }
            }}
            onBlur={() => {
              if (!typedOpen.current) return;
              const hex = inboxTagHex(typed);
              if (hex && hex !== colour) pick(hex);
              else {
                typedOpen.current = false;
                colours.preview(tag, undefined);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                const hex = inboxTagHex(typed);
                if (hex) pick(hex);
                return;
              }
              stepOut(event, () => strip.current, noneItem);
            }}
          />
        </label>
        <div className="ib-tagc-cap" data-tag-colour-caption="" aria-live="polite">
          {tagColourCaption(colour, tag.name)}
        </div>
        <Menu.Separator className="ib-pm-sep" />
        <Menu.RadioItem
          value={NONE}
          className="ib-pmi"
          label="None"
          closeOnClick={false}
          data-colour={NONE}
          onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
            if (event.key !== 'ArrowUp') return;
            event.preventDefault();
            event.stopPropagation();
            field.current?.focus({ preventScroll: true });
          }}
        >
          <Icon name="x" size={15} />
          None
          {colour === null ? <Icon name="check" size={15} className="ib-pmi-check ib-tagm-tick" /> : <span className="ib-tagm-slot" aria-hidden="true" />}
        </Menu.RadioItem>
      </Menu.RadioGroup>
    </div>
  );
}

type Hsv = { h: number; s: number; v: number };
/** Where the square and strip start with no colour on. */
const DEFAULT_HEX = '#e8913a';
/** A colour on the square and strip: whole percents; a grey (no hue) keeps `hue`. */
function hsvOf(hex: string, hue: number): Hsv {
  const { h, s, v } = hexToHsv(hex);
  return { h: s > 0 ? h : hue, s: Math.round(s * 100), v: Math.round(v * 100) };
}

/** One round swatch, the picked colour itself: a radio of the menu, its name in its label and tooltip, a check when it is on. */
function Swatch({ value, name, on }: { value: string; name: string; on: boolean }) {
  const style: CSSProperties = { background: value, color: swatchInk(value) };
  return (
    <Menu.RadioItem
      value={value}
      className="ib-tagc-swb"
      label={name}
      closeOnClick={false}
      aria-label={name}
      title={name}
      data-colour={value}
      data-on={on ? '' : undefined}
      style={style}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        // Down from the last swatch goes on to the square.
        if (event.key !== 'ArrowDown') return;
        const list = event.currentTarget.closest('[data-tag-colour-list]');
        const swatches = [...(list?.querySelectorAll<HTMLElement>('.ib-tagc-swb') ?? [])];
        if (swatches.at(-1) !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        list?.querySelector<HTMLElement>('[data-tag-colour-square]')?.focus({ preventScroll: true });
      }}
    >
      {on && <Icon name="check" size={15} />}
    </Menu.RadioItem>
  );
}
