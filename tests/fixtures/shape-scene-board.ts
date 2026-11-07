/**
 * A board with one scene (invented content: a ball that turns a lamp on), for the store's tests and the
 * Pi/Bun parity test: the scene must come back from either runtime as the agent wrote it.
 */
import type { ShapeBoard } from "../../packages/core/shape";

export function sceneBoard(): ShapeBoard {
  return {
    title: "The lamp",
    claim: "The ball turns the lamp on when it arrives.",
    views: {
      picture: {
        html: '<div data-scene="lamp"><svg viewBox="0 0 400 120" width="100%"><path data-part="road" d="M20 60 H380" stroke="var(--rule)" fill="none"/><circle data-part="ball" cx="20" cy="60" r="8" fill="currentColor"/><g data-part="lamp"><rect x="360" y="20" width="30" height="30" rx="2" fill="currentColor"/><text x="375" y="70">off</text></g></svg></div>',
      },
    },
    scenes: {
      lamp: {
        scene: 1,
        title: "The ball reaches the lamp and turns it on",
        source: "illustrative: a made-up lamp",
        unit: "ms",
        end: 10,
        beats: [{ at: 0, say: "The ball sets off." }, { at: 8, say: "It reaches the lamp, so the lamp turns on." }],
        legend: [{ color: "green", label: "on" }],
        tracks: {
          ball: [{ at: 0, along: "road", p: 0 }, { at: 8, along: "road", p: 1, ease: "linear" }],
          lamp: [{ at: 0, color: "grey", text: "off" }, { at: 8, color: "green", text: "on", lit: true, scaleY: 1.2 }],
        },
      },
    },
  };
}
