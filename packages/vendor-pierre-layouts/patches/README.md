# Patches to upstream/

None. The copy under `../upstream/` runs unchanged.

A change we must make to upstream's code goes here as one `.patch` file per change (`git diff` format, paths relative
to `upstream/`), its first line a `# why:` comment, and is listed in `../UPSTREAM.md`. It is applied to a generated
`patched/` copy, never to `upstream/` itself; see `../README.md`, "Patching".
