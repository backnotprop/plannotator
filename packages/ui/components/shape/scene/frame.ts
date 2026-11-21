// A still of one moment, for `plannotator shape frame` (approval
// "shape-animated-scenes", addendum): the Shape page opened with
// `#shape=<id>&frame=<scene>&at=<time>` draws that scene at that time, paused,
// so a headless browser can take its picture. A module-level seam with a null
// default: a page that never sets it (the Inbox, Workspaces, the Shape page
// opened by a person) plays scenes as before.

export interface SceneFrame {
  /** The scene id (`scenes.<id>`). */
  scene: string;
  /** The moment, in the scene's own clock. */
  at: number;
}

let frame: SceneFrame | null = null;

export function setSceneFrame(next: SceneFrame | null): void {
  frame = next;
}

export function sceneFrame(): SceneFrame | null {
  return frame;
}

/** `frame=<scene>&at=<time>` from a page's hash; null without both. */
export function sceneFrameFromHash(hash: string): SceneFrame | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const scene = params.get('frame');
  const at = Number(params.get('at'));
  if (!scene || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(scene) || params.get('at') === null || !Number.isFinite(at) || at < 0) return null;
  return { scene, at };
}
