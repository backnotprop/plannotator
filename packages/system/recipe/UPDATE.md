# Redraw the system: bring the drawing up to date

The project's main branch moved, and the files it changed may have moved the shape of the system. You bring the
drawing in `.plannotator/system/` up to date with the code at the new commit. Nobody is watching: work alone, and
stop when the drawing is right or when you decide it does not change. The format is at the end of these
instructions, under "System format 1".

The facts of this job are listed above these instructions: the worktree to work in, the range of commits that
landed, the merged pull requests, why the check woke you (the changed files and their reasons), the parts and lines
that cite a changed file, and the file to write your summary in.

## Rules

- Work in the worktree named above. It is already on the redraw branch at the new commit. Read the code there.
- Your job is the drawing: change files under `.plannotator/system/` and write the summary file named above. The
  summary file is never committed: the scheduled check puts its sentences in the pull request and in the note, then
  deletes it. Anything else you change goes into the same pull request, and the person is told which files those are.
- Do not push, open a pull request or send a message. The scheduled check does all three after you stop, with what you
  left in the worktree; you need not commit.
- Draw what the code says at the new commit, never what a commit message or a pull request's text claims.

## Steps

1. **Read what changed.** Run `git -C <worktree> diff --name-status -M <from> <to>` and
   `git -C <worktree> log --oneline <from>..<to>`. Read the diff of each file named in "why you were woken"
   (`git -C <worktree> diff -M <from> <to> -- <path>`). A `cited-gone` path that was renamed shows there as deleted;
   its new path is in the `--name-status -M` line, so read the diff of both paths. Tests, docs, lockfiles and the
   drawing's own files under `.plannotator/system/` do not count. Look for new, deleted and renamed files, and for new
   processes, stores, hosts, routes, commands, connections and switches.

2. **Decide whether the shape moved.** Find the parts and lines that cite each changed file:
   `grep -n "<path>" <worktree>/.plannotator/system/system.yaml`. If every changed file is already named and the
   change adds no process, store, host, route family, connection or switch, and removes none, the drawing does not
   change. Then change nothing at all, not even `at`: write "No change:" and one sentence of why in the summary file,
   and stop.

3. **Edit `system.yaml` to the code at the new commit.**
   - A new runtime piece (a process, server, worker, window, store, agent host, outside service) is a new part:
     `in:`, `name`, `kind`, `role` (one sentence a newcomer can read), and `code:` with its files.
   - A new call between two parts is a new line: `from`, `to`, `says`, and `code:` where a file shows it. Draw only
     the calls the code makes: a new route that no client in the repo calls yet gets no line. If it crosses into a
     window, name the part inside with `lands:` (or `leaves:` for the start).
   - A switch: read its default in the code. Off by default is drawn with "off" in the part's `sub` or its band's
     `means`, and the file the switch lives in is in `code:`.
   - Removed code: delete its part and its lines from `system.yaml`, and take its id out of every sheet (band rows,
     `show`, `quiet`, `says`, `notes`, `callouts`, flow `lanes` and `hops`). Never draw removed code as live.
   - A moved or renamed file: change its path in every `code:` map that cites it.

4. **Place each new part and line on a sheet.** A new part goes in one band `row` on the logical sheet of its scope;
   a new line goes in that sheet's `show`. If the change alters a walk, change the hops of its flow sheet. If a sheet
   passes about 30 parts or its lines tangle, move a group into a window (a part with `child:`, a new scope and a new
   sheet).

5. **Keep the change, when a stored review is named above.** A stored review is the change a reviewer drew while the
   pull request was open. Use it as a head start for steps 3 and 4. You may also keep it in the repo as
   `.plannotator/system/revisions/PR-<n>.yaml` in the merged form: each added part and line written `id: ~` (it is
   now in `system.yaml`, with the same id), no `place:`, `merged:` set to the merge commit, and the rest as the review
   wrote it, corrected to what landed.

6. **Move `at`.** Set `sources.repos.self.at` in `system.yaml` to the new commit named above, in quotes.

7. **Check, and fix until clean.** Run `plannotator system check --root <worktree>`. It looks the cited paths up at
   `sources.repos.self.at`, so it means something only after step 6: before that, a path that is gone at the new
   commit still checks clean. Fix every error, warning and missing path it prints (a missing path names the field
   that cites it, `parts.<id>.code` or `flows.<id>.code.from` or `.to`), and run it again until it prints none.

8. **Write the summary file** named above: one sentence per sheet you changed, and one for a change only
   `system.yaml` shows (a renamed file's new path), in plain words for the person, for example "On the Desktop app
   sheet, stable now shows a corner, not a header." Then stop.
