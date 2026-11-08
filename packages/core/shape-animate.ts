/**
 * Shape's animation text (approval "shape-animated-scenes", 2026-11-07): the owner's
 * approved words, byte for byte. Never edit them here alone.
 *
 *   - `SHAPE_PICTURE_LOOK`: "the Picture is the system itself" (not a dashboard) and the
 *     art direction. The main guide (`SHAPE_GUIDE`, ./shape-skill.ts) carries them at the end
 *     of its stance, so a still board gets them too, and the animate help repeats them.
 *   - `SHAPE_ANIMATIONS_SECTION`: the "## Animations" section at the end of `SHAPE_GUIDE`:
 *     when to animate, and the pointer to the topic below.
 *   - `SHAPE_ANIMATE_HELP`: `plannotator shape --help animate` (also `shape animate`), what an
 *     agent reads once it has decided to animate: the person's brief, the look, and the scene
 *     format (`checkShapeScene` in ./shape-scene.ts; `shape-animate.test.ts` stores its example).
 *
 * Browser-safe, no dependencies.
 */

const BRIEF = `Use the Shape board to help me understand what we're discussing. Show me with big pictures and little words without withholding key details. Use your own taste, avoid lazy design, integrate real-world pictures/icons/visuals as needed but only selectively when it makes sense. When you do use prose/detail: Be clear, concise/terse, and avoid jargon. Explain things as if the viewer is new here, but don't use weird metaphors.`;

const TOTALS = `Data that is only totals stays a still picture unless there is real timing to show.`;

export const SHAPE_PICTURE_LOOK = `The Picture is the system itself: its parts, the paths work takes between them, and the places where work piles up, waits or is lost, drawn the way an engineer would draw it for a colleague. A board is not a dashboard. Panels of totals, rows of bars and big numbers in boxes describe a system from the outside; they don't show how it works. If your picture reads like a monitoring page, redraw it as the machine, with the few numbers that matter written on the parts they describe.

Go for the look of an elegant technical drawing, a precise engineering diagram you'd want to frame. Thin, sure lines; one quiet system of type used the same way everywhere; a muted palette where colour shows up only where it means something. Nothing bubbly, cute or decorative: if a part looks like an app widget, draw it plainer.`;

export const SHAPE_ANIMATIONS_SECTION = `## Animations

When the point is the order things happen in, what causes what, how long things take, or how a state changes over time, you can make a drawing move: the person plays it, drags through time, steps from moment to moment and changes the speed. If a still picture already says it, keep it still. ${TOTALS}

Once you decide to animate, run \`plannotator shape --help animate\` before you draw anything.
`;

export const SHAPE_ANIMATE_HELP = `${BRIEF}

${SHAPE_PICTURE_LOOK}

${TOTALS}

## The format

A scene is two halves. **The drawing:** your own SVG, in the Picture or How it works, inside \`<div data-scene="id">…</div>\`. Put \`data-part="name"\` on each piece that moves or changes (a \`<g>\` is fine). **The motion:** \`scenes.<id>\` on the board, keyframes for those pieces. The player draws its caption and controls under your drawing, so leave the view's \`width\` and \`height\` off.

\`\`\`json
{
  "title": "The lamp",
  "claim": "The ball turns the lamp on when it arrives.",
  "views": { "picture": { "html": "<div data-scene=\\"demo\\"><svg viewBox=\\"0 0 400 120\\" width=\\"100%\\"><path data-part=\\"road\\" d=\\"M20 60 H380\\" stroke=\\"var(--rule)\\" stroke-width=\\"1\\" fill=\\"none\\"/><circle data-part=\\"ball\\" cx=\\"20\\" cy=\\"60\\" r=\\"8\\" fill=\\"currentColor\\" style=\\"color:var(--mark)\\"/><g data-part=\\"lamp\\" style=\\"color:var(--grey)\\"><rect x=\\"360\\" y=\\"20\\" width=\\"30\\" height=\\"30\\" rx=\\"2\\" fill=\\"currentColor\\"/><text x=\\"375\\" y=\\"70\\" text-anchor=\\"middle\\">off</text></g></svg></div>" } },
  "scenes": { "demo": {
    "scene": 1, "title": "The ball reaches the lamp and turns it on", "source": "scenario, written from lamp.go",
    "unit": "ms", "end": 10,
    "beats": [{ "at": 0, "say": "The ball sets off." }, { "at": 8, "say": "It reaches the lamp, so the lamp turns on." }],
    "legend": [{ "color": "green", "label": "on" }],
    "tracks": {
      "ball": [{ "at": 0, "along": "road", "p": 0 }, { "at": 8, "along": "road", "p": 1, "ease": "linear" }],
      "lamp": [{ "at": 0, "color": "grey", "text": "off" }, { "at": 8, "color": "green", "text": "on", "lit": true }]
    }
  } }
}
\`\`\`

- **scene:** \`scene: 1\` (the format's version, the same for every scene), \`title\` (at most 120 characters), \`end\` (the length of the timeline), \`beats\` and \`tracks\` are required. \`unit\` is the clock of every \`at\` and of \`end\`: \`step\` (the default), or \`ms\`, \`s\`, \`µs\` or \`ns\` when timing is the point. \`source\` is one short line, at most 200 characters. \`seconds\` (optional) is how long the whole scene plays at 1× (by default 1.2 s a step, or 10 s for a clock). \`code\` (optional) is \`{ lang, lines }\`, the lines the person follows, at most 60; a beat's \`line\` lights one, counting from 1. \`legend\` (optional) is up to 8 \`{ color, label }\`.
- **beats:** \`{ at, say, line? }\` in time order, one per moment; a \`say\` is at most 180 characters. The caption shows the latest beat; Back and Next jump between beats. With reduced motion on, the person sees only the beats, one at a time, so each \`say\` must make sense on its own.
- **tracks:** \`{ "<data-part>": [keyframes in time order] }\`, at most 160 pieces a scene, 200 keyframes a piece and 3,000 a scene. Draw each piece where it starts. A piece may hold other pieces, which move with it; give places to the outer piece or to the inner ones, not both. A keyframe is \`{ at, … }\` with any of:
  - a place, one of: \`x\`, \`y\` (where the piece's centre goes, in the SVG's viewBox coordinates; a missing one keeps its last value), \`to\` (centre it on another piece), or \`along\` + \`p\` (on a piece that is or holds a path, line, polyline, polygon, circle, ellipse or rect, \`p\` from 0 at its start to 1 at its end). Two keys on the same \`along\` move along it; otherwise the piece moves in a straight line.
  - a look: \`color\` (a board colour; it sets the piece's \`currentColor\`, so paint what should change with \`fill="currentColor"\` or \`stroke="currentColor"\`), \`opacity\` (0 to 1), \`scale\` and \`rotate\` (degrees; both about its centre), \`scaleX\` and \`scaleY\` (its width or its height alone, also about its centre), \`text\` (new words for the piece, or for the first \`<text>\` inside it; the words change at the key), \`draw\` (how much of its lines are drawn, 0 to 1), \`lit\` (true: picked out in the accent colour; false: off again).
  - \`ease\`: how everything this key sets gets there from the key before: \`smooth\` (the default), \`linear\`, or \`jump\` (it holds, then jumps at \`at\`). Two keys may share an \`at\`.
- Each property moves from one key that sets it to the next, then holds after the last. Before the first key that sets a property, the piece shows that key's value (each property on its own).
- Colours: \`ink\`, \`ink2\`, \`grey\`, \`rule\`, \`paper\`, \`surface\`, \`sunk\`, \`mark\`, \`alert\`, \`blue\`, \`amber\`, \`green\`, \`plum\`, and each of the last six with \`-soft\`.
- Don't put \`data-step\` on the pieces of a scene.
- \`shape update\` refuses a scene it can't play and names the field. Fix that field and update again.
- To check your work, run \`plannotator shape frame <id> --at end\` and look at the picture; fix crowded or tiny text.`;

/** True for `shape animate`, `shape animate --help` and `shape --help animate` (argv after `shape`). */
export function isShapeAnimateHelp(argv: readonly string[]): boolean {
  const words = argv.filter((a) => a !== '--help' && a !== '-h' && a !== 'help');
  return words.length === 1 && words[0] === 'animate';
}
