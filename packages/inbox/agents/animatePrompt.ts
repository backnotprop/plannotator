/**
 * "Animate it": the words of the message the person sends an agent (AnimateIt.tsx), the one place they live so they
 * can be tuned. The picture travels as the message's attachment; the request id ties the hand-back
 * (`plannotator inbox icon set`, apps/hook/server/inbox-icon-command.ts) to this one icon.
 *
 * Tested clean room: a fresh agent given only this text and the picture, in a scratch folder, against a sandboxed
 * Inbox (briefs, not this repo). Smooth pictures are never redrawn: an agent that traced a smooth fox lost its look,
 * and one that kept the picture and moved cut-outs of it kept it.
 */

/** The new thread's name. */
export const ANIMATE_THREAD_NAME = 'Animate an agent icon';

export function animatePrompt(requestId: string): string {
  return `Please animate the picture attached to this message. It is the icon of one of my agents in my Plannotator Inbox.

Make one animated SVG of it that is clearly alive: a little character you can see moving at a glance, with personality, like an idle animation in a game. Lively, but not frantic, and never in sync with itself.

First look at the picture and decide which kind it is:
- Pixel art (hard square pixels, a small palette, usually a small image): follow "Pixel art" below.
- Anything else (a smooth illustration, an emoji, a 3D render, a photo, a logo): follow "Smooth pictures" below.

Pixel art
1. Keep the picture: same pixels, same colours. Rebuild it as crisp rectangles or embed it unchanged as a data: URL with image-rendering="pixelated".
2. Split it into a few parts that could move on their own (a body, a head, ears, eyes, a tail: 2 to 8 parts), each in its own <g>.
3. Move parts in whole source pixels (translate by 1 or 2 pixels, held with steps() timing), never by fractions or rotations, which smear and tear pixel art. Keep shape-rendering="crispEdges".
4. No gaps: where a moving part joins the body, let the part overlap the body by a pixel or two, or leave a copy of the joining pixels underneath, so nothing opens up behind it.

Smooth pictures: never redraw them
1. Do not trace, redraw or restyle the picture: a redrawn copy loses its shading and its look. Embed the original picture unchanged, once, as an <image> with a data: URL inside <defs>, and draw it with <use>.
2. Move the whole picture: the idle bob, a squash and stretch, a small tilt, a hop, a little shake.
3. On top of that, at most three cut-out parts that move on their own (an ear, the head, a tail). A cut-out is another <use> of the same image, clipped with a <clipPath> to that part. Cut the same part out of the base copy with a <mask>, so the part is never shown twice. Let the cut-out reach well into the body at its root, so no gap or notch opens where it joins at any point of its move.
4. A blink may be a small lid drawn over each eye: filled with a colour picked from the picture next to the eye, with a thin dark curve across it so the eye reads as closed, not gone. Show it only for the moment of the blink. Draw nothing else new.

For both kinds
5. Animate with CSS @keyframes in one <style> inside the SVG. Only transform (translate, rotate, scale) and opacity. Give each moving <g> or <use> a transform-origin where it would hinge (a body at its feet, an ear at its root), written in viewBox units (for example transform-origin: 20px 30px).
6. An idle loop for the whole character that never stops: a bob or bounce you can see, 1.2 to 2.5 s per cycle. Then a loop for each part with a different length (for example 1.7 s, 2.3 s, 3.1 s) so the whole never lines up the same way twice.
7. Visible at the size it is shown. The icon is drawn at 24 px (sometimes 16 px), so judge every move at that size, not in your viewBox: the idle bob travels 1 to 2 screen pixels at 24 px (in a 64-unit viewBox that is 3 to 5 units), parts turn 8 to 20 degrees or shift 1 to 2 screen pixels, a squash or stretch of 6 to 10 percent. Someone glancing at the sidebar should see it move within a second. It should still be pleasant at the edge of your eye all day: no flashing, no spinning, nothing faster than about 3 moves a second.
8. Gestures with character, often: a blink every 2 to 4 s if it has eyes, and every 3 to 6 s something that suits this character (an ear flick, a hop, a wave, a look to the side, a little shake). Give each its own loop length.
9. The first frame is the rest pose: with every animation off, the SVG must show the picture exactly as it is.
10. Do not make it lean toward the pointer or react to hover: the Inbox moves the whole icon toward the pointer itself, and a picture shown as an image never sees the pointer.

Rules the file must meet (the Inbox shows it as an image, which blocks anything else)
- One .svg file, square viewBox (0 0 64 64 is good).
- No <script>, no event attributes (onload, onclick), no <foreignObject>, no links or files from outside (no http, no @import, no web fonts). Pictures inside must be data: URLs.
- CSS animations only (no SMIL <animate>, no JavaScript).
- At most 512 KB; the Inbox refuses anything larger.
- It must read at 16 px and 24 px, on a light and a dark background.

Check it before you hand it back
- Watch it move, do not just look at the still. If you have a headless browser, freeze it at six or more moments (add \`* { animation-play-state: paused !important; animation-delay: -2s !important }\` to the style, with -2s, -4s, -6s and the exact moments of each gesture such as the middle of the blink) and render each as <img src="icon.svg" width="24"> and at 96 px, on a white and on a dark (#151a24) background. Compare the frames with the original picture: it still looks like the same picture; at 24 px you can see that something moved; each gesture shows at its moment; no part shows twice and no gap opens anywhere.
- Turn the animations off (add * { animation: none !important }): it shows the picture, unchanged.
- Search the file for "<script", " on" attributes, "http" (other than the xmlns namespace), "foreignObject", "@import": none of them.

Hand it back
- Run: plannotator inbox icon set <your file.svg> --request ${requestId}
  It becomes the icon in my Inbox at once, and I can go back to the original with one click. If you improve it later, run it again.
- If that command is not found, tell me where the file is instead.
- Then tell me in one line what moves and how.`;
}
