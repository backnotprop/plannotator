export function whenStill(el: () => HTMLElement | null, then: () => void): () => void {
  let last = '';
  let still = 0;
  let frames = 0;
  let id = requestAnimationFrame(function tick() {
    const box = el()?.getBoundingClientRect();
    const now = box ? `${box.left},${box.top},${box.width},${box.height}` : '';
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 3 || ++frames >= 60) then();
    else id = requestAnimationFrame(tick);
  });
  return () => cancelAnimationFrame(id);
}
