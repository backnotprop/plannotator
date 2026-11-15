/**
 * The Inbox's built-in icon sets for agents' icons ("Sets" in the face picker), kept in
 * packages/inbox/assets/icon-sets/ (licences and credits in its NOTICE). Served lazily from the binary, never inlined
 * into inbox.html, the way the Inbox tour's pictures are (inbox-tour-content.ts): each file is a literal
 * `type: "file"` import, which `bun build --compile` embeds and which answers only the file's path (the source file in
 * a checkout, the embedded one in the binary), so nothing is read until a window asks. One set is two files: its
 * manifest and `icons.bin`, every icon's bytes one after the other (scripts/build-icon-sets.ts); an icon is read by
 * slice. A set not listed here is never served.
 */

// @ts-ignore - Bun import attribute for an embedded file
import tinyManifest from "../inbox/assets/icon-sets/tiny-creatures/manifest.json" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import tinyIcons from "../inbox/assets/icon-sets/tiny-creatures/icons.bin" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import gameManifest from "../inbox/assets/icon-sets/game-icons/manifest.json" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import gameIcons from "../inbox/assets/icon-sets/game-icons/icons.bin" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import gameCredits from "../inbox/assets/icon-sets/game-icons/CREDITS.md" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import dcssManifest from "../inbox/assets/icon-sets/dcss/manifest.json" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import dcssIcons from "../inbox/assets/icon-sets/dcss/icons.bin" with { type: "file" };
// Noto Emoji 3D: its own folder and this one entry, nothing else (noto-3d/LICENSE.md says how to remove or swap it).
// @ts-ignore - Bun import attribute for an embedded file
import notoManifest from "../inbox/assets/icon-sets/noto-3d/manifest.json" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import notoIcons from "../inbox/assets/icon-sets/noto-3d/icons.bin" with { type: "file" };

export interface BuiltInIconSetFiles {
  manifest: string;
  icons: string;
  credits?: string;
}

/** The built-in sets, in the picker's order: their files' paths (the source files, or the binary's embedded copies). */
export const BUILT_IN_ICON_SET_FILES: Readonly<Record<string, BuiltInIconSetFiles>> = Object.freeze({
  "noto-3d": { manifest: notoManifest, icons: notoIcons },
  dcss: { manifest: dcssManifest, icons: dcssIcons },
  "game-icons": { manifest: gameManifest, icons: gameIcons, credits: gameCredits },
  "tiny-creatures": { manifest: tinyManifest, icons: tinyIcons },
} as unknown as Record<string, BuiltInIconSetFiles>);
