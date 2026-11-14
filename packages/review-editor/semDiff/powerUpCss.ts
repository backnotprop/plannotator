const STILL = `
[data-line][data-semantic-origin] {
  --pu-c: var(--diffs-moved-base);
  --pu-edge: color-mix(in srgb, var(--pu-c) 62%, transparent);
  --pu-lit: light-dark(color-mix(in srgb, var(--pu-c) 15%, transparent), color-mix(in srgb, var(--pu-c) 20%, transparent));
  isolation: isolate;
  background-image: var(--pu-top, none), var(--pu-bottom, none), linear-gradient(var(--pu-lean, 90deg), transparent 0%, var(--pu-lit) 100%);
  background-size: 100% 1px, 100% 1px, 100% 100%;
  background-position: 0 0, 0 100%, 0 0;
  background-repeat: no-repeat;
}
[data-line][data-semantic-origin]:is([data-line-type="change-edited"], [data-line-type="change-moved-with-edit"], [data-line-type="change-renamed"]) { --pu-c: var(--diffs-edited-base); }
[data-line][data-semantic-origin][data-line-type="change-reformatted"] { --pu-c: var(--diffs-reformatted-base); }
[data-additions] [data-line][data-semantic-origin] { --pu-lean: 270deg; }
[data-line][data-semantic-origin][data-semantic-start] { --pu-top: linear-gradient(var(--pu-edge), var(--pu-edge)); }
[data-line][data-semantic-origin][data-semantic-end] { --pu-bottom: linear-gradient(var(--pu-edge), var(--pu-edge)); }
path[data-connector-origin] { opacity: 1; fill-opacity: .2; stroke-opacity: .5; stroke-width: 1px; }
path[data-connector-origin][data-connector-kind="moved"] { stroke: var(--diffs-moved-base); }
path[data-connector-origin][data-connector-kind="modified"] { stroke: var(--diffs-edited-base); }
path[data-connector-origin][data-connector-kind="reformatted"] { stroke: var(--diffs-reformatted-base); }
[data-overflow="wrap"] [data-line][data-semantic-origin] { overflow: clip; }
`;

const STREAM = `
[data-line][data-semantic-origin]::before {
  --pu-s: light-dark(color-mix(in srgb, var(--pu-c) 24%, transparent), color-mix(in srgb, var(--pu-c) 34%, transparent));
  --pu-s2: light-dark(color-mix(in srgb, var(--pu-c) 10%, transparent), color-mix(in srgb, var(--pu-c) 14%, transparent));
  content: "";
  position: absolute; z-index: -1; top: 0; bottom: 0; left: -480px; right: 0;
  pointer-events: none;
  background-image: linear-gradient(90deg, transparent 0%, var(--pu-s2) 9%, var(--pu-s) 26%, var(--pu-s2) 41%, transparent 52%, var(--pu-s2) 66%, var(--pu-s2) 76%, transparent 92%, transparent 100%);
  background-size: 480px 100%;
  background-repeat: repeat-x;
  opacity: .55;
  animation: pu-flow 24s linear infinite;
}
@keyframes pu-flow { to { transform: translate3d(480px, 0, 0); } }
@media (prefers-reduced-motion: reduce) {
  [data-line][data-semantic-origin]::before { content: none !important; animation: none !important; }
}
`;

export function powerUpCss(motion: 'stream' | 'still', indicators: 'bars' | 'classic' | 'none'): string {
  return motion === 'stream' && indicators !== 'classic' ? STILL + STREAM : STILL;
}
