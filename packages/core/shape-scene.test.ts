import { describe, expect, test } from 'bun:test';
import { checkShapeBoard, shapeBoardNotes } from './shape';
import { checkShapeScene, SHAPE_SCENE_LIMITS, type ShapeScene } from './shape-scene';

const scene = (): ShapeScene => ({
  scene: 1,
  title: 'A job travels the channel',
  unit: 'ms',
  end: 20,
  beats: [
    { at: 0, say: 'The worker takes job 2.' },
    { at: 12, say: 'It sends the result; nobody reads it.' },
  ],
  tracks: {
    job: [
      { at: 0, along: 'wire', p: 0 },
      { at: 12, along: 'wire', p: 1, ease: 'linear' },
    ],
    w2: [{ at: 12, color: 'alert', lit: true }],
  },
});
const errorsOf = (v: unknown) => {
  const r = checkShapeScene(v);
  return r.ok ? '' : r.errors.join('\n');
};
const board = (s: unknown, html = '<div data-scene="pool"><svg viewBox="0 0 200 100"><path data-part="wire" d="M10 50H190"/><circle data-part="job" r="5"/><g data-part="w2"><rect width="20" height="20"/></g></svg></div>') => ({
  title: 'Pool',
  claim: 'Worker 2 leaks.',
  views: { picture: { html } },
  scenes: { pool: s },
});

describe('checkShapeScene', () => {
  test('a keyframe past the end, out of order, or with two places is named by its field', () => {
    const s = scene() as any;
    s.tracks.job[1].at = 30;
    s.tracks.w2.push({ at: 5, x: 3 });
    s.tracks.job.push({ at: 15, x: 1, to: 'w2' });
    const all = errorsOf(s);
    expect(all).toContain('scene.tracks.job[1].at: must be a time from 0 to end (20)');
    expect(all).toContain('scene.tracks.w2[1].at: must not come before');
    expect(all).toContain('scene.tracks.job[2]: give one place');
  });

  test('a colour that is not a board variable, and a key the format lacks, are refused by name', () => {
    const s = scene() as any;
    s.tracks.w2[0].color = '#ff0000';
    s.tracks.w2[0].fill = 'red';
    const all = errorsOf(s);
    expect(all).toContain('scene.tracks.w2[0].color: must be a board colour');
    expect(all).toContain('scene.tracks.w2[0].fill: is not part of a keyframe');
    const t = scene() as any;
    t.tracks.w2[0].color = 'var(--alert)';
    expect(checkShapeScene(t).ok).toBe(true);
  });

  test('beats must be in time order, and a beat line needs code that has the line', () => {
    const s = scene() as any;
    s.beats.push({ at: 12, say: 'Again.' });
    s.beats[0].line = 2;
    const all = errorsOf(s);
    expect(all).toContain('scene.beats[2].at: must come after the beat before it');
    expect(all).toContain('scene.beats[0].line: needs the scene to have code');
    s.beats.pop();
    s.code = { lines: ['a', 'b'] };
    expect(checkShapeScene(s).ok).toBe(true);
  });

  test('along without p, and a key that changes nothing, are refused', () => {
    const s = scene() as any;
    delete s.tracks.job[0].p;
    s.tracks.w2.push({ at: 14 });
    const all = errorsOf(s);
    expect(all).toContain('scene.tracks.job[0].p: is required with along');
    expect(all).toContain('scene.tracks.w2[1]: changes nothing');
  });
});

describe('the limits a scene is held to', () => {
  test('more pieces than the limit is refused at tracks, with the count', () => {
    const s = scene() as any;
    for (let i = 0; i < SHAPE_SCENE_LIMITS.tracks; i++) s.tracks[`p${i}`] = [{ at: 0, opacity: 1 }];
    expect(errorsOf(s)).toContain(`scene.tracks: has ${SHAPE_SCENE_LIMITS.tracks + 2} pieces; at most ${SHAPE_SCENE_LIMITS.tracks}`);
  });

  test('too many keyframes on one piece, or in the whole scene, is refused', () => {
    const one = scene() as any;
    one.tracks.w2 = Array.from({ length: SHAPE_SCENE_LIMITS.keysPerTrack + 1 }, (_, i) => ({ at: (i / 1000) * 20, opacity: 1 }));
    expect(errorsOf(one)).toContain(`scene.tracks.w2: has ${SHAPE_SCENE_LIMITS.keysPerTrack + 1} keyframes; at most ${SHAPE_SCENE_LIMITS.keysPerTrack}`);
    const all = scene() as any;
    for (let p = 0; p < 16; p++) all.tracks[`p${p}`] = Array.from({ length: 190 }, (_, i) => ({ at: (i / 190) * 20, opacity: 1 }));
    expect(errorsOf(all)).toContain(`scene.tracks: has ${16 * 190 + 3} keyframes; at most ${SHAPE_SCENE_LIMITS.keys}`);
  });

  test('a long title, a long beat, too many beats and a long source are refused by field', () => {
    const s = scene() as any;
    s.title = 'x'.repeat(SHAPE_SCENE_LIMITS.title + 1);
    s.beats[1].say = 'y'.repeat(SHAPE_SCENE_LIMITS.say + 1);
    s.source = 'z'.repeat(201);
    const all = errorsOf(s);
    expect(all).toContain(`scene.title: is ${SHAPE_SCENE_LIMITS.title + 1} characters; at most ${SHAPE_SCENE_LIMITS.title}`);
    expect(all).toContain(`scene.beats[1].say: is ${SHAPE_SCENE_LIMITS.say + 1} characters; at most ${SHAPE_SCENE_LIMITS.say}`);
    expect(all).toContain('scene.source: is 201 characters; at most 200');
    const many = scene() as any;
    many.end = 1000;
    many.beats = Array.from({ length: SHAPE_SCENE_LIMITS.beats + 1 }, (_, i) => ({ at: i, say: `b${i}` }));
    expect(errorsOf(many)).toContain(`scene.beats: has ${SHAPE_SCENE_LIMITS.beats + 1}; at most ${SHAPE_SCENE_LIMITS.beats}`);
  });

  test('scaleX and scaleY are kept, and out of range is refused', () => {
    const s = scene() as any;
    s.tracks.w2.push({ at: 14, scaleX: 0.5, scaleY: 3 });
    const r = checkShapeScene(s);
    expect(r.ok && r.value.tracks.w2![1]).toEqual({ at: 14, scaleX: 0.5, scaleY: 3 });
    s.tracks.w2[1].scaleY = 40;
    expect(errorsOf(s)).toContain('scene.tracks.w2[1].scaleY: must be a number from 0 to 20');
  });
});

describe('a board with scenes', () => {
  test('more than 8 scenes, a bad id and a prototype key are refused; nothing resolves through the prototype', () => {
    const scenes: Record<string, unknown> = {};
    for (let i = 0; i < 9; i++) scenes[`s${i}`] = scene();
    const r = checkShapeBoard({ ...board(scene()), scenes });
    expect(r.ok ? '' : r.errors.join('\n')).toContain('scenes: has 9; at most 8');
    const proto = checkShapeBoard(board(scene(), '<div data-scene="constructor"><svg><path data-part="wire"/><circle data-part="job"/><g data-part="w2"/></svg></div>'));
    expect(proto.ok ? '' : proto.errors.join('\n')).toContain('has data-scene="constructor", but scenes has no "constructor"');
    const badId = checkShapeBoard({ ...board(scene()), scenes: { pool: scene(), 'no spaces': scene() } });
    expect(badId.ok ? '' : badId.errors.join('\n')).toContain('scenes.no spaces: the id must be a short word');
  });


  test('keeps a valid scene', () => {
    const r = checkShapeBoard(board(scene()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scenes?.pool?.tracks.job?.length).toBe(2);
  });

  test('names a piece, a to or an along that the drawing does not have', () => {
    const s = scene() as any;
    s.tracks.ghost = [{ at: 1, opacity: 0 }];
    s.tracks.w2.push({ at: 14, to: 'nowhere' });
    const r = checkShapeBoard(board(s, '<div data-scene="pool"><svg><circle data-part="job" r="5"/><g data-part="w2"></g></svg></div>'));
    expect(r.ok).toBe(false);
    const all = r.ok ? '' : r.errors.join('\n');
    expect(all).toContain('scenes.pool.tracks.ghost: the drawing has no data-part="ghost"');
    expect(all).toContain('scenes.pool.tracks.w2[1].to: the drawing has no data-part="nowhere"');
    expect(all).toContain('scenes.pool.tracks.job[0].along: the drawing has no data-part="wire"');
  });

  test('a data-scene slot with no such scene is named; one in a comment is not', () => {
    const r = checkShapeBoard({ title: 'T', claim: 'C', views: { picture: { html: '<div data-scene="nope"></div><!-- <div data-scene="old"></div> -->' } } });
    expect(r.ok).toBe(false);
    const all = r.ok ? '' : r.errors.join('\n');
    expect(all).toContain('views.picture.html: has data-scene="nope", but the board has no scenes');
    expect(all).not.toContain('"old"');
  });

  test('a data-scene on anything but a <div> is refused by name', () => {
    const r = checkShapeBoard(board(scene(), '<svg viewBox="0 0 200 100"><g data-scene="pool"><path data-part="wire"/><circle data-part="job"/><g data-part="w2"/></g></svg>'));
    expect(r.ok ? '' : r.errors.join('\n')).toContain('views.picture.html: data-scene="pool" is on a <g>; put it on a <div> around your SVG: <div data-scene="pool"><svg>…</svg></div>');
  });

  test("a scene's pieces must be in the view that plays it, not another view", () => {
    const r = checkShapeBoard({
      ...board(scene(), '<div data-scene="pool"><svg viewBox="0 0 200 100"><path data-part="wire"/><circle data-part="job"/></svg></div>'),
      views: {
        picture: { html: '<div data-scene="pool"><svg viewBox="0 0 200 100"><path data-part="wire"/><circle data-part="job"/></svg></div>' },
        how: { html: '<svg><g data-part="w2"/></svg>' },
      },
    });
    expect(r.ok ? '' : r.errors.join('\n')).toContain('scenes.pool.tracks.w2: the drawing has no data-part="w2"');
    const more = checkShapeBoard({
      ...board(scene()),
      views: { picture: { html: '<div data-scene="pool"><svg viewBox="0 0 200 100"><path data-part="wire"/><circle data-part="job"/></svg></div>', more: { html: '<svg><g data-part="w2"/></svg>' } } },
    });
    expect(more.ok ? '' : more.errors.join('\n')).toBe('');
  });

  test('a scene that no drawing plays is refused, with where its slot goes', () => {
    const r = checkShapeBoard({ ...board(scene()), scenes: { pool: scene(), spare: scene() } });
    expect(r.ok ? [] : r.errors).toEqual(['scenes.spare: no drawing plays it; put <div data-scene="spare"><svg>…</svg></div> in the Picture or How it works']);
  });
});

describe('the notes shape update prints for a board with a scene', () => {
  test('no fixed-canvas advice for a scene; a canvas on one is called out', () => {
    const html = '<div data-scene="pool"><svg viewBox="0 0 200 100"><path data-part="wire" d="M10 50H190"/></svg></div>';
    expect(shapeBoardNotes({ views: { picture: { html } } }).join('\n')).not.toContain('Give it a fixed canvas');
    expect(shapeBoardNotes({ views: { picture: { html, width: 900, height: 500 } } }).join('\n')).toContain('The Picture plays a scene, so leave its width and height off');
    expect(shapeBoardNotes({ views: { picture: { html: '<p>still</p>' } } }).join('\n')).toContain('Give it a fixed canvas');
  });
});
