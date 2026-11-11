/** Literal `type: "file"` imports, which `bun build --compile` embeds and which are read only when the window asks. A name not listed here is never served. */

// @ts-ignore - Bun import attribute for an embedded file
import fixture from "../inbox/tour/content/fixture.json" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import builtA1 from "../inbox/tour/content/built-a1.webp" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import builtA2 from "../inbox/tour/content/built-a2.webp" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import evaluation from "../inbox/tour/content/evaluation.md" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import filmClip from "../inbox/tour/content/film-clip.mp4" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import filmPoster from "../inbox/tour/content/film-poster.webp" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import vsAThumb from "../inbox/tour/content/vs-a-thumb.webp" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import vsA from "../inbox/tour/content/vs-a.webp" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import vsBThumb from "../inbox/tour/content/vs-b-thumb.webp" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import vsB from "../inbox/tour/content/vs-b.webp" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import vsCThumb from "../inbox/tour/content/vs-c-thumb.webp" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import vsC from "../inbox/tour/content/vs-c.webp" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import vsDThumb from "../inbox/tour/content/vs-d-thumb.webp" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import vsD from "../inbox/tour/content/vs-d.webp" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import vscodeMockups from "../inbox/tour/content/vscode-mockups.html" with { type: "file" };

export const INBOX_TOUR_FIXTURE_PATH: string = fixture as unknown as string;

export const INBOX_TOUR_ASSET_PATHS: Readonly<Record<string, string>> = Object.freeze({
  "built-a1.webp": builtA1,
  "built-a2.webp": builtA2,
  "evaluation.md": evaluation,
  "film-clip.mp4": filmClip,
  "film-poster.webp": filmPoster,
  "vs-a-thumb.webp": vsAThumb,
  "vs-a.webp": vsA,
  "vs-b-thumb.webp": vsBThumb,
  "vs-b.webp": vsB,
  "vs-c-thumb.webp": vsCThumb,
  "vs-c.webp": vsC,
  "vs-d-thumb.webp": vsDThumb,
  "vs-d.webp": vsD,
  "vscode-mockups.html": vscodeMockups,
} as unknown as Record<string, string>);
