/**
 * A tag's colour, in its sidebar right-click menu (approval "inbox-thread-tags", step 3; the picker: approval
 * "inbox-tag-colors-picker", `.product/approved/inbox-tag-colors-picker/`; two rows since the owner's 2026-11-16
 * word): Highlight rows is a checkbox that turns the tag's tint on and off at once, and Color names the tag's colour
 * (on or off) and swaps the menu for the picker in place, as Add tag and Snooze do. `‹ Color` goes back; twelve quick
 * swatches (the first row vivid, the second calm), the person's own colours (the last three, on any tag), a
 * two-dimensional square (ColorSquare.tsx), a hue strip and a Hex field; a line that says what is on. A pick shows at
 * once, turns Highlight rows on, and the menu stays open.
 *
 * Keys: every swatch is one radio of the menu (its arrows reach them); Down from the last swatch goes to the strip,
 * Up from the strip back to it, Down from the strip to the field and Up from the field to the strip, so the arrows
 * pass the square by. The square is a Tab stop (Tab from a swatch, Shift+Tab from the strip; Tab goes on in the
 * picker's order, swatch, square, strip, field, and round): its arrows move it and stay in it. Nothing is written by
 * moving focus; a move on the square or the strip is written once, when a drag is let go or a key move rests, and only
 * if the colour changed. Draw inside a Base UI `ContextMenu.Popup`.
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

/** The tag menu's Color item: a dot of the tag's colour where the icons sit, its name ("Teal", "Custom") at the right. */
export function TagColourItem({ colour, onOpen }: { colour: string; onOpen: () => void }) {
  return (
    <Menu.Item className="ib-pmi" label="Color" closeOnClick={false} onClick={onOpen} data-tag-action="colour">
      <span className="ib-tagm-dot" aria-hidden="true" style={{ background: tagShownHex(colour) }} />
      Color
      <span className="ib-zsub">
        <span className="ib-tagm-n">{tagColourName(colour)}</span>
        <Icon name="chevR" size={13} />
      </span>
    </Menu.Item>
  );
}

/** The swapped-in list. */
export function TagColourList({ tag, colours, onBack }: { tag: ListTag; colours: TagColourControls; onBack: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // What the rows show (null: Highlight rows off), and the tag's colour either way.
  const colour = colours.colourOf(tag.id);
  const picked = colours.pickOf(tag.id);
  // What the colour shows as: a stored name (an earlier Inbox's) as its calm colour, so accent checks Indigo.
  const shown = tagShownHex(picked);
  const quick = TAG_SWATCHES.some((sw) => sw.hex === shown);
  const own = quick ? null : shown;
  const [typed, setTyped] = useState(shown);
  // The square and the strip: hue, saturation, brightness (whole percents). A grey keeps the hue it had. `origin` is
  // the colour they were set from: back at its place they give that colour exactly, not a code read back from rounded
  // percents (a swatch never drifts to a near Custom).
  const [hsv, setHsv] = useState(() => hsvOf(shown, 30));
  const origin = useRef({ hsv: hsvOf(shown, 30), hex: shown });
  const hexAt = (at: Hsv) => (at.h === origin.current.hsv.h && at.s === origin.current.hsv.s && at.v === origin.current.hsv.v ? origin.current.hex : hsvToHex(at.h, at.s / 100, at.v / 100));
  // Focus starts on the colour that is on: the menu keeps the index of the Color item across the swap.
  useLayoutEffect(() => focusAfterSwap(() => body.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? body.current?.querySelector<HTMLElement>('[role="menuitemradio"]')), []);
  // A move on the square or the strip by keys (or a screen reader's swipe) is written once it rests, so each step is
  // not its own colour among the recent ones; dragged, once it is let go.
  const dragging = useRef(false);
  const resting = useRef<{ timer: ReturnType<typeof setTimeout>; hex: string } | null>(null);
  const stopResting = () => {
    if (resting.current) clearTimeout(resting.current.timer);
    resting.current = null;
  };
  const pickedRef = useRef(shown);
  pickedRef.current = shown;
  // The end of a move: written if it changed the colour; else the rows go back to it (a tap on a thumb writes nothing).
  const settle = (hex: string) => {
    stopResting();
    if (hex === pickedRef.current) colours.preview(tag, undefined);
    else pick(hex);
  };
  const settleLater = (hex: string, wait: number) => {
    stopResting();
    resting.current = { hex, timer: setTimeout(() => settle(hex), wait) };
  };
  // Closing the menu writes a move still resting; a colour only tried (Escape in the field) goes with it.
  useEffect(
    () => () => {
      const pending = resting.current;
      if (pending) {
        clearTimeout(pending.timer);
        if (pending.hex !== pickedRef.current) colours.set(tag, pending.hex);
      }
      colours.preview(tag, undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on close only; `set` and `preview` reach the live host
    [],
  );
  // The own colours: the recent ones (never a quick swatch), with the tag's own first when it is not among them.
  const mine = tagOwnRecent(colours.recent);
  const recent = own && !mine.includes(own) ? [own, ...mine].slice(0, 3) : mine.slice(0, 3);
  // A code typed and not yet kept: leaving the field keeps it. Once kept (or another colour picked), leaving does nothing.
  const typedOpen = useRef(false);
  const pick = (next: string) => {
    typedOpen.current = false;
    stopResting();
    colours.set(tag, next);
    const hex = tagShownHex(next);
    pickedRef.current = hex;
    setTyped(hex);
    // A move on the square kept as is: the thumb stays where it was. A colour from elsewhere sets them, and is their origin.
    setHsv((was) => {
      const at = hexAt(was) === hex ? was : hsvOf(hex, was.h);
      origin.current = { hsv: at, hex };
      return at;
    });
  };
  // A move on the square or the strip: shown on the rows at once, settled when let go (`wait` 0) or once it rests.
  const tryHsv = (next: Hsv, wait: number | null) => {
    setHsv(next);
    const hex = hexAt(next);
    setTyped(hex);
    colours.preview(tag, hex);
    if (wait === 0) settle(hex);
    else if (wait !== null) settleLater(hex, wait);
  };
  // Up and Down leave the strip and the field (to the swatch above, the field below, the strip above); every other key is theirs.
  const stepOut = (event: KeyboardEvent<HTMLInputElement>, up: () => HTMLElement | null | undefined, down: () => HTMLElement | null | undefined) => {
    if (event.key === 'Escape') return;
    event.stopPropagation();
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    (event.key === 'ArrowUp' ? up() : down())?.focus({ preventScroll: true });
  };
  const lastSwatch = () => [...(body.current?.querySelectorAll<HTMLElement>('.ib-tagc-swb') ?? [])].at(-1);
  const ownName = (hex: string) => (isInboxTagPreset(picked) && hex === shown ? TAG_PRESET_NAMES[picked] : tagColourLong(hex));
  return (
    <div ref={body} data-tag-colour-list="">
      <Menu.Item className="ib-pmi ib-zb" label="Color" closeOnClick={false} onClick={onBack} data-tag-colour-back="">
        <Icon name="chevL" size={14} />
        Color
      </Menu.Item>
      <Menu.Separator className="ib-pm-sep" />
      {/* The checked swatch pressed again reports itself too: written only while Highlight rows is off (it turns it on). */}
      <Menu.RadioGroup value={shown} onValueChange={(next: string) => (next !== shown || colour === null) && pick(next)} aria-label={`Color for ${tag.name}`}>
        {[TAG_SWATCHES.slice(0, 6), TAG_SWATCHES.slice(6)].map((line, i) => (
          <div key={i} className={`ib-tagc-sw${i > 0 ? ' ib-tagc-sw2' : ''}`}>
            {line.map((sw) => (
              <Swatch key={sw.hex} value={sw.hex} name={sw.name} on={shown === sw.hex} toStrip={() => strip.current} />
            ))}
          </div>
        ))}
        {recent.length > 0 && (
          <div className="ib-tagc-sw ib-tagc-sw2">
            {recent.map((hex) => (
              <Swatch key={hex} value={hex} name={ownName(hex)} on={shown === hex} toStrip={() => strip.current} />
            ))}
          </div>
        )}
      </Menu.RadioGroup>
      <ColorSquare
        hue={hsv.h}
        s={hsv.s}
        v={hsv.v}
        onMove={(s, v, by) => tryHsv({ ...hsv, s, v }, by === 'key' ? 800 : null)}
        onLetGo={(s, v) => tryHsv({ ...hsv, s, v }, 0)}
        onBlur={() => resting.current && settle(resting.current.hex)}
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
            // Moved without a pointer (keys, a screen reader's swipe): settled once it rests.
            tryHsv({ ...hsv, h: Number(event.target.value) }, dragging.current ? null : 800);
          }}
          // The rows follow the strip while it moves; it is settled when let go (a tap on the thumb changes nothing).
          onPointerDown={() => (dragging.current = true)}
          onPointerUp={(event) => {
            dragging.current = false;
            tryHsv({ ...hsv, h: Number(event.currentTarget.value) }, 0);
          }}
          onPointerCancel={(event) => {
            dragging.current = false;
            tryHsv({ ...hsv, h: Number(event.currentTarget.value) }, 0);
          }}
          // Leaving the strip settles a move still resting.
          onBlur={() => resting.current && settle(resting.current.hex)}
          onKeyDown={(event) => stepOut(event, lastSwatch, () => field.current)}
        />
      </div>
      <label className="ib-tagc-hex">
        <span className="ib-tagc-hexl">Hex</span>
        <input
          ref={field}
          value={typed}
          placeholder="#rrggbb"
          spellCheck={false}
          autoComplete="off"
          aria-label="Hex color"
          data-tag-colour-hex=""
          onChange={(event) => {
            // Trimmed first, then held to a code's length (with or without "#"): a pasted "  #00FF88  " is kept whole. A
            // key typed into a whole code is refused, as a length limit would (it never pushes the last letter out).
            const value = event.target.value.trim();
            const limit = value.startsWith('#') ? 7 : 6;
            const full = typed.length >= (typed.startsWith('#') ? 7 : 6);
            if (value.length > limit && full) return;
            const code = value.slice(0, limit);
            setTyped(code);
            typedOpen.current = true;
            // A part-typed code does nothing; a whole one shows at once.
            const hex = inboxTagHex(code);
            if (hex && /^#?[0-9a-f]{6}$/i.test(code)) {
              colours.preview(tag, hex);
              setHsv((was) => hsvOf(hex, was.h));
            }
          }}
          onBlur={() => {
            if (!typedOpen.current) return;
            const hex = inboxTagHex(typed);
            if (hex && hex !== shown) pick(hex);
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
            stepOut(event, () => strip.current, () => null);
          }}
        />
      </label>
      <div className="ib-tagc-cap" data-tag-colour-caption="" aria-live="polite">
        {tagColourCaption(colour, tag.name)}
      </div>
    </div>
  );
}

type Hsv = { h: number; s: number; v: number };
/** A colour on the square and strip: whole percents; a grey (no hue) keeps `hue`. */
function hsvOf(hex: string, hue: number): Hsv {
  const { h, s, v } = hexToHsv(hex);
  // Whole degrees, as the strip has them, so a colour's place reads back as its origin (and gives it exactly).
  return { h: s > 0 ? Math.round(h) % 360 : hue, s: Math.round(s * 100), v: Math.round(v * 100) };
}

/**
 * One round swatch, the picked colour itself: a radio of the menu, its name in its label and tooltip, a check when it
 * is on. Down from the last swatch goes on to the strip (`toStrip`), past the square; Tab to the square.
 */
function Swatch({ value, name, on, toStrip }: { value: string; name: string; on: boolean; toStrip: () => HTMLElement | null }) {
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
        const list = event.currentTarget.closest('[data-tag-colour-list]');
        // Tab goes on to the square, Shift+Tab back to the field, as from the strip and the field (a menu item's Tab
        // would close the menu).
        if (event.key === 'Tab') {
          const to = list?.querySelector<HTMLElement>(event.shiftKey ? '[data-tag-colour-hex]' : '[data-tag-colour-square]');
          if (!to) return;
          event.preventDefault();
          event.stopPropagation();
          to.focus({ preventScroll: true });
          return;
        }
        if (event.key !== 'ArrowDown') return;
        if ([...(list?.querySelectorAll<HTMLElement>('.ib-tagc-swb') ?? [])].at(-1) !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        toStrip()?.focus({ preventScroll: true });
      }}
    >
      {on && <Icon name="check" size={15} />}
    </Menu.RadioItem>
  );
}
