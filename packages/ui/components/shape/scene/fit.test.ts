import { describe, expect, test } from 'bun:test';
import { SCENE_FIT, sceneSize, type SceneRoom } from './fit';

const room = (over: Partial<SceneRoom>): SceneRoom => ({ slotW: 1300, room: 760, others: 150, lead: 0, vbW: 900, vbH: 420, label: 13, ...over });
const fits = (r: SceneRoom, s = sceneSize(r)) => s.height + r.others + r.lead <= Math.max(r.room, SCENE_FIT.floor + r.others + r.lead + 4);

describe('a scene fits the window', () => {
  test('on a laptop a drawing is never drawn larger than its own size', () => {
    const s = sceneSize(room({}));
    expect(s.scale).toBe(1);
    expect(s.width).toBe(900);
    expect(s.pan).toBe(false);
    expect(sceneSize(room({ vbW: 320, vbH: 120 })).width).toBe(640);
  });

  test('a tall drawing scales down so drawing and controls fit, at 1440x900 and 1280x720', () => {
    for (const r of [room({ vbW: 1000, vbH: 900 }), room({ slotW: 1150, room: 580, vbW: 1000, vbH: 900 })]) {
      const s = sceneSize(r);
      expect(fits(r, s)).toBe(true);
      expect(s.width / s.height).toBeCloseTo(1000 / 900);
    }
  });

  test('never shorter than the floor: a tiny window scrolls instead', () => {
    const s = sceneSize(room({ room: 200, vbW: 800, vbH: 800 }));
    expect(s.height).toBe(SCENE_FIT.floor);
  });

  test('on a phone a wide drawing keeps 9 px labels and pans sideways, and still fits the height', () => {
    const r = room({ slotW: 358, room: 640, vbW: 900, vbH: 420, label: 13 });
    const s = sceneSize(r);
    expect(s.scale * r.label).toBeGreaterThanOrEqual(SCENE_FIT.label - 1e-9);
    expect(s.pan).toBe(true);
    expect(s.width).toBeLessThanOrEqual(r.slotW * SCENE_FIT.pan);
    expect(fits(r, s)).toBe(true);
  });

  test('on a phone a drawing that is already readable does not pan', () => {
    const s = sceneSize(room({ slotW: 358, room: 640, vbW: 400, vbH: 300, label: 13 }));
    expect(s.pan).toBe(false);
    expect(s.width).toBeLessThanOrEqual(358);
  });
});
