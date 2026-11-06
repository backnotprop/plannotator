# System format 1: what to write

A drawing is one folder, `.plannotator/system/`, in the project's repo:

```
.plannotator/system/
  system.yaml            required: every part and line, each fact once
  sheets/<CODE>.yaml     one file per sheet; the file is named after its code
  revisions/<id>.yaml    optional: the change of one merged pull request (PR-<n>.yaml)
```

Nothing in a drawing is a coordinate. A sheet says where a part belongs (its band, its order in the band and its
span), never where it sits. The loader refuses `x`, `y`, `w`, `h`, `lx`, `ly`, `fx`, `fy`, `tx`, `ty`, `via`, `pts`
and `px`, refuses any key it does not know, and checks every id a file names. An unquoted comma inside `{ }` splits
one text into two keys, so quote any text that has a comma, a colon or a `#` in it.

## system.yaml

```yaml
format: 1                           # always 1
system: Acme                        # the display name
root: C-001                         # the landing sheet's code
sources:                            # what you read
  repos:
    self: { repo: github.com/acme/acme, at: "<full commit sha>" }   # this repo; at: the commit you drew from, quoted
    api: { repo: github.com/acme/api, at: "<full commit sha>" }     # another repo, under an alias you choose
  docs: [https://docs.example.com]
watch: [deploy/*.toml]              # optional: globs of files whose edit changes the shape (configs, channel lists)
scopes: { root: Acme, app: The app } # a scope is what a window opens into; root is the landing
wanted:                             # sheets planned and not drawn yet; take each out once its file is written
  - { code: A-201, kind: algorithm, question: "How an order is priced, step by step." }
parts:
  person: { name: You, kind: people, role: Signs in and orders. }
  app:
    name: The app                   # what a newcomer calls it
    kind: web app                   # one or two words
    role: Serves every page and the API.    # one sentence a newcomer can read
    sub: Node 22, one process       # optional: one short mono line under the name
    marks: [ts]                     # optional: logo names; an unknown name draws as a small tag
    child: app                      # optional: this part opens the scope `app` (drawn as a window you dive into)
    facts: { Port: "8080 (server.ts)" }    # optional: short label to value pairs
    code:                           # file or folder path: what it does for this part
      src/server.ts: the entry
      api:src/client.ts: a path in the repo with alias api
  web:
    in: app                         # its scope; leave it out for root
    name: Web server
    kind: process
    role: Answers every request.
    code: { src/routes: every route }
  worker: { in: app, name: Worker, kind: process, role: Takes orders and charges them., code: { src/worker.ts: the loop } }
  db: { in: app, name: Postgres, kind: store, role: Holds accounts and orders., code: { src/db/pool.ts: the pool } }
  cache: { in: app, name: Cache, kind: store, role: Keeps prices for an hour., sub: "in memory, off in tests", code: { src/cache.ts: the cache } }
flows:
  use:
    from: person                    # one part, or a list of parts
    to: app
    says: opens a page              # the words on the line, a few words
    carries: the session cookie     # optional: what travels
    code: { to: src/routes/index.ts }      # optional: the file at either end
    lands: web                      # when `to` opens a scope: the part inside that the line reaches
    both: false                     # optional: arrowheads at both ends
    moves: data                     # optional: data, people, money or energy
  w_db: { from: worker, to: db, says: reads and writes orders, code: { from: src/worker.ts } }
  w_cache: { from: worker, to: cache, says: looks up a price }
stack:                              # optional: technology tiles for a landscape sheet; each is a part
  t-node: { name: Node, mark: node, for: the server, used_by: [app] }
```

- `code:` is what keeps a drawing true. Every part and line that rests on code names its files, in two shapes: a
  part's `code:` maps each path to what that file does for it (`code: { src/worker.ts: the loop }`); a line's
  `code:` names the file at each end (`code: { from: src/worker.ts, to: src/db/pool.ts }`), either end optional. A path with no
  prefix is in this repo; `<alias>:<path>` is in another repo named in `sources.repos`. A path is relative to its
  repo's root: no leading `/`, no `..`. A cited folder covers every file in it. A part with no code (a person, an
  outside vendor, a product built elsewhere) has no `code:`.
- `leaves:` is `lands:` for the `from` end, when the line starts inside a window.
- Every scope but `root` is opened by exactly one part (`child:`). A scope may sit inside another scope.
- Ids are short lowercase words you choose (`app`, `db`, `w_db`). Never `__proto__`, `constructor` or `prototype`.

## sheets/<CODE>.yaml

A sheet answers one question about one scope. The code's letter is its kind's letter and the number is yours:
C conceptual, L logical, D deployment, S service, F flow, A algorithm, T landscape. Required: `sheet`, `scope`,
`kind`, `title`, and `bands` (or `lanes`, `steps` or `columns` for flow, algorithm and landscape sheets).

The landing is a sheet of scope `root`:

```yaml
sheet: C-001
scope: root
kind: conceptual
title: Acme
question: What Acme is, who uses it, and where it runs.
bands:
  - { id: people, label: Who uses it, tone: sand, row: [person] }
  - { id: hosted, label: Hosted, tone: mist, row: [app] }
show: [use]
```

A logical sheet shows what is inside one window:

```yaml
sheet: L-101
scope: app
kind: logical
title: The app
question: What runs inside the app and where it keeps its data.
bands:                              # rows, top to bottom
  - id: doors
    label: Ways in                  # sentence case, never capitals
    means: started by a request     # optional: a short line under the label
    tone: sand                      # sand, mist, stone or sage
    row: [web 6, worker 6]          # part ids left to right; "id N" spans N of 12 columns
  - id: data
    label: On disk
    tone: stone
    row: [db 4, ~ 4, cache 4]       # "~ N" is a gap of N columns; [a, b, 4] stacks a and b in one cell
    split: { before: cache, left: kept, right: "thrown away on restart" }
show: [w_db, w_cache]               # the lines drawn on this sheet, or `all`
quiet: [w_cache]                    # optional: lines whose words show only on hover
says: { w_db: writes orders }       # optional: other words for a line on this sheet only
notes:                              # optional: lettered notes on a part, a line or a hop
  a: { on: db, text: "The worker is the only writer." }
callouts: []                        # optional: { to: <part>, side, title, text }
groups: []                          # optional: { label, marks, around: [band ids] }
brace: { over: [doors], text: Node }   # optional: a bracket over bands
left: []                            # optional side columns: { label, means, tone, beside: <band id>, stack: [part ids] }
right: []
```

A flow sheet walks one request hop by hop:

```yaml
sheet: F-101
scope: app
kind: flow
title: Sign in
question: How a sign-in travels, hop by hop.
time: in order
lanes: [person, web, db]            # parts, left to right
places:                             # optional: bands over lanes
  - { label: Your browser, tone: mist, lanes: [person] }
hops:
  - { id: post, from: person, to: web, says: POST /login, flow: use, at: "1" }
  - { id: look, from: web, to: db, says: find the account, at: "2", payload: { name: query, lines: ["SELECT ... WHERE email = $1"] } }
  - { id: ok, from: web, to: person, reply: true, says: "302 and a cookie", at: "3" }
  - { id: log, on: web, do: writes the audit line, at: "4" }
```

An algorithm sheet (A) adds `endpoint`, `route`, `steps` (`id`, `do`, `code`, `if`, `no`, `yes_says`, `no_says`,
`calls`, `flow`, `says`, `end`), `request` and `response`. A landscape sheet (T) adds `columns` (`label`, `means`,
`tone`, `row` of stack ids, `says`).

## revisions/<id>.yaml: one change

One schema serves a merged pull request kept in the repo and an open pull request's change kept outside it. The
merged form:

```yaml
revision: PR-412                    # the file is revisions/PR-412.yaml
scope: app                          # the scope the change lives in; root when it spans scopes
title: The worker gets a price cache
pr: 412
repo: github.com/acme/acme
merged: 9c41e07                     # the merge commit
date: "2026-11-03"
add:
  parts: { cache: ~ }               # `~`: the part is already in system.yaml; this PR added it
  flows: { w_cache: ~ }
change:
  worker: Looks a price up in the cache before it charges.      # one sentence per changed part or line
remove:
  w_poll: { says: "The worker no longer polls.", flow: { from: worker, to: db, says: polls } }   # a removed line keeps its old ends
lines:
  worker: "worker.ts and 2 more · +120 −31"   # the diff counts per part
steps:                              # optional: the one sequence the change makes, about eight hops
  title: A price on the way to a charge
  lanes: [worker, cache, db]
  hops:
    - { from: worker, to: cache, says: look up the price, is: added }
    - { from: cache, to: worker, reply: true, says: the price, is: added }
    - { from: worker, to: db, says: write the charge, is: changed }
```

`is` is `added` or `changed`; a hop with no `is` was there before.

The open form is for a pull request that is not merged yet, so the drawing does not have its new parts. Each added
part or line is a full entry, and `place` says where each new part goes on each sheet:

```yaml
revision: PR-415
scope: app
title: Orders get a queue
pr: 415
repo: github.com/acme/acme
add:
  parts: { queue: { in: app, name: Queue, kind: store, role: Holds orders until the worker takes them., code: { src/queue.ts: the queue } } }
  flows: { w_queue: { from: worker, to: queue, says: takes the next order } }
  place: { L-101: { queue: { band: data, after: db, span: 4 } } }
change:
  worker: Takes orders from the queue, not from the database.
lines:
  worker: "worker.ts · +40 −12"
```

## Words

- Sentence case everywhere. No capitals for emphasis, no letterspaced labels.
- No process words on a sheet: nothing like "checked against", "drawn by", "curated", "sample", "TODO".
- No performance numbers (latency, rates, sizes of traffic) and no invented counts. A count goes on a sheet only when
  one cited file gives it exactly; when in doubt, leave the count out.
- Something that is configured off, retired or removed is not drawn as live. Off by default is drawn with "off" in
  its `sub` or its band's `means`, and the file the switch lives in is in its `code:`.

## Removed keys

The loader refuses these and says why: `sample`, `record`, `history`, `prs`, `issues`, `threads`, `charts`,
`figures`, `rate`, and on a revision `state`, `author`, `age`, `workspace` and `by`.
