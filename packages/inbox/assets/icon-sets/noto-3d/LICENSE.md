# Noto Emoji 3D: licence

**Where the files come from, and what is and is not stated about them.**

- Source: https://github.com/googlefonts/noto-emoji, `main` at 99701e07d3d1 (2026-10-26), folder `3D/png/128/`. 149
  emoji kept (animals, birds, sea life, bugs, monkey and cat faces, fantasy beings, ogre, goblin, ghost, aliens, robot,
  devils, skull, jack-o-lantern), saved as 80 px WebP (quality 90).
- The `3D/png/` folder was added in commit d6a792cb12 "Add 3D PNGs" (2026-09-17, PR #560). It carries no licence file
  of its own, in any size folder.
- `3D/fonts/LICENSE` (the same day) is the SIL Open Font License 1.1, for the `Noto-3D-*.ttf` fonts in that folder,
  which carry the same artwork.
- The repository's README says: "Emoji fonts (under the fonts subdirectory) are under the SIL Open Font License,
  version 1.1. Tools and most image resources are under the Apache license, version 2.0 (./LICENSE)". The root
  `LICENSE` file is the OFL text since 2024-07-29. `2D/svg/LICENSE` is Apache-2.0.
- Google's World Emoji Day post (blog.google, "world-emoji-day-noto-3d") calls the 3D library open source, "available
  for everyone to remix and use".
- The question of which licence covers the 3D PNGs is open upstream: googlefonts/noto-emoji#592 (2026-11-02,
  unanswered when this set was built).
- Names come from Unicode's `emoji-test.txt` v18.0.

## Removing or swapping this set

The set is this folder plus one line in `packages/server/inbox-icon-sets-content.ts` (its two imports and its entry).
Nothing else depends on it: delete both, and agents that showed one of its icons show their own mark again. To swap in
another build of the same emoji (for example drawn from the OFL font), rebuild this folder with
`bun scripts/build-icon-sets.ts <pack folder>` keeping the icon ids.
