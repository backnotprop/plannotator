/**
 * Decision mode's card with the agent contract lines (approval
 * "inbox-decision-mode", "Agent contract lines", 2026-10-24; drawn as
 * contract-compare.html has them): the Stakes line, a Shows picture leading,
 * the Why line, picture choices as the thread card's own tiles, and a
 * `Reversible: no` question's One-way badge and confirm step.
 *
 * What regresses if this fails: a picture choice's picture no longer answers
 * (or a zoom answers, or a pick opens the viewer), a one-way pick counts
 * without its confirm (whichever choice the agent recommended: the grammar
 * does not say which one is one-way), a Skip asks, Escape answers instead of
 * cancelling, a one-way or picture question swipes, or Stakes /
 * Why / Shows stop showing.
 *
 * DOM-gated (DOM_TESTS=1, happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxDecision, InboxQuestion } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';

const hasDom = typeof document !== 'undefined';
const { DecisionCard, cardPictures, sentence, showsFile } = (hasDom ? await import('./decisions/DecisionCard') : {}) as typeof import('./decisions/DecisionCard');

function question(extra: Partial<InboxQuestion>): InboxQuestion {
  return {
    key: 'q-1',
    position: 0,
    kind: 'single',
    prompt: 'Which checkout drawer should ship?',
    context: null,
    choices: [],
    recommendation: null,
    suggested_text: null,
    stopped: null,
    holds_up: [],
    asked_by_agent_id: null,
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: 'msg_01',
    superseded_by: null,
    ...extra,
  };
}

function decision(q: InboxQuestion, pictures: InboxDecision['pictures'] = { inline: [], attachments: [] }): InboxDecision {
  return {
    id: `msg_01/${q.key}`,
    question: q,
    message: { id: 'msg_01', created_at: '2026-10-24T10:02:00.000Z', author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null }, excerpt: null },
    pictures,
    thread: { id: 'msg_01', subject: 'Checkout drawer for 4.2', thread_name: null, project: { id: 'prj_1', name: 'web' }, section: 'holding' },
    session: { key: 's:claude-code\u0000ses_a', host: 'claude-code', session: 'ses_a', name: null, wakes: true },
  };
}

const DRAWERS = question({
  // As an agent writes them (after the label, lower case): the card draws each as a sentence.
  stakes: 'ships to all of checkout on Thursday; changing it later costs a week of QA.',
  why: 'on a 320 px screen only B keeps the total next to the button.',
  holds_up: ['the 4.2 release'],
  choices: [
    { label: 'A · Total on top', description: 'closest to today', recommended: false, settled: false, image: { alt: 'Drawer A', src: 'drawer-a.png' } },
    { label: 'B · Total pinned with Pay', description: 'The total never scrolls away', recommended: true, settled: false, image: { alt: 'Drawer B', src: 'drawer-b.png' } },
    { label: 'C · Three steps', description: 'Most room, one more tap', recommended: false, settled: false, image: { alt: 'Drawer C', src: 'drawer-c.png' } },
  ],
  recommendation: 'B · Total pinned with Pay',
});
const DRAWER_PICTURES: InboxDecision['pictures'] = {
  inline: ['a', 'b', 'c'].map((x) => ({ attachment_id: `att_${x}`, ref: `drawer-${x}.png`, name: `drawer-${x}.png`, media_type: 'image/png', width: 240, height: 360 })),
  attachments: [],
};

const INVOICES = question({
  key: 'q-2',
  prompt: 'Delete the 3 duplicate invoices in the legacy billing system now?',
  stakes: 'They inflate this month’s revenue report by €1,840 until they’re gone.',
  reversible: { value: false, why: 'deleted invoices cannot be restored.' },
  choices: [
    { label: 'Delete now', description: 'The report is right today', recommended: false, settled: false },
    { label: 'Wait for month-end close', description: 'Finance deletes them with the close', recommended: true, settled: false },
  ],
  recommendation: 'Wait for month-end close',
});

// happy-dom fetches an <img>'s URL and fires `error` when nothing answers (the card then draws text rows):
// a loopback server answers every image path with a 1x1 GIF, and the page's URL points at it.
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), (c) => c.charCodeAt(0));
let images: ReturnType<typeof Bun.serve> | null = null;
let savedUrl = '';
beforeAll(() => {
  if (!hasDom) return;
  images = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(GIF, { headers: { 'Content-Type': 'image/gif' } }) });
  savedUrl = window.location.href;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${images.port}/`);
});
afterAll(() => {
  if (!hasDom) return;
  if (savedUrl) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(savedUrl);
  images?.stop(true);
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

interface Seen {
  answers: QuestionAnswer[];
  images: { names: string[]; index: number }[];
  field: { current: (() => boolean) | null };
}

function render(d: InboxDecision, opts: { touch?: boolean } = {}): Seen {
  const seen: Seen = { answers: [], images: [], field: { current: null } };
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <DecisionCard
        decision={d}
        stamp={null}
        phone={false}
        touch={opts.touch ?? false}
        onAnswer={(answer) => seen.answers.push(answer)}
        onAction={() => {}}
        onLater={() => {}}
        onOpenThread={() => {}}
        onImage={(pictures, index) => seen.images.push({ names: pictures.map((p) => p.name), index })}
        fieldOpenRef={seen.field}
      />,
    ),
  );
  return seen;
}

const $ = <T extends Element = HTMLElement>(sel: string) => host!.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string) => [...host!.querySelectorAll<T>(sel)];
/** A click as a pointer makes it: the press (the card answers a click, never an arrow key), then the click. */
function press(el: Element) {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    (el as HTMLElement).click();
  });
}

describe.skipIf(!hasDom)('decision mode: refs link into the thread repo', () => {
  const REFS = question({
    key: 'q-refs',
    prompt: 'Ship team/app#12 before #3?',
    stakes: 'acme/web#9 waits on it.',
    choices: [
      { label: 'Yes, ship team/app#12', description: 'Then close #3', recommended: false, settled: false },
      { label: 'No', description: null, recommended: false, settled: false },
    ],
  });
  const withRepo = (repo: { display: string; host: string | null } | null): InboxDecision => {
    const d = decision(REFS);
    return { ...d, thread: { ...d.thread, project: { ...d.thread.project, repo } } };
  };
  const hrefs = () => $$<HTMLAnchorElement>('a[href]').map((a) => a.getAttribute('href'));

  test('a GitLab project links refs on its own host, never on github.com', () => {
    render(withRepo({ display: 'group/web', host: 'gitlab.example.com' }));
    const links = hrefs();
    expect(links).toContain('https://gitlab.example.com/team/app/-/issues/12');
    expect(links).toContain('https://gitlab.example.com/group/web/-/issues/3');
    expect(links).toContain('https://gitlab.example.com/acme/web/-/issues/9');
    expect(links.some((h) => h?.includes('github.com'))).toBe(false);
  });

  test('without the thread repo, refs stay plain text', () => {
    render(withRepo(null));
    expect(hrefs().filter((h) => h?.includes('/issues/'))).toEqual([]);
    expect($('[data-decision-prompt]')!.textContent).toBe('Ship team/app#12 before #3?');
  });
});

describe.skipIf(!hasDom)('decision mode: the contract lines', () => {
  test('Stakes under the prompt, Why under the answers, the tiles as the thread card draws them', () => {
    render(decision(DRAWERS, DRAWER_PICTURES));
    const stakes = $('[data-decision-stakes]')!;
    expect(stakes.textContent).toContain('Ships to all of checkout on Thursday');
    expect($('[data-decision-card]')!.getAttribute('aria-describedby')).toBe(stakes.id);
    expect($('[data-decision-why]')!.textContent).toBe('Why Claude Code recommends it: On a 320 px screen only B keeps the total next to the button.');
    // ui's QuestionPictureTiles, one tile per choice, the captured image as each picture.
    const tiles = $$('[data-decision-tiles] [data-question-tile]');
    expect(tiles).toHaveLength(3);
    expect($$<HTMLImageElement>('[data-question-picture]').map((img) => img.getAttribute('src'))).toEqual([
      '/api/inbox/attachments/att_a/image',
      '/api/inbox/attachments/att_b/image',
      '/api/inbox/attachments/att_c/image',
    ]);
    expect(tiles[1]!.textContent).toContain('Recommended');
    // The answer is the label as written; a description is drawn as a sentence.
    expect(tiles[0]!.querySelector('[data-question-tile-description]')!.textContent).toBe('Closest to today');
    // The choice pictures are their tiles, never the hero on the left.
    expect($('[data-decision-pictures]')).toBeNull();
    // Real radios, so the keyboard reaches each tile.
    expect($$<HTMLInputElement>('[data-question-tile] input[type="radio"]')).toHaveLength(3);
  });

  test('a click on a tile’s picture answers with its label and never opens the viewer; its zoom opens the viewer and never answers', () => {
    const seen = render(decision(DRAWERS, DRAWER_PICTURES));
    press($$('[data-question-zoom]')[2]!);
    expect(seen.answers).toHaveLength(0);
    expect(seen.images).toEqual([{ names: ['Drawer A', 'Drawer B', 'Drawer C'], index: 2 }]);
    press($$('[data-question-picture]')[1]!);
    expect(seen.images).toHaveLength(1);
    expect(seen.answers.map((a) => a.selected)).toEqual([['B · Total pinned with Pay']]);
  });

  test('a tile answers from the keyboard too: the arrows only move, Enter answers', () => {
    const seen = render(decision(DRAWERS, DRAWER_PICTURES));
    const radio = $$<HTMLInputElement>('[data-question-tile] input')[0]!;
    act(() => radio.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(seen.answers.map((a) => a.selected)).toEqual([['A · Total on top']]);
  });

  test('every picture failing draws the ordinary rows', () => {
    render(decision(DRAWERS, DRAWER_PICTURES));
    for (const img of $$<HTMLImageElement>('[data-question-picture]')) act(() => img.dispatchEvent(new Event('error')));
    expect($('[data-decision-tiles]')).toBeNull();
    expect($$('.ib-dm-choice')).toHaveLength(3);
  });

  test('a Shows picture leads on the left; a Shows file is a reference', () => {
    const shows = question({ shows: { kind: 'image', label: 'Docs nav today and proposed', src: 'nav.png' }, choices: [{ label: 'Yes', description: null, recommended: true, settled: false }, { label: 'No', description: null, recommended: false, settled: false }] });
    const pictures: InboxDecision['pictures'] = {
      inline: [
        { attachment_id: 'att_other', ref: 'other.png', name: 'other.png', media_type: 'image/png', width: 10, height: 10 },
        { attachment_id: 'att_nav', ref: 'nav.png', name: 'nav.png', media_type: 'image/png', width: 10, height: 10 },
      ],
      attachments: [],
    };
    expect(cardPictures(decision(shows, pictures)).map((p) => p.name)).toEqual(['Docs nav today and proposed', 'other.png']);
    render(decision(shows, pictures));
    expect($<HTMLImageElement>('.ib-dm-hero img')!.getAttribute('src')).toBe('/api/inbox/attachments/att_nav/image');
    act(() => root!.unmount());
    host!.remove();
    const file = question({ shows: { kind: 'link', label: 'the nav plan', src: 'docs/docs-nav-plan.md' } });
    render(decision(file, { inline: [], attachments: [{ attachment_id: 'att_plan', name: 'docs-nav-plan.md', kind: 'markdown', size: 400, media_type: null }] }));
    const ref = $('[data-decision-shows]')!;
    expect(ref.textContent).toBe('the nav plan');
    // The attached file it names leads, and is not listed twice.
    expect($$('.ib-dm-refs .ib-dm-file')).toHaveLength(1);
  });

  test('Reversible: no: the One-way badge, no tag on any one choice, no swipe', () => {
    render(decision(INVOICES), { touch: true });
    expect($('[data-decision-one-way]')!.textContent).toContain('One-way');
    // The grammar does not say which choice is one-way, so no choice is marked as the one.
    expect($('[data-decision-irreversible]')).toBeNull();
    // A two-way choice on a touch screen would offer a swipe; a one-way one never does.
    expect($('.ib-dm-swipehint')).toBeNull();
  });

  test('a one-way pick asks once more before it counts; Cancel answers nothing; the safe recommended choice asks too', () => {
    const seen = render(decision(INVOICES));
    press($$('.ib-dm-choice input')[0]!);
    expect(seen.answers).toHaveLength(0);
    const box = $('[data-decision-confirm-pick]')!;
    expect(box.getAttribute('role')).toBe('alertdialog');
    expect(box.textContent).toContain('Delete now?');
    expect(box.textContent).toContain("Delete now? Can't be undone: deleted invoices cannot be restored.");
    // One way to answer at a time: no Answer button beside the step.
    expect($('[data-decision-answer]')).toBeNull();
    // The safe button holds focus: Enter there cancels, never deletes.
    expect(document.activeElement).toBe($('[data-decision-confirm-cancel]'));
    press($('[data-decision-confirm-cancel]')!);
    expect($('[data-decision-confirm-pick]')).toBeNull();
    expect(seen.answers).toHaveLength(0);
    expect($$<HTMLInputElement>('.ib-dm-choice input')[0]!.checked).toBe(false);
    // The safe choice is recommended, and it asks too.
    press($$('.ib-dm-choice input')[1]!);
    expect(seen.answers).toHaveLength(0);
    expect($('[data-decision-confirm-pick]')!.textContent).toContain('Wait for month-end close?');
    press($('[data-decision-confirm-yes]')!);
    expect(seen.answers.map((a) => a.selected)).toEqual([['Wait for month-end close']]);
  });

  test('the destructive choice recommended still asks once more; a Skip answers at once', () => {
    const risky = { ...INVOICES, choices: INVOICES.choices.map((c) => ({ ...c, recommended: c.label === 'Delete now' })), recommendation: 'Delete now' };
    const seen = render(decision(risky));
    press($$('.ib-dm-choice input')[0]!);
    expect(seen.answers).toHaveLength(0);
    expect($('[data-decision-confirm-pick]')!.textContent).toContain('Delete now?');
    press($('[data-decision-confirm-cancel]')!);
    press($('[data-decision-skip]')!);
    expect($('[data-decision-confirm-pick]')).toBeNull();
    expect(seen.answers.map((a) => a.skipped)).toEqual([true]);
  });

  test("a long answer's confirm button is cut, its accessible name whole", () => {
    const long = 'Delete every duplicate invoice in the legacy billing system today';
    const seen = render(decision({ ...INVOICES, choices: [{ label: long, description: null, recommended: false, settled: false }, ...INVOICES.choices.slice(1)] }));
    press($$('.ib-dm-choice input')[0]!);
    const yes = $('[data-decision-confirm-yes]')!;
    expect(yes.textContent!.length).toBeLessThanOrEqual(40);
    expect(yes.textContent!.endsWith('…')).toBe(true);
    expect(yes.getAttribute('aria-label')).toBe(long);
    press(yes);
    expect(seen.answers.map((a) => a.selected)).toEqual([[long]]);
  });

  test('a one-way pick confirmed counts; Escape cancels the step, never answers', () => {
    const seen = render(decision(INVOICES));
    press($$('.ib-dm-choice input')[0]!);
    let walked: boolean | undefined;
    act(() => {
      walked = seen.field.current?.();
    });
    expect(walked).toBe(true);
    expect($('[data-decision-confirm-pick]')).toBeNull();
    expect(seen.answers).toHaveLength(0);
    press($$('.ib-dm-choice input')[0]!);
    const yes = $('[data-decision-confirm-yes]')!;
    expect(yes.textContent).toBe('Delete now');
    press(yes);
    expect(seen.answers.map((a) => a.selected)).toEqual([['Delete now']]);
    expect($('[data-decision-confirm-pick]')).toBeNull();
  });

  test('a line is drawn as a sentence only when its first word is plain lower-case letters', () => {
    expect(sentence('on a 320 px screen')).toBe('On a 320 px screen');
    expect(sentence('ships, then QA.')).toBe('Ships, then QA.');
    for (const kept of ['https://example.com/plan', 'src/foo.ts breaks', 'iOS users only', '`npm` is pinned', '4.2 ships Thursday', 'Already a sentence.']) expect(sentence(kept)).toBe(kept);
  });

  test('a Shows file with a folder is matched by its path, else by its name', () => {
    const files: InboxDecision['pictures']['attachments'] = [
      { attachment_id: 'att_old', name: 'plan.md', kind: 'markdown', size: 1, media_type: null, paths: ['/work/web/archive/plan.md'] },
      { attachment_id: 'att_new', name: 'plan.md', kind: 'markdown', size: 1, media_type: null, paths: ['/work/web/docs/plan.md'] },
    ];
    const d = decision(question({}), { inline: [], attachments: files });
    expect(showsFile(d, 'docs/plan.md')?.attachment_id).toBe('att_new');
    expect(showsFile(d, './archive/plan.md')?.attachment_id).toBe('att_old');
    // No path matches (an older Inbox sends no paths, or another folder): the name.
    expect(showsFile(d, 'other/plan.md')?.attachment_id).toBe('att_old');
    expect(showsFile(d, 'plan.md')?.attachment_id).toBe('att_old');
    expect(showsFile(d, 'missing.md')).toBeNull();
  });

  test('an older record without the lines draws as before', () => {
    render(decision(question({ choices: [{ label: 'Yes', description: null, recommended: false, settled: false }, { label: 'No', description: null, recommended: false, settled: false }] })), { touch: true });
    expect($('[data-decision-stakes]')).toBeNull();
    expect($('[data-decision-why]')).toBeNull();
    expect($('[data-decision-one-way]')).toBeNull();
    expect($('[data-decision-tiles]')).toBeNull();
    expect($('.ib-dm-swipehint')!.textContent).toBe('Swipe right for Yes, left for No.');
  });
});
