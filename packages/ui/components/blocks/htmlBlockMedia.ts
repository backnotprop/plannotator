import { UNAVAILABLE_IMAGE_CLASS } from "../ImageResolverContext";

const PLAYER_CLASS = { audio: "annotation-exclude block max-w-full my-2", video: "annotation-exclude block max-w-full max-h-[70vh] rounded my-2" } as const;

export function htmlBlockPlayer(doc: Document, src: string, alt: string, writtenSrc: string, media: "audio" | "video"): HTMLMediaElement {
  const player = doc.createElement(media);
  player.setAttribute("data-inline-media-src", src);
  player.setAttribute("controls", "");
  player.setAttribute("preload", "metadata");
  if (media === "video") player.setAttribute("playsinline", "");
  player.setAttribute("aria-label", alt || writtenSrc.replace(/[?#].*$/, "").split(/[\\/]/).pop() || (media === "audio" ? "Sound" : "Video"));
  if (alt) player.setAttribute("title", alt);
  player.setAttribute("data-inline-media", media);
  player.className = PLAYER_CLASS[media];
  return player;
}

export function htmlBlockPlayersIn(root: HTMLElement): Map<string, HTMLMediaElement> {
  const players = new Map<string, HTMLMediaElement>();
  root.querySelectorAll<HTMLMediaElement>("[data-inline-media-src]").forEach((player) => {
    const src = player.getAttribute("data-inline-media-src")!;
    if (!player.hidden && !players.has(src)) players.set(src, player);
  });
  return players;
}

export function keepHtmlBlockPlayers(root: HTMLElement, earlier: Map<string, HTMLMediaElement>): void {
  root.querySelectorAll<HTMLMediaElement>("[data-inline-media-src]").forEach((player) => {
    const kept = earlier.get(player.getAttribute("data-inline-media-src")!);
    if (!kept || kept.isConnected) return;
    earlier.delete(player.getAttribute("data-inline-media-src")!);
    player.replaceWith(kept);
  });
}

export function wireHtmlBlockPlayers(root: HTMLElement): () => void {
  const cleanups: (() => void)[] = [];
  root.querySelectorAll<HTMLMediaElement>("[data-inline-media]").forEach((player) => {
    const src = player.getAttribute("data-inline-media-src");
    if (src && !player.hasAttribute("src")) player.setAttribute("src", src);
    const onError = () => {
      if (player.hidden) return;
      const noun = player.tagName === "AUDIO" ? "Sound" : "Video";
      const chip = player.ownerDocument.createElement("span");
      chip.className = `${UNAVAILABLE_IMAGE_CLASS} annotation-exclude`;
      chip.title = `${noun} could not be loaded`;
      chip.setAttribute("data-image-unavailable", "");
      chip.textContent = player.getAttribute("title") || noun;
      player.before(chip);
      player.hidden = true;
      player.setAttribute("aria-hidden", "true");
      player.removeAttribute("aria-label");
      player.removeAttribute("class");
    };
    player.addEventListener("error", onError);
    cleanups.push(() => player.removeEventListener("error", onError));
  });
  return () => cleanups.forEach((cleanup) => cleanup());
}
