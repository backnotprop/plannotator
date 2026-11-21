# Draw a pull request's change on the system

A pull request is open and you are reviewing it. The project has a drawing of its system in the drawing folder, in
Plannotator's own folder on this Mac. You draw how this pull request changes that drawing, so the person sees the change
in place: added parts green, changed parts amber, removed parts grey. You write one revision file and hand it to
Plannotator. You never commit it and never push it to the pull request's branch. The format is at the end of these
instructions, under "System format 1"; a revision is under "revisions/<id>.yaml".

You need five facts: the project's folder, the drawing folder, the pull request (`host/owner/repo#n`), its head commit
and its base branch. When Plannotator hands you this job they are listed above these instructions; otherwise take them
from the review you are doing.

## Steps

1. **Ask the check first.** Find the merge base: `git -C <project folder> merge-base origin/<base> <head>`. Run
   `plannotator system gate --project <project folder> --dir <drawing folder> --from <merge base> --to <head>`, with
   the merge base as the sha `merge-base` printed: the gate diffs exactly the two commits it is given and finds no
   merge base itself. It reads the drawing in the drawing folder: `touched` then names the parts and lines of the
   drawing the change lands on. It prints JSON: `touched`
   (the parts and lines that cite a changed file), `wake` and `why`. If `wake` is false, stop here: the change is
   drawn from `touched` alone, with no revision from you.

2. **Read the drawing** in the drawing folder: `<drawing folder>/system.yaml`, and each sheet the touched parts are
   on (`grep -l <part id> <drawing folder>/sheets/*.yaml` lists them; `<drawing folder>/sheets/<CODE>.yaml` is one).
   Note the ids of the parts, lines and bands you will name.

3. **Read the change.** `git -C <project folder> diff --name-status -M <merge base> <head>` and
   `git -C <project folder> diff --numstat <merge base> <head>`, then the diff of every changed file the gate did not
   list under `ignored` (`why` names only the files that woke it, not every edit). Tests, docs and lockfiles do not
   count. Draw what the code does at the head commit, never what the pull request's text claims.

4. **Write the revision in the open form.** The drawing does not have the pull request's new parts yet, so:
   - `revision: PR-<n>`, `scope` (the scope the change lives in; `root` when it spans scopes), `title` (what the
     change does, in a few words), `pr: <n>`, `repo: <host/owner/repo>`, `date` (today, quoted). No `merged:`.
   - `add.parts` and `add.flows`: each new part and line as a full entry, with `code:` where it rests on code (an
     outside part has none). `place`: for each new part, the sheet and band it goes in
     (`{ <CODE>: { <id>: { band: <band id>, after: <part id>, span: <1 to 12> } } }`); it takes the first `~` gap
     after `after:`, else it is put right after it. Put a new part in the band it belongs in, even a full one: spans
     are a preference, and Plannotator narrows a full band to fit. Leave out `span:` or keep it. Never put a part in
     another band to make room.
   - `change`: one sentence per part or line whose behaviour the diff changes, naming what it now does. `touched`
     lists every part and line citing a changed file; one whose file changed in a way that leaves it doing the same
     thing gets no sentence.
   - `remove`: each removed part or line, with one sentence; a removed line keeps its old ends
     (`flow: { from, to, says }`) so Before can draw it.
   - `lines`: per changed or added part, its files and counts from `--numstat`, for example
     `"worker.ts and 2 more · +120 −31"`.
   - `steps`: the one sequence the pull request changes, about eight hops on its own `lanes`, each hop marked
     `is: added` or `is: changed` when it is new or different.

5. **Hand it to Plannotator.** Write the YAML to a file outside the project folder (a temporary file) and pipe it to
   `plannotator system revision --project <project folder> --pr <host/owner/repo#n> --head <head> -`. It loads the
   revision against the drawing and refuses one that does not load, naming the field. Fix the field and send it
   again until it is accepted. A later send for the same head replaces the stored one. Do not commit the file
   anywhere.
