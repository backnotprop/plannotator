/**
 * The fixture for words, lines and curves: bare text in every size and
 * face, lines drawn by hand on the board and over a pale and a dark
 * picture, curved connectors, and the colour cases that once drew wrong (a
 * note in a custom colour, a plain box filled solid). Open with
 * `?data=marks`; look at it in both themes when a colour rule changes. The
 * crowd at the foot holds more than 150 objects, so the whole board at
 * "fit" is drawn at the lowest detail: its name and its frames' names must
 * still be words.
 */
import { CanvasStore } from '../events/store';
import { createDocument } from '../model/document';
import { strokeFromPoints } from '../model/ink';
import type { CanvasObject } from '../model/types';
import { serializeSnapshotBlock } from '../snapshot/block';

export const MARKS_CANVAS_ID = 'marks';
const PERSON = { kind: 'person', id: 'ines' } as const;

type Loose = Record<string, unknown>;

/** A ring as a hand draws it: not quite round, not quite closed. */
function ring(id: string, cx: number, cy: number, rx: number, ry: number, extra: Loose = {}): Loose {
  const drawn = Array.from({ length: 80 }, (_, i) => {
    const a = (i / 76) * Math.PI * 2 - 2;
    const wobble = 1 + Math.sin(i * 0.45) * 0.035;
    return { x: cx + Math.cos(a) * rx * wobble, y: cy + Math.sin(a) * ry * wobble + i * 0.06 };
  });
  return { id, type: 'ink', ...strokeFromPoints(drawn, 0.6)!, ...extra };
}

/** A line through the given points, as one stroke. */
function stroke(id: string, points: [number, number][], extra: Loose = {}): Loose {
  const drawn: { x: number; y: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    for (let t = 0; t < 1; t += 0.1) drawn.push({ x: ax + (bx - ax) * t + Math.sin((i + t) * 5) * 0.8, y: ay + (by - ay) * t + Math.cos((i + t) * 4) * 0.8 });
  }
  drawn.push({ x: points[points.length - 1][0], y: points[points.length - 1][1] });
  return { id, type: 'ink', ...strokeFromPoints(drawn, 0.6)!, ...extra };
}

/** A rising curve with a fall at its end: tension over three acts. */
function tension(id: string, x: number, y: number, w: number, h: number, extra: Loose = {}): Loose {
  const drawn = Array.from({ length: 120 }, (_, i) => {
    const t = i / 119;
    const rise = t < 0.82 ? Math.pow(t / 0.82, 1.7) : 1 - Math.pow((t - 0.82) / 0.18, 1.3) * 0.7;
    return { x: x + t * w, y: y + h - rise * h + Math.sin(i * 0.9) * 1.2 };
  });
  return { id, type: 'ink', ...strokeFromPoints(drawn, 0.8)!, ...extra };
}

export function createMarksStore(): CanvasStore {
  const store = new CanvasStore(createDocument(MARKS_CANVAS_ID, 'Words, lines and curves'), { actor: PERSON });
  const objects: Loose[] = [
    // The name of the board, and what each part is called.
    { id: 'name', type: 'text', x: 0, y: -210, text: 'ferrite.', size: 'display', face: 'serif' },
    { id: 'name-line', ...stroke('name-line', [[4, -98], [150, -92], [318, -100]], { pen: 'fine', color: 'violet' }) },
    { id: 'sub', type: 'text', x: 4, y: -66, w: 700, h: 30, text: 'a sixteen-step field synthesizer: words, lines and curves', size: 'large' },

    { id: 'f-type', type: 'frame', x: 0, y: 0, w: 760, h: 520, title: 'Type' },
    { id: 't1', type: 'text', x: 32, y: 32, text: 'Sixteen steps', size: 'title' },
    { id: 't2', type: 'text', x: 32, y: 96, text: 'Sixteen steps', size: 'title', face: 'serif' },
    { id: 't3', type: 'text', x: 32, y: 160, text: 'STEP 01–16', size: 'title', face: 'mono' },
    { id: 't4', type: 'text', x: 32, y: 224, text: 'play it by hand', size: 'title', face: 'hand', color: 'violet' },
    { id: 't5', type: 'text', x: 32, y: 310, w: 320, h: 30, text: 'Large: 212 × 96 × 28 mm', size: 'large' },
    { id: 't6', type: 'text', x: 32, y: 352, w: 320, h: 24, text: 'Medium: eight knobs, sixteen keys.' },
    { id: 't7', type: 'text', x: 32, y: 384, w: 320, h: 20, text: 'Small: 412 g with the battery in.', size: 'small' },
    { id: 't8', type: 'text', x: 400, y: 310, w: 320, h: 30, text: 'Large, serif', size: 'large', face: 'serif' },
    { id: 't9', type: 'text', x: 400, y: 352, w: 320, h: 24, text: 'medium, mono: A5E1', face: 'mono' },
    { id: 't10', type: 'text', x: 400, y: 384, w: 320, h: 24, text: 'medium, by hand', face: 'hand' },
    { id: 't11', type: 'text', x: 32, y: 440, w: 500, h: 50, text: '緊急配送 16 шагов', size: 'title', color: { custom: '#22c55e' } },

    { id: 'f-colour', type: 'frame', x: 820, y: 0, w: 760, h: 520, title: 'Colour as chosen' },
    { id: 'n1', type: 'note', x: 852, y: 40, w: 150, h: 120, text: 'A note in the usual yellow' },
    { id: 'n2', type: 'note', x: 1022, y: 40, w: 150, h: 120, text: 'Named: violet', color: 'violet' },
    { id: 'n3', type: 'note', x: 1192, y: 40, w: 150, h: 120, text: 'Custom #ffd23f, exactly', color: { custom: '#ffd23f' } },
    { id: 'n4', type: 'note', x: 1362, y: 40, w: 150, h: 120, text: 'Custom #1d4ed8: light ink', color: { custom: '#1d4ed8' } },
    { id: 'n5', type: 'note', x: 852, y: 190, w: 150, h: 120, text: 'Custom #0f0d16, near black', color: { custom: '#0f0d16' } },
    { id: 'n6', type: 'note', x: 1022, y: 190, w: 150, h: 120, text: 'Custom, half see-through', color: { custom: 'rgb(34 197 94 / 0.5)' } },
    { id: 'b1', type: 'box', x: 1192, y: 190, w: 150, h: 56, text: 'Tint', color: 'green' },
    { id: 'b2', type: 'box', x: 1362, y: 190, w: 150, h: 56, text: 'Solid', color: 'green', style: { fill: 'solid' } },
    { id: 'b3', type: 'box', x: 1192, y: 262, w: 150, h: 56, text: 'None', color: 'green', style: { fill: 'none' } },
    { id: 'b4', type: 'box', x: 1362, y: 262, w: 150, h: 56, text: 'Dashed', color: 'green', style: { dash: true } },
    { id: 'b5', type: 'box', x: 852, y: 350, w: 150, h: 76, text: 'Blocked', detail: 'solid, custom', color: { custom: '#b45309' }, style: { fill: 'solid' } },
    { id: 'b6', type: 'box', x: 1022, y: 350, w: 150, h: 76, text: 'Solid, no colour', detail: 'the neutral line', style: { fill: 'solid' } },
    { id: 'b7', type: 'box', x: 1192, y: 350, w: 150, h: 76, text: 'Pale solid', detail: 'dark ink', color: { custom: '#fde68a' }, style: { fill: 'solid' } },
    { id: 'b8', type: 'box', x: 1362, y: 350, w: 150, h: 76, text: 'Decision', shape: 'pill', color: 'blue', style: { fill: 'solid' } },

    // Lines on the board itself: black and white ink both stay visible in both themes.
    { id: 'f-board', type: 'frame', x: 0, y: 600, w: 760, h: 420, title: 'Drawn on the board' },
    { id: 'tension', ...tension('tension', 40, 660, 680, 150, { color: 'violet' }) },
    { id: 'act1', type: 'text', x: 60, y: 830, w: 160, h: 26, text: 'act one', face: 'hand', size: 'large' },
    { id: 'act2', type: 'text', x: 300, y: 830, w: 160, h: 26, text: 'act two', face: 'hand', size: 'large' },
    { id: 'act3', type: 'text', x: 560, y: 830, w: 160, h: 26, text: 'act three', face: 'hand', size: 'large' },
    { id: 'black', ...stroke('black', [[40, 900], [240, 908], [360, 896]], { color: { custom: '#000000' } }) },
    { id: 'black-t', type: 'text', x: 40, y: 916, w: 330, h: 22, text: 'custom #000: seen on a dark board too', size: 'small' },
    { id: 'white', ...stroke('white', [[400, 900], [560, 892], [720, 904]], { color: { custom: '#ffffff' } }) },
    { id: 'white-t', type: 'text', x: 400, y: 916, w: 330, h: 22, text: 'custom #fff: seen on a light board too', size: 'small' },
    { id: 'hl', ...stroke('hl', [[40, 968], [330, 966]], { pen: 'highlighter', color: 'amber' }) },
    { id: 'hl-t', type: 'text', x: 44, y: 956, w: 300, h: 24, text: 'a highlighter over words' },
    { id: 'fine', ...ring('fine', 560, 968, 150, 26, { pen: 'fine' }) },
    { id: 'fine-t', type: 'text', x: 450, y: 956, w: 240, h: 24, text: 'a ring in a fine pen, no colour' },

    // The same marks over a pale picture and over a dark one. They are the same in both themes.
    { id: 'f-over', type: 'frame', x: 820, y: 600, w: 1160, h: 420, title: 'Drawn over a picture' },
    { id: 'pale', type: 'image', x: 850, y: 640, w: 530, h: 330, src: 'board/dash.svg', alt: 'A pale dashboard' },
    { id: 'dark', type: 'image', x: 1420, y: 640, w: 530, h: 330, src: 'board/term.svg', alt: 'A dark terminal' },
    ...(['pale', 'dark'] as const).flatMap((on, i) => {
      const x = 850 + i * 570;
      return [
        { id: `${on}-label`, type: 'text', x: x + 200, y: 690, w: 300, h: 26, text: 'no colour: ink by the picture', size: 'large' },
        { id: `${on}-named`, type: 'text', x: x + 200, y: 730, w: 300, h: 24, text: 'named violet, by the picture', color: 'violet' },
        { id: `${on}-custom`, type: 'text', x: x + 200, y: 760, w: 300, h: 24, text: 'custom #ffd23f, as chosen', color: { custom: '#ffd23f' } },
        { id: `${on}-hl`, ...stroke(`${on}-hl`, [[x + 196, 812], [x + 470, 810]], { pen: 'highlighter', color: { custom: '#ffd23f' } }) },
        { id: `${on}-ring`, ...ring(`${on}-ring`, x + 120, 880, 70, 40, { color: { custom: '#22c55e' } }) },
        { id: `${on}-plain`, ...ring(`${on}-plain`, x + 110, 720, 60, 34, { pen: 'fine' }) },
        { id: `${on}-leader`, type: 'arrow', from: { x: x + 420, y: 900 }, to: { x: x + 196, y: 884 }, label: 'here', routing: 'curve', style: { ends: 'dot' } },
      ];
    }),

    // HTML items set in the host's lent faces. With the crowd below, this board is past full detail at "fit":
    // the items must still be drawn.
    { id: 'f-html', type: 'frame', x: 2040, y: 600, w: 760, h: 420, title: 'HTML items in the house faces' },
    { id: 'h1', type: 'html', x: 2072, y: 640, w: 330, h: 150, alt: 'Sixteen steps, eight knobs', html: '<div style="font-family:\'Geist\',sans-serif;color:#ECE7DC;background:#0F0D16;height:150px;padding:16px;box-sizing:border-box"><div style="font:500 11px \'Paper Mono\',monospace;letter-spacing:.08em;color:#A79AEC">FS-16 / PANEL</div><div style="font-weight:800;font-size:52px;line-height:1;letter-spacing:-.03em;margin-top:14px">sixteen.</div><div style="font:400 12px \'Paper Mono\',monospace;margin-top:12px;color:#B4DA94">8 knobs · 212 × 96 × 28 mm · 412 g</div></div>' },
    { id: 'h2', type: 'html', x: 2434, y: 640, w: 330, h: 150, alt: 'Step grid, bar one', html: '<div style="font-family:\'Paper Mono\',monospace;color:#ECE7DC;background:#0F0D16;height:150px;padding:16px;box-sizing:border-box"><div style="font-size:11px;letter-spacing:.08em;color:#A79AEC">BAR 01</div><div style="display:grid;grid-template-columns:repeat(8,1fr);gap:6px;margin-top:14px">' + Array.from({ length: 16 }, (_, i) => `<div style="height:30px;border:1px solid #ECE7DC55;background:${[0, 3, 6, 10, 12].includes(i) ? '#ECE7DC' : 'transparent'}"></div>`).join('') + '</div></div>' },
    { id: 'h3', type: 'html', x: 2072, y: 822, w: 692, h: 160, alt: 'The device faces, for comparison', html: '<div style="color:#ECE7DC;background:#0F0D16;height:160px;padding:16px;box-sizing:border-box;font:14px system-ui,sans-serif"><div style="font-size:11px;letter-spacing:.08em;color:#A79AEC">NO FACE NAMED: THE DEVICE\'S OWN</div><div style="font-weight:800;font-size:52px;line-height:1;letter-spacing:-.03em;margin-top:14px">sixteen.</div><div style="font:400 12px ui-monospace,monospace;margin-top:12px;color:#B4DA94">8 knobs · 212 × 96 × 28 mm · 412 g</div></div>' },

    // Curves: a relationship map. A pair, one each way, part.
    { id: 'f-curve', type: 'frame', x: 1640, y: 0, w: 760, h: 520, title: 'Curved connectors' },
    { id: 'c1', type: 'box', x: 1700, y: 70, w: 150, h: 60, text: 'Keys', shape: 'pill' },
    { id: 'c2', type: 'box', x: 2180, y: 70, w: 150, h: 60, text: 'Sequencer' },
    { id: 'c3', type: 'box', x: 1700, y: 380, w: 150, h: 60, text: 'Knobs', shape: 'pill' },
    { id: 'c4', type: 'box', x: 2180, y: 380, w: 150, h: 60, text: 'Voice', color: 'violet' },
    { id: 'c5', type: 'box', x: 1950, y: 220, w: 130, h: 70, text: 'Clock', shape: 'decision' },
    { id: 'k1', type: 'arrow', from: { object: 'c1' }, to: { object: 'c2' }, routing: 'curve', label: 'steps' },
    { id: 'k2', type: 'arrow', from: { object: 'c2' }, to: { object: 'c1' }, routing: 'curve', label: 'lights', style: { dash: true } },
    { id: 'k3', type: 'arrow', from: { object: 'c3' }, to: { object: 'c4' }, routing: 'curve', label: 'shape', color: 'violet' },
    { id: 'k4', type: 'arrow', from: { object: 'c2' }, to: { object: 'c4' }, routing: 'curve', label: 'notes' },
    { id: 'k5', type: 'arrow', from: { object: 'c5' }, to: { object: 'c2' }, routing: 'curve' },
    { id: 'k6', type: 'arrow', from: { object: 'c5' }, to: { object: 'c4' }, routing: 'curve', style: { look: 'sketch' }, label: 'proposed' },
    { id: 'k7', type: 'arrow', from: { object: 'c1' }, to: { object: 'c3' }, routing: 'curve', color: { custom: '#22c55e' }, style: { ends: 'none' } },

    // A crowd: with it the whole board holds more than 150 objects.
    { id: 'f-crowd', type: 'frame', x: 0, y: 1100, w: 2400, h: 560, title: 'A wall of 168 swatches' },
    { id: 'crowd-name', type: 'text', x: 32, y: 1124, text: 'every euclidean rhythm of 16', size: 'title', face: 'mono' },
    ...Array.from({ length: 168 }, (_, i) => {
      const hue = (i * 37) % 360;
      return { id: `sw${i}`, type: 'box', x: 32 + (i % 28) * 84, y: 1210 + Math.floor(i / 28) * 72, w: 72, h: 56, text: String(i + 1).padStart(2, '0'), color: { custom: `oklch(0.7 0.12 ${hue})` }, style: { fill: 'solid' } };
    }),
  ];
  const added = store.dispatch({ type: 'add', objects: objects as unknown as CanvasObject[] });
  if (!added.ok) throw new Error(added.error);
  store.dispatch({ type: 'add-snapshot', snapshot: { id: 'over', title: 'Drawn over a picture', source: { kind: 'frame', frame: 'f-over' } } });
  store.dispatch({ type: 'add-snapshot', snapshot: { id: 'curves', title: 'Curved connectors', source: { kind: 'frame', frame: 'f-curve' } } });
  return new CanvasStore(store.getDocument(), { actor: PERSON });
}

const block = (snapshot: string) => serializeSnapshotBlock({ canvas: MARKS_CANVAS_ID, snapshot });
export const MARKS_PLAN = `# Words, lines and curves\n\nMarks over a pale and a dark picture.\n\n${block('over')}\n\nA relationship map.\n\n${block('curves')}\n`;
