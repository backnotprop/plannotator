// A whiteboard of a real feature, drawn with the Shape kit as an agent would: adding a search engine to a browser.
// Invented project; each engine a plain letter tile (make-logos.mjs), no engine's mark. The fixture for inbox-shape-box.spec.ts; written again with
// `node tests/e2e/fixtures/shape-search-board/make-board.mjs "$PWD" tests/e2e/fixtures/shape-search-board`.
const [repo, out] = process.argv.slice(2);
const { box, text, part, pin, svg, board, dots, card, sticky, tag, pic, arrow, line } = await import(`${repo}/packages/core/shape-kit.mjs`);

const W = 1200, H = 720;
const engine = (id, y, logo, name, short, extra = '') =>
  part(`row-${id}`, 3, pic(72, y + 14, 36, 36, `${logo}.png`, { r: 8, alt: name }), text(126, y + 41, name, { size: 24 }), text(360, y + 41, short, { size: 21, mono: true, tone: 'soft' }), extra);
const rows =
  engine('google', 118, 'google', 'Google', '@google', tag(470, y0(118), 'Default', { size: 17 })) +
  line([[64, 186], [576, 186]], { tone: 'soft' }) +
  engine('ddg', 192, 'ddg', 'DuckDuckGo', '@ddg') +
  line([[64, 260], [576, 260]], { tone: 'soft' }) +
  engine('bing', 266, 'bing', 'Bing', '@bing') +
  line([[64, 334], [576, 334]], { tone: 'soft' }) +
  engine('kagi', 340, 'kagi', 'Kagi', '@kagi', tag(470, y0(340), 'New', { size: 17, dash: true }));
function y0(y) { return y + 18; }

const picture =
  dots(W, H) +
  part('engines', 1,
    card(40, 40, 560, 440),
    text(72, 92, 'Search engines', { size: 28, weight: 650 }),
    rows,
    part('add-btn', 4, box(64, 412, 250, 46, { tone: 'accent', r: 10 }), text(189, 443, '+ Add search engine', { size: 20, weight: 600, tone: 'accent', anchor: 'middle' }))) +
  pin(1, 600, 40) +
  part('form', 5,
    card(660, 40, 500, 304),
    text(690, 90, 'Add search engine', { size: 26, weight: 650 }),
    part('f-name', 6, text(690, 134, 'Name', { size: 17, tone: 'soft' }), box(690, 144, 440, 40, { tone: 'soft', r: 8 }), text(706, 171, 'Kagi', { size: 20 })),
    part('f-short', 6, text(690, 208, 'Shortcut', { size: 17, tone: 'soft' }), box(690, 218, 200, 40, { tone: 'soft', r: 8 }), text(706, 245, '@kagi', { size: 20, mono: true }))) +
  `<g data-mark="f-url" data-step="7" data-code="src/search/template.ts#L8">${text(910, 208, 'URL', { size: 17, tone: 'soft' })}${box(910, 218, 220, 40, { tone: 'accent', r: 8 })}${text(924, 245, '…/search?q=%s', { size: 19, mono: true, tone: 'accent' })}</g>` +
  part('save', 8, box(1030, 284, 100, 40, { r: 10 }), text(1080, 310, 'Save', { size: 19, weight: 600, anchor: 'middle' })) +
  pin(2, 1160, 40) +
  part('sticky', 9, sticky(760, 380, 300, 132, ['Any URL works: put', '%s where your', 'words go'], { size: 22 })) +
  part('omnibox', 10,
    card(40, 560, 700, 64, { r: 32 }),
    text(80, 601, '@kagi', { size: 23, mono: true, tone: 'accent' }),
    text(160, 601, 'rust lifetimes', { size: 23 }),
    line([[330, 578], [330, 606]], { tone: 'accent' })) +
  arrow([[750, 592], [830, 592]], { tone: 'soft' }) +
  `<g data-mark="result" data-step="11" data-code="src/search/omnibox.ts#L40">${card(840, 560, 320, 64, { r: 14 })}${pic(858, 574, 36, 36, 'kagi.png', { r: 8, alt: 'Kagi' })}${text(906, 600, 'kagi.com/search?q=rust+…', { size: 18, mono: true })}</g>` +
  pin(3, 1160, 560);

const how =
  dots(W, 560) +
  part('h-type', 1, card(40, 220, 230, 110), text(155, 268, 'You type in the', { size: 21, anchor: 'middle' }), text(155, 298, 'address bar', { size: 21, anchor: 'middle', weight: 650 })) +
  arrow([[270, 275], [350, 275]]) +
  part('h-check', 2, box(350, 210, 260, 130, { tone: 'accent', r: 18 }), text(480, 262, 'Starts with a', { size: 21, anchor: 'middle', tone: 'accent' }), text(480, 292, 'shortcut?', { size: 23, anchor: 'middle', weight: 650, tone: 'accent' })) +
  arrow([[610, 250], [700, 150]]) + text(640, 180, 'yes', { size: 18, tone: 'soft' }) +
  arrow([[610, 300], [700, 400]]) + text(640, 385, 'no', { size: 18, tone: 'soft' }) +
  `<g data-mark="h-fill" data-step="3" data-code="src/search/template.ts#L8">${card(700, 90, 230, 110)}${text(815, 138, 'Put your words', { size: 21, anchor: 'middle' })}${text(815, 168, 'where %s is', { size: 21, anchor: 'middle', weight: 650 })}</g>` +
  arrow([[930, 145], [990, 145]]) +
  part('h-open', 4, card(990, 90, 180, 110), pic(1056, 108, 48, 48, 'kagi.png', { r: 10, alt: 'Kagi' }), text(1080, 184, 'That engine', { size: 19, anchor: 'middle' })) +
  part('h-default', 5, card(700, 350, 470, 110), pic(724, 380, 48, 48, 'google.png', { r: 10, alt: 'Google' }), text(790, 398, 'The default engine', { size: 21, weight: 650 }), text(790, 428, 'Google, until you pick another', { size: 19, tone: 'soft' }));

board({
  out: `${out}/board.json`,
  title: 'Add your own search engine',
  claim: 'Built behind the Search setting. You add a name, a shortcut and a URL; typing the shortcut first searches that engine.',
  picture: svg(W, H, picture),
  how: svg(W, 560, how),
  know: 'Adding an engine takes a name, a shortcut and a URL with %s where your words go. Save stays off until the URL has one. [^2]\n\nTyping the shortcut first in the address bar searches that engine; anything else goes to the default, Google. [^3]',
  refs: [
    { n: 1, kind: 'file', title: 'The engine list', sub: 'Four built in; yours are added after them.', target: 'src/search/engines.ts', line: 12 },
    { n: 2, kind: 'file', title: 'The URL check', sub: 'Save waits for a %s in the URL.', target: 'src/search/template.ts', line: 8 },
    { n: 3, kind: 'file', title: 'Shortcut lookup', sub: 'The first word, if it starts with @.', target: 'src/search/omnibox.ts', line: 40 },
  ],
});
console.log('board written');
