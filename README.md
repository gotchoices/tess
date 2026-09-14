# Tess

*From Latin "tessera" — a ticket or token.*

Tess is a lightweight, agent-driven ticketing system for software projects. It provides a structured pipeline where AI coding agents (Claude, Cursor, Augment, Codex) process tickets through workflow stages — from triage through implementation and review to completion.

When using the Codex adapter, `codex-cli` must be version `0.112.0` or newer.

Tess lives as its own repository and integrates into any project, giving every repo the same ticket pipeline without duplicating code.

## How It Works

Tickets are markdown files organized into stage folders inside a project's `tickets/` directory. Each ticket file is named with an optional sequence prefix (`3-my-feature.md` — lower runs sooner) and contains a lightweight metadata header followed by architecture notes and TODO items. The sequence prefix is optional; unnumbered tickets follow after all numbered ones in a stage.

A runner script processes tickets one at a time, invoking an AI agent for each. The agent owns the full stage transition: it creates the next-stage file(s), deletes the source ticket, and commits. The runner chooses what to work next under one of three strategies — **live** (default; re-discover and re-prioritize the whole board after every transition, picking up tickets created mid-run), **batch** (snapshot at startup; drain stage-by-stage), or **chase** (snapshot at startup; follow one ticket through every stage before moving to the next). See [Strategies](#strategies) below.

```
tickets/
├── backlog/       # Parked specs — not yet ready to work
├── fix/           # Bug triage and reproduction
├── plan/          # Feature design and research
├── implement/     # Ready for implementation
├── review/        # Code review and validation
├── complete/      # Archived completed work
├── blocked/       # Parked — spec proposals and external dependencies
├── releases.md    # Optional ordered release list (see Releases)
├── AGENTS.md      # Points to tess agent rules
├── CLAUDE.md      # Points to tess agent rules
├── .version       # Ticket format version (managed by tess)
├── .logs/         # Agent execution logs (git-ignored)
└── .in-progress   # Current ticket state for resume (git-ignored)
```

## Quick Start

### 1. Install tess into your project

```bash
# Git submodule:
git submodule add https://github.com/gotchoices/tess.git tess
node tess/scripts/init.mjs

# Git subtree (works with git worktrees; submodules do not):
git subtree add --prefix=tess https://github.com/gotchoices/tess.git main --squash
node tess/scripts/init.mjs

# Symlink (tess cloned elsewhere):
node /path/to/tess/scripts/init.mjs
```

This creates the `tickets/` folder with stage subdirectories and connects tess's agent rules into your project.

### 2. Create a ticket

Drop a markdown file into `tickets/fix/`, `tickets/plan/`, or `tickets/backlog/`:

```
tickets/plan/3-user-auth.md
```

```markdown
description: Add JWT-based authentication
prereq: session-store, user-model
files: src/server.ts, src/middleware/auth.ts
----
Design a JWT auth flow with refresh tokens.

- Access tokens: short-lived (15min)
- Refresh tokens: long-lived, stored httpOnly
- Middleware to protect routes

TODO
- Define token schema and expiry strategy
- Implement login/refresh endpoints
- Add auth middleware
- Write integration tests
```

`prereq:` lists slugs of other tickets that must land (advance stage) first — no sequence prefix, no `.md` extension, since the sequence can change. The runner topologically sorts each stage to respect these edges and errors on cycles or sequence numbers that violate them.

**Cross-stage prereqs.** Prereqs are resolved across the whole pipeline, not just the current stage. The runner ranks stages as `backlog (0) < fix = plan (1) < implement (2) < review (3) < complete (4)` and treats a prereq as *satisfied* only when it sits in a strictly later rank than its dependent (same-stage ordering is enforced by topo sort). Practical effect:

- Prereq still in an earlier stage, in a peer-but-different stage (e.g. dependent in `plan/` with prereq still in `fix/`), or parked in `blocked/` → the dependent is **deferred** for this run and any sibling listing it as `prereq:` is deferred too. The cascade is transitive through the queue.
- Prereq deferred to a later release than its dependent (filed in a `backlog/<CODE>/` folder further down `tickets/releases.md`) → the dependent is **deferred** whatever the stages, and the runner says which ticket to move. See [Releases](#releases).
- Prereq slug not on the board but carrying a **tombstone** in `tickets/.pruned-tickets.jsonl` → it completed and was later swept out of `complete/` (see [Pruning Completed Tickets](#pruning-completed-tickets)). Satisfied, and the runner says so — `prereq "<slug>": completed <date>, pruned` — in the dry-run listing, the run log, and the agent's prompt, so a landed prereq never reads as missing work.
- Prereq slug matching neither the board nor a tombstone is **unknown**: still assumed already complete and ignored (a stale reference, or work that predates the tombstone ledger), but reported rather than silently dropped, since it is the one case nothing can vouch for.

Agents do **not** need to mirror this state by hand — `blocked/` is reserved for human sign-off and missing external code, never for "my prereq isn't done yet." See `agent-rules/tickets.md` for the agent-facing rule.

Pass `--skip-blocked` to pre-filter the snapshot: any ticket whose prereq chain transitively reaches a slug in `blocked/` is dropped before the run starts, so it never appears in the dry-run listing or the live banner. This is a stricter, upfront filter — the runtime cross-stage gate still handles the broader cases (prereq still in plan, peer-stage mismatch, etc.) by deferring at the moment of processing.

### 3. Run the pipeline

```bash
# See what would be processed
node tess/scripts/run.mjs --dry-run

# Process all tickets
node tess/scripts/run.mjs

# Only specific stages
node tess/scripts/run.mjs --stages fix,implement

# Cap each stage to its own max sequence (work only the earliest slots)
node tess/scripts/run.mjs --stages fix:15,plan:15,implement:12,review:10

# Include backlog for a promote-from-backlog pass (not in the default set)
node tess/scripts/run.mjs --stages backlog:15

# Use a different agent
node tess/scripts/run.mjs --agent cursor

# Chase a ticket through every stage before moving on
node tess/scripts/run.mjs --strategy chase
```

### Options

| Option | Default | Description |
|---|---|---|
| `--max-sequence <n>` | _unlimited_ | Default sequence ceiling for all stages (sequences can include decimals). Unnumbered tickets are skipped whenever this is finite. |
| `--stages <list>` | `review,implement,fix,plan` | Stages to process, with optional per-stage max (`implement:12,review:10`). The order is the cross-stage priority (earlier = higher). `backlog` is a valid target but excluded from the default set. |
| `--agent <name>` | `claude` | Agent adapter: `claude`, `cursor`, `auggie`, or `codex` |
| `--strategy <name>` | `live` | Selection strategy: `live`, `batch`, or `chase`. See [Strategies](#strategies). |
| `--max <n>` | _unlimited_ | Stop after processing at most n tickets (with `live`, caps stage transitions rather than snapshot size) |
| `--token-budget <n>` | _unset_ | Soft per-ticket context budget (claude only). When the running context size crosses *n* tokens, a one-shot `BUDGET_WARNING` is injected via a PreToolUse hook so the agent splits residual work into continuation tickets. See [Token Budget](#token-budget). |
| `--no-commit` | — | Skip automatic git commit after each ticket (also skips the migration commit) |
| `--dirty-tree <mode>` | `salvage` | What to do when the working tree is already dirty before a ticket starts: `salvage` (commit the leftovers first, under their own name), `abort` (refuse to start, exit 1), or `ignore` (proceed anyway). See [Clean Working Tree](#clean-working-tree). |
| `--skip-blocked` | — | Pre-filter the snapshot: drop any ticket whose prereq chain reaches a slug parked in `blocked/`. The runtime cross-stage prereq gate still applies to other misses. |
| `--refresh-index` | — | Run the local code indexer incrementally before each ticket. No-op if `tickets/.index/` does not exist. See [Local Code Search](#local-code-search-optional). |
| `--prune-completed-days <n>` | `30` | Remove completed tickets whose landing commit is older than *n* days. Runs once per run. See [Pruning Completed Tickets](#pruning-completed-tickets). |
| `--no-prune-completed` | — | Skip the stale-completed-ticket sweep entirely. |
| `--dry-run` | — | List tickets without invoking the agent |

### Init Options

| Option | Default | Description |
|---|---|---|
| `--ignore-stages` | — | Add ticket stage folders (fix/, plan/, etc.) to .gitignore |
| `--no-ignore-stages` | — | Keep ticket stage folders tracked in git |
| `--with-search` | — | Wire the MCP code-search server for the chosen agent |
| `--no-search` | — | Skip the MCP code search prompt |
| `--with-commit-hook` | — | Install a post-commit hook that refreshes the index after every commit |
| `--no-commit-hook` | — | Skip the commit-hook prompt |
| `--agent <name>` | `claude` | Target agent for `--with-search`: `claude`, `cursor`, `codex`, `auggie` |

When neither flag is passed, init will prompt interactively. The default is to **not** ignore stage folders. Use `--ignore-stages` when each developer maintains separate tickets that shouldn't be committed to the shared repo.

## Strategies

The runner picks the next ticket to work using a strategy. All three strategies share the same agent invocation, logging, and commit pipeline — they differ in how they choose the next ticket. `live` reassesses the board continuously; `batch` and `chase` traverse a snapshot frozen at startup.

### `live` (default)

After **every** stage transition, live re-discovers the entire ticket board from disk and re-applies the priority policy, then runs the current highest-priority ticket. The policy is the same one `batch` uses — cross-stage order from `--stages` (default `review,implement,fix,plan`: drive in-flight work toward done before opening new work), and within each stage prereqs before dependents then lower sequence first — but it is re-evaluated each iteration instead of once.

Because it reads disk every iteration, a ticket created mid-run is picked up the same run: a `review` that files a `fix` sees that fix jump to the front (fix is highest-priority) and resolved next; a `plan` that splits into several `implement` tickets sees them ranked in immediately. A ticket whose prereq is still *behind but advancing* is skipped only for the current pass and becomes selectable the moment its prereq moves forward — so an entire prereq chain can drain in one run. Whatever the reason a ticket is skipped in a pass, a dependent in the same stage is skipped with it, so it never runs ahead of work that has not landed.

A slug that errors, times out or is not runnable (see [Releases](#releases)) is excluded for the rest of the run (next run resumes an interrupted one via its resume note), and its dependents stay gated behind it — including a dependent in the same stage, which the stage-rank gate alone would let through. A per-slug transition cap (12) and a global run cap backstop an agent that regresses or re-spawns a ticket in a loop. `--max <n>` caps the number of transitions (not a snapshot length).

Best for: unattended runs that should clear the whole pipeline — including the follow-up work earlier stages generate — in a single invocation, always working the most important thing next.

### `batch`

Snapshot the ticket list at startup, then drain each stage in topo/sequence order: every snapshotted ticket advances exactly **one** stage per run, and tickets created during the run roll into the next run. The pipeline-wide order is `--stages` (default `review,implement,fix,plan`); within each stage, prereqs come before dependents and lower sequences come first.

Best for: steady, reviewable progress with a fixed, predictable batch per run. Each run produces a clean one-transition-per-ticket diff so you can inspect what each stage did before the next pass.

### `chase`

Pick one root ticket and follow it through **every** stage to `complete/` before moving to the next root. Ticket-major instead of stage-major.

After each stage transition, chase looks up the same slug in any forward-ranked stage (an agent is free to jump straight from `fix/` to `review/` when no separate implementation pass is needed), then in `blocked/` and `backlog/`. It does **not** rely on a filesystem diff — other agents may be modifying `tickets/` in parallel. If the slug landed somewhere past its current stage, the chase continues from there; if it landed in `blocked/` or `backlog/`, the chain ends and the slug is recorded as **deferred** for the rest of the run.

**Deferral cascade.** A slug enters the run's deferred set when the agent moves it to `blocked/` or `backlog/`, when the cross-stage prereq gate rejects it because a prereq is still behind, when the ticket is not runnable (see [Releases](#releases)), *or* when the agent errors on it. A queued root that lists a deferred slug as `prereq:` is skipped — and the skipped root is itself added to the deferred set, so the skip cascades transitively through the queue. The same cascade applies in `batch` mode. This prevents tess from charging into work whose prerequisite just bounced, hasn't caught up, or failed — without throwing away independent work elsewhere in the queue. Any agent errors collected during the run surface as a non-zero exit code once the runner finishes the rest of the snapshot.

**Splits.** If an agent splits one ticket into multiple next-stage tickets, chase follows the same-slug branch and leaves the siblings in place for the next run.

**Safety cap.** A single chain is bounded to 6 stage transitions, in case an agent regresses a ticket (e.g. `implement` → `plan`) and creates a loop. The natural pipeline tops out at 4 (`backlog → plan → implement → review → complete`).

Best for: focused work on a single feature, or when you want fewer parallel work-in-progress trails in git history.

```bash
# Default — live: reassess the board after every transition
node tess/scripts/run.mjs

# Snapshot at startup, drain stage by stage
node tess/scripts/run.mjs --strategy batch

# Follow each root ticket all the way through
node tess/scripts/run.mjs --strategy chase

# Live, but stop after 3 transitions
node tess/scripts/run.mjs --max 3
```

## Token Budget

A long-running ticket can outgrow the model's context window mid-task, leaving an interrupted commit that is awkward to resume from. The `--token-budget <n>` flag (claude only) gives you a soft cushion: the runner watches Claude's per-turn context size and, when the threshold is crossed, injects a one-shot `BUDGET_WARNING` through a PreToolUse hook. The agent's instructions (in `agent-rules/tickets.md`) tell it to stop investigating, capture remaining TODOs as continuation ticket(s) in the **same** stage, delete the source ticket, and exit cleanly.

```bash
# Suggested starting point — claude's context is 200k.
node tess/scripts/run.mjs --token-budget 160000
```

The warning is purely advisory; the agent stays in control. After the agent splits and the runner commits, behavior depends on strategy:

- **live** re-discovers the board and picks up the new same-stage continuations immediately, ranked against everything else.
- **chase** picks up the new same-stage continuations as part of the current chain (depth-first, before advancing the original slug forward).
- **batch** lets the continuations roll into the next run, preserving the snapshot-once-per-run guarantee.

The budget applies per ticket — every new ticket invocation starts from zero.

## Pruning Completed Tickets

`complete/` is an archive of finished work, and left alone it grows without bound. At the start of every run (before snapshotting), the runner removes completed tickets that landed more than 30 days ago and commits the deletion as `tess: prune <n> completed ticket(s) older than <d> days`.

Age is measured by each file's most-recent **git commit timestamp**, not its filesystem mtime — a checkout rewrites mtimes, but the commit date reflects when the ticket actually reached `complete/`. Untracked completed tickets (no commit history) are left alone since they can't be dated. Because pruning is a tracked deletion, anything removed stays recoverable from git history.

```bash
# Keep a 90-day archive instead of the default 30
node tess/scripts/run.mjs --prune-completed-days 90

# Turn the sweep off
node tess/scripts/run.mjs --no-prune-completed
```

`--dry-run` reports what the sweep would remove without deleting anything (and writes no tombstones). The sweep also honors `--no-commit` (deletes the files but leaves the commit to you).

**Tombstones.** Deleting a completed ticket also deletes the board's only evidence that the work landed: every `prereq:` naming that slug becomes unresolvable, and a *completed-and-pruned* prereq then reads exactly like one that never existed. So before each removal the sweep appends one record per ticket to `tickets/.pruned-tickets.jsonl`:

```json
{"slug":"session-store","file":"3-session-store.md","completedAt":"2026-01-02","commit":"<sha>","prunedAt":"2026-02-04T10:11:12.000Z"}
```

The ledger is git-tracked (that is the whole point — it outlives the ticket) and strictly append-only: a prune costs one append regardless of ledger size, and two branches that both pruned merge by union instead of conflicting. `completedAt` and `commit` come from the ticket file's last commit, so the record answers "did this land, and when?" without a `git log` dig. Malformed lines are skipped on read; a slug appearing twice (a ticket reopened, re-completed and re-pruned) resolves to the record with the **latest `completedAt`** — not to the last line, because a union merge and the backfill below both put records into the file out of chronological order.

**Backfilling a pre-ledger history.** A project that pruned before it had a ledger has no tombstones for that older work, so every `prereq:` naming it still reads as unknown. Nothing is lost, though — a prune is its own commit, and the commit says what it deleted — so the records can be reconstructed from git history once:

```bash
# Rehearse: report what would be appended, write nothing
node tess/scripts/backfill-tombstones.mjs --dry-run

# Append the reconstructed records
node tess/scripts/backfill-tombstones.mjs
```

For every commit whose subject starts `tess: prune `, the backfill reads the tickets that commit deleted and dates each one from the last commit to touch it beforehand — the same two values a live sweep records. It is idempotent: a record is skipped whenever its `(slug, landing commit)` pair is already in the ledger, so sweeps that wrote their own tombstones contribute nothing and a second run appends zero. `--project <dir>` points it at a project other than the working directory, `--ref <rev>` scans sweeps reachable from something other than `HEAD`. Two ticket files that differ only by sequence prefix (`3-x.md`, `4-x.md`) are one slug, so a sweep that removed both leaves one tombstone.

## Releases

Everything not explicitly deferred is due in the **current** release. Tess reads the releases from one optional file, `tickets/releases.md`, and reads what is deferred from where a ticket sits: a ticket in `backlog/<CODE>/` is deferred to release `<CODE>`, and every other ticket is current.

### The release list

```markdown
# Releases

Optional preamble prose — ignored, and kept as-is when tess rewrites the file.

## BETA
due: 2026-11-01

Free-form exit criteria: any markdown except a level-2 heading.

## GA

Exit criteria.
```

The file is a line grammar, not a general markdown document:

- Every line starting `## ` outside a fenced code block starts an entry, and its heading text is the release **code**. A code is an uppercase letter followed by 1–7 uppercase letters or digits (`BETA`, `GA`, `V2`) — no hyphens.
- The first non-blank line after a heading may be `due: YYYY-MM-DD` (field name in any case, like a ticket header field), which must be a real calendar date. Every other line is exit-criteria text.
- The first entry is the **current** release; the entries below it are later releases, in order.

**No `releases.md` → the release model is off.** Sub-folders of `backlog/` are plain human-curated folders and nothing about them is validated; a `target:` header makes a ticket not runnable. **`releases.md` present → the model is on**, even when it lists no releases. An empty list means everything is current, so every backlog sub-folder is then an error.

### Deferral folders

With the model on, each sub-folder of `backlog/` must be named after a listed code other than the current one: `backlog/GA/` holds work deferred to `GA`. Current work lives at `backlog/` top level and in every other stage. Tess reads the tickets directly inside a folder and nothing deeper.

The runner never works a folder ticket — `--stages backlog` processes the top level only — but folder tickets are on the board for prereq resolution, with or without `releases.md`, so a `prereq:` naming one resolves to where it sits instead of reading as unknown.

### Startup board check

Before anything runs, `--dry-run` included, the runner checks the board against the list. Any error is printed and the runner exits 1, as it does for a prereq cycle:

- a `releases.md` problem — a malformed code, a code listed twice, a malformed or impossible `due:` date — named with its line number;
- a backlog sub-folder that is not a listed code; matching is exact and case-sensitive, so `beta/` is not `BETA`, even on Windows;
- a backlog sub-folder named after the current release — current tickets live directly in `backlog/`;
- the same slug filed in two places across `backlog/` and its sub-folders (checked with or without `releases.md`);
- a malformed [project rules](#project-rules) addendum in `tickets/rules/`.

Warnings are printed and the run continues: a directory nested inside a release folder (tess ignores it), and any ticket whose prereq is deferred to a later release than the ticket itself — including a folder ticket, which the runner would otherwise never mention. The check runs once per run, not between tickets.

### Prereqs into a later release

A prereq deferred to a later release than its dependent cannot land first, so it defers the dependent whatever their stages. The run log, the dry-run and the startup warning give the same message, naming which ticket to move:

```
prereq "session-store" is deferred to release GA (backlog/GA/) but this ticket is due in BETA — pull the prereq into backlog/ or defer this ticket to backlog/GA/
```

### `target:` and not-runnable tickets

A ticket's location already says its release, so the `target:` header is normally left off. When present it must agree with the location. If it does not, the ticket is **not runnable**: the runner logs `Not runnable <stage>/<file>:` with one line per problem, runs no agent, commits nothing, and leaves the ticket where it is so its dependents defer (`batch` and `chase` defer the slug; `live` excludes it for the rest of the run). `--dry-run` prints the same problems as `⚠ not runnable:` lines. The problems are:

- `target:` on any ticket when `releases.md` does not exist;
- `target:` naming a code the list does not have;
- a ticket in `backlog/<CODE>/` whose `target:` names a different release;
- a ticket anywhere else whose `target:` names a later release than the current one.

A ticket with no anchor is not runnable in the same way — see **Anchor** under [Ticket Format](#ticket-format).

### Shipping a release

```bash
node tess/scripts/release.mjs ship --dry-run   # print what shipping would do; change nothing
node tess/scripts/release.mjs ship             # ship and commit
```

Shipping makes the next release current. Run from the project root, `ship`:

- moves each ticket directly inside `backlog/<NEXT>/` up to `backlog/`, keeping its filename, and removes the emptied folder. Tracked tickets move with `git mv`, so the commit records renames; moved any other way, a large folder reads as that many deletions and trips the mass-deletion guard every tess commit goes through;
- removes each `target: <SHIPPED>` header line from tickets in every stage except `complete/`, which is an archive. Only a line inside the header counts; body text is never touched. `target: <NEXT>` lines stay, because they now name the current release;
- removes the first entry from `releases.md`, leaving the preamble and every other entry byte-for-byte as they were;
- commits the result as `tess: ship release <SHIPPED>`.

It changes nothing and exits 1 when `releases.md` is absent, lists no releases, or has errors; when `backlog/<SHIPPED>/` exists; or when a ticket in `backlog/<NEXT>/` would collide with one at the top level — the same filename, or the same slug under any sequence prefix. Collisions compare ignoring case, because on a case-insensitive filesystem one file would overwrite the other. It also refuses a dirty working tree, since the commit captures the whole tree; `--no-commit` skips both that check and the commit.

Anything in `backlog/<NEXT>/` that is not a ticket — a non-`.md` file, a directory — is not moved, so the folder stays and `ship` lists what is left in it. The startup board check rejects a folder named after the current release, so move or delete those entries before the next run.

`releases.md` is rewritten last. A ship interrupted part-way leaves the list still naming the shipped release as current, and planning again finds only the work left: tickets already moved are no longer in the folder, and stripped lines are gone. The interruption leaves the tree dirty, so finish with `ship --no-commit` and commit the result.

Tess rewrites nothing outside `tickets/`. A tool that tags other files with release codes does its own strip; `ship` prints the shipped code, and the commit subject names it.

## Backlog Gardening

Every processing stage generates backlog tickets, but `backlog/` drains only through a human — left alone it grows into a flat list that's expensive to triage. The **gardener** is a dedicated agent pass that turns that queue into fewer, better-ranked decisions:

```bash
node tess/scripts/garden.mjs                          # consolidate, backfill headers and anchors, rank, propose declines
node tess/scripts/garden.mjs --feedback decisions.md  # also execute declines/promotions/deferrals from a file
node tess/scripts/garden.mjs "decline the two CLI cosmetic bugs; defer the sync cluster to GA"
node tess/scripts/garden.mjs --dry-run                # print the grouped inventory and board check, invoke nothing
```

The gardener reads the whole backlog, sub-folders included, grouped by [release](#releases): the top level of `backlog/` (current work), then each release folder in `releases.md` order, then any other folder. It also runs the [startup board check](#startup-board-check), but unlike the runner it does not stop on errors: it hands them to the agent, which reports them and leaves the folders alone, because fixing them is a human's call.

What it does (rules in `agent-rules/garden.md`):

1. **Backfill** — every backlog bug gets `severity:` / `likelihood:`; every backlog ticket gets `tradeoffs:` (the honest one-sentence decline argument), derived from the ticket body and the code it references. Every backlog ticket also gets an **anchor** (see [Ticket Format](#ticket-format)): a project-declared field such as `features:` when the body names that kind of thing, otherwise `architecture:` naming the document the work touches. The gardener never invents a code; a ticket nothing fits is listed for the human instead.
2. **Merge & cluster** — duplicates fold together; several tickets that are symptoms of one underlying weakness become a single **theme ticket** whose deliverable is the invariant that retires the class (a type change, a property test, a boundary assertion), with the instances kept as evidence arms. Merges stay within one place, since a merge across folders would move work between releases.
3. **Rank** — release first (the top level before any release folder, folders in `releases.md` order), then severity × likelihood, then cost (`difficulty:` and the size of the change). Only top-level tickets get sequence prefixes, because the runner never promotes a folder ticket. The full ranked picture, grouped by release, goes to `tickets/.garden-report.md` (tracked, overwritten each pass).
4. **Propose declines** — a top-level ticket that has waited `--decline-after-days` (default 60) or longer is listed under *Propose decline* with its age and the reason from its `tradeoffs:` line. Age is days since the ticket arrived at the top level of `backlog/`, read from a single `git log` over `tickets/backlog`: a re-sequence keeps it, arriving from a release folder or from another stage restarts it, and an uncommitted ticket reads `new` and is never proposed. Nothing is declined without feedback.
5. **Execute feedback** — only with explicit human feedback:
   - **Decline** — the ticket is deleted **and** recorded as an accepted-tradeoff `NOTE:` comment at the code site, so future reviewers don't re-discover and re-file the finding.
   - **Promote** — the ticket moves to `plan/` (or `fix/`).
   - **Defer** — the ticket moves into `backlog/<CODE>/`. The code must be listed in `releases.md`; a request naming any other code is reported as unresolvable and nothing moves.
   - **Pull forward** — a folder ticket moves up to `backlog/`.

   Without feedback the gardener never declines, promotes, defers or pulls forward — those calls stay human.

Options: `--agent` (default `claude`), `--difficulty` (model tier, default `hard`), `--decline-after-days` (default `60`), `--token-budget`, `--no-commit`, `--dry-run`. The pass commits as `tess: garden backlog (<n> removed, <m> added, <k> updated)`, counting removals and additions by slug across `backlog/` and its sub-folders, so neither a re-sequence nor a move between folders reads as churn. It reconciles the working tree first (see [Clean Working Tree](#clean-working-tree)) so leftovers do not land under that message.

## Local Code Search (optional)

Tess can build a local vector index of the repository and expose it to the agent as an MCP `search_code` tool.  No API keys, no network calls after the first model download.

Three pieces, each independent:

1. **Indexer** — `node tess/scripts/index.mjs` walks `git ls-files`, chunks each file, embeds the chunks with a local code-aware embedding model (`jinaai/jina-embeddings-v2-base-code`, 768-dim, ~155MB quantized on first run), and stores vectors in `tickets/.index/index.db` (sqlite + sqlite-vec).  Incremental by content hash — re-running on a typical diff is sub-second.  If you have an existing index from the legacy MiniLM model, the indexer will refuse to open it and point you at `--rebuild`.
2. **MCP server** — `tess/scripts/mcp-search.mjs` is a stdio MCP server exposing `search_code`, `find_references`, and `read_chunk` against the same DB.  Started by the agent, dies with it; nothing runs in the background between invocations.
3. **Per-agent config** — `init` writes the right MCP config for the chosen agent (Claude `.mcp.json`, Cursor `.cursor/mcp.json`, codex sample TOML).

### Enable it

```bash
node tess/scripts/init.mjs --with-search --agent claude
```

That single command writes the MCP config, runs `npm install` inside `tess/`, builds the initial index (the first run downloads a ~155MB embedding model), and appends a `## Code search (tess)` section to your project's root `AGENTS.md` so any agent — not just the tess runner — is pointed at the index.  Re-running is safe and incremental.

### Keep it fresh

```bash
node tess/scripts/index.mjs                    # incremental refresh
node tess/scripts/index.mjs --watch            # debounced fs watcher
node tess/scripts/index.mjs --status           # row counts + last refresh
node tess/scripts/index.mjs --config           # show effective filter config
node tess/scripts/index.mjs --rebuild          # full rebuild
node tess/scripts/run.mjs --refresh-index ...  # refresh between every ticket
```

For hands-off freshness, pass `--with-commit-hook` to `init.mjs` (or accept the prompt).  This installs a `.git/hooks/post-commit` that fires the indexer in the background after every commit — the commit feels instant; the index trails by a second or two.  Remove the `# >>> tess search index >>>` block from the hook to disable.

All artifacts live under `tickets/.index/` (gitignored).  Full uninstall: delete that folder and remove the `code-search` entry from your agent's MCP config.

### Customize what gets indexed

By default the indexer skips `node_modules/`, `dist/`, `build/`, `.git/`, `tickets/`, `team/`, `docs/`, plus a handful of cache folders, and indexes a fixed list of source extensions. The `docs/` and `team/` defaults exist because long-form prose dominates the embedding signal vs. actual code, dragging down the rankings of real source matches.

To override either set, create `tickets/index-config.json`:

```json
{
  "exclude":    ["examples/", "vendor/"],
  "include":    ["docs/architecture/"],
  "extensions": [".graphql", ".proto"]
}
```

- `exclude` — additional directory prefixes to skip (joined with the defaults).
- `include` — re-include a path under an otherwise-excluded directory. Checked before `exclude`, so e.g. `docs/architecture/` lets you index that subtree while leaving the rest of `docs/` out.
- `extensions` — additional file extensions beyond the built-in source list (lowercase, leading dot optional).

All entries are directory-prefix matches (trailing `/` added if missing) — same semantics as the built-in excludes, applied to `git ls-files` output. Inspect the merged result any time with `node tess/scripts/index.mjs --config`. Edits take effect on the next refresh; no rebuild needed.

The config is also visible (and the only way to change it is by hand on disk) from the dashboard's Index page at `/index`.

### Query from the command line

`tess/scripts/search.mjs` is a thin CLI over the same index, sharing all ranking and formatting logic with the MCP server — useful for ad-hoc exploration without an agent in the loop.

```bash
# Semantic search (default mode)
node tess/scripts/search.mjs "where do we evict pages from the buffer pool"
node tess/scripts/search.mjs -k 5 --path "packages/lamina-substrate/%" "page eviction"

# Literal search; "|" ORs alternatives
node tess/scripts/search.mjs --refs "composeNewSlot|defaultComposeNewSlot"

# Read a line range (handy for expanding a snippet you just got back)
node tess/scripts/search.mjs --read packages/lamina/src/index.ts:120-160

# JSON output for piping into jq / scripts
node tess/scripts/search.mjs --json "page eviction" | jq '.matches[0].path'
```

The script has a shebang and is marked executable, so on Unix you can also invoke it directly (`./tess/scripts/search.mjs "..."`). After `npm install` inside `tess/`, the bin entry exposes it as `tess-search` (use `npx tess-search` from the project root, or symlink it onto your `PATH`). Exit codes: `0` on hits, `1` on no hits, `2` on usage / missing-index errors.

## Ticket Lifecycle

```
backlog/ ─→ plan/ ─┐
                   ├─→ implement/ ──→ review/ ──→ complete/
            fix/ ──┘
                   ↕
               blocked/
```

- **backlog** — Parked specifications that aren't ready to work yet (promoted to `plan/` when ready)
- **fix** — Reproduce a bug, research cause, output implementation ticket(s)
- **plan** — Design a feature, resolve questions, output implementation ticket(s)
- **implement** — Build it, ensure tests pass, output review ticket
- **review** — Inspect code quality and hygene, verify tests, update docs, output complete ticket
- **complete** — Archived summary of finished work
- **blocked** — The human's inbox: proposed text where the specification or architecture is silent or contradictory, plus dependencies outside this repo. Not for "a sibling ticket isn't done" — that's `prereq:`.

## Ticket Format

```markdown
description: <brief description>
prereq: <slugs of other tickets that must land first — comma-separated, no prefix, no .md>
architecture: <anchor: repo-relative architecture document path, optionally #section — or a field declared in tickets/rules/>
files: <optional list of relevant files>
difficulty: <optional: easy | medium | hard — defaults to medium>
target: <optional: a release code from tickets/releases.md — normally omitted; the ticket's location already says its release>
severity: <backlog bugs: corruption | wrong-result | edge-case | cosmetic>
likelihood: <backlog bugs: normal-use | unusual | contrived>
tradeoffs: <backlog tickets: one sentence on why a maintainer might decline or defer this>
----
<Architecture description — prose, diagrams, interfaces/types>

<TODO list of sub-tasks, organized by phase if needed>
```

**Header fences.** The header is the field block above the body. A **fence** is a line of three or more dashes and nothing else, and the parser accepts every shape found in practice: a closing fence only (as above), an opening *and* closing pair (`----` … `----` or YAML-style `---` … `---`), or no fence at all. If the first line is a fence the header starts after it; the header then ends at the next fence, or at end-of-file if there is none.

Two consequences: in an unfenced ticket a `---` horizontal rule in the prose ends the header, and any line inside the header region beginning with a header field name is read as a field regardless of intent. An empty field (`prereq:` with nothing after it) is valid and parses as absent.

**Filename convention:** `<slug>.md` with an optional `<sequence>-` prefix where lower sequence runs sooner (integer or decimal, e.g. `3-my-feature.md` or `3.5-my-feature.md`). The sequence number is not part of the ticket's identity — reference tickets by slug only in `prereq:`.

**Backlog prefixes.** `backlog/` is the one stage that mixes kinds of work, so prefix each backlog ticket's slug with its kind — `bug-`, `feat-`, or `debt-` (e.g. `feat-export-csv.md`). The prefix is part of the slug and travels with the ticket for its whole life, so there's no need to strip it on promotion (`fix/bug-export-csv` is fine). Decisions aren't prefixed — they go to `blocked/`. When `tickets/releases.md` exists, sub-folders of `backlog/` are release deferral folders, one per listed code (see [Releases](#releases)); without it they are a human-curated convenience. Agents don't create them.

**Difficulty (`easy` | `medium` | `hard`, default `medium`):** a portable, agent-agnostic estimate of how much horsepower a ticket needs. The runner maps it — together with the pipeline stage and per-agent config — to a concrete model and reasoning-effort. See [Model & Effort Selection](#model--effort-selection). Reserve `hard` for genuinely demanding work (it selects the strongest, most expensive model) and `easy` for mechanical changes.

**Target (`target:`, optional):** the release a ticket is due in. Normally omitted — a ticket's location already says it (see [Releases](#releases)). When present it must agree with that location, or the runner treats the ticket as not runnable.

**Anchor (`architecture:`, or a field the project declares):** every ticket names at least one part of the specification it serves. Tess owns `architecture:` — repo-relative paths to architecture documents, each optionally with a `#section` slug, conventionally under `docs/` (`architecture: docs/terrain.md#brush-pre-warm`); a project adds fields such as `features:` through [Project Rules](#project-rules). An anchor field may hold one value, a comma list, `[a, b]`, or indented `- item` lines under an empty field; an empty field or `[]` does not count. A ticket the runner is about to work with no anchor is **not runnable**: it logs `Not runnable <stage>/<file>:` with `no anchor — …`, runs no agent and commits nothing (see [`target:` and not-runnable tickets](#target-and-not-runnable-tickets)). Tickets in `blocked/` and `complete/` are never worked, so never checked. Tess checks only that an anchor is present, not that its path or section exists: resolving a section would mean reimplementing a markdown renderer's heading-slug rules, and a project's own link checker catches dangling paths better.

## Project Rules

A project can append its own rules to every agent prompt, and declare more header fields that count as an anchor, without editing tess. Each `.md` file directly inside `tickets/rules/` is one **addendum**. Addenda are read in code-unit filename order (`10-a.md` before `9-b.md`, uppercase before lowercase); sub-folders and other files are ignored.

```markdown
---
anchor-fields: features, aspects
---
Rule text appended to every ticket prompt.
```

- **Declaration header.** A file declares something only when its first line is a fence (`---` or longer). The header then runs to the next fence, by the same rules as a ticket header, and the body is everything after it. A file whose first line is not a fence is all body and declares nothing, so leading prose is never read as fields.
- **`anchor-fields:`** is the one header field tess reads: ticket header fields that count as an anchor besides `architecture:`, written as a comma list, `[a, b]`, or indented `- item` lines. Each name is a lowercase letter followed by lowercase letters, digits or hyphens. A field listed by two addenda counts once. Tess ignores every other header field, so other tools can keep their settings in the same header.
- **Stage blocks.** A body may use the `<!-- stage:NAME -->` … `<!-- /stage -->` blocks of `agent-rules/tickets.md`, filtered the same way: a ticket's prompt keeps the block for its stage and drops the others. As in `tickets.md`, a body that has blocks but none for the ticket's stage is kept whole, markers included — so when a rule must stay out of some prompts, give every stage the runner works a block (an empty one is fine).
- **Where addenda appear.** In a ticket prompt, each addendum follows the core workflow rules under a `## Project rules (tickets/rules/<name>)` heading. The gardener's prompt carries them after the shared conventions with every stage block stripped. An addendum with no text left after filtering — a declaration-only file — adds no heading. The pre-existing-failure triage prompt names the accepted anchor fields for any `fix/` ticket it files. Every prompt carries every addendum, so keep them to a few lines.
- **Errors.** An opening fence with no closing fence (`unterminated header`), a malformed field name, `architecture` listed again, or a `tickets/rules` file where the folder should be is a [startup board error](#startup-board-check): the runner prints it and exits 1 before any agent runs, `--dry-run` included. The board check does not run again between tickets, so a ticket that an addendum broken mid-run leaves without an anchor lists those errors under its `Not runnable` line.

Without a `tickets/rules/` folder, prompts are unchanged and `architecture:` is the only anchor field.

## Model & Effort Selection

Tickets carry only a portable `difficulty:`; the concrete **model** and **reasoning-effort** are API-specific, so they live in a tess-level config (`tess/config/agents.json`) keyed per agent rather than on the ticket. Each agent adapter resolves them at invocation time, so the same `difficulty` notion works across `claude`, `codex`, `cursor`, etc. — each using its own model names and effort vocabulary.

The selection has a compact base rule plus sparse per-cell overrides:

- **Difficulty picks the model tier** — so the strongest model is reserved for the hardest tickets.
- **Stage picks the effort** — `implement` runs hottest, the rest a notch lower.
- **`overrides[stage][difficulty]`** pins a specific cell's model and/or effort when the base rule doesn't fit.

The resulting defaults for `claude` (in `scripts/lib/model-selection.mjs`, overridable by `config/agents.json`), shown as model · effort:

| stage | easy | medium | hard |
|---|---|---|---|
| fix / plan | `sonnet` · high | `opus` · high | `fable` · high |
| implement | `sonnet` · xhigh | `opus` · xhigh | `fable` · xhigh |
| review | **`opus` · medium** | `opus` · high | `fable` · high |

The `medium` column reproduces the historical effort profile (`xhigh` for `implement`, `high` elsewhere) while naming the model explicitly instead of inheriting whatever was last configured interactively. `easy` saves cost with Sonnet; `hard` escalates to Fable. The bolded cell is an override: an `easy` review still runs on Opus (cheap models miss bugs) but at reduced effort.

Models are named by **tier alias** (`sonnet` / `opus` / `fable`) rather than a pinned id like `claude-opus-5`, because `claude --model` resolves an alias to the latest release in that family — so a new Opus or Fable is picked up without a config edit. Pin a full id in `config/agents.json` when a run must stay on a specific version. Aliases are a `claude` convention; other adapters use whatever their own CLI accepts.

`config/agents.json` is deep-merged over the built-in defaults, so a partial file only restates what it changes. A `null` or missing model/effort means "pass no flag — use the agent's own default," which is how every non-`claude` agent behaves until you add a block for it. Example — pin a cross-cutting cell and add a `codex` policy:

```json
{
  "claude": {
    "overrides": {
      "review": { "easy": { "model": "claude-opus-5", "effort": "medium" } }
    }
  },
  "codex": {
    "model": { "easy": "gpt-5-mini", "medium": "gpt-5", "hard": "gpt-5" },
    "effort": { "implement": "high", "default": "medium" }
  }
}
```

> **Note:** effort vocabularies are model-specific — a value valid for one model may be rejected by another. If a model in a given tier rejects an effort value, set a supported one for that stage in the config.

## Stopping the Runner

Create a `tickets/.stop` file to gracefully halt the runner between tickets:

```bash
touch tickets/.stop
```

The runner checks for this file before each ticket. When found, it finishes any in-progress commit, removes the stop file, and exits. The `.stop` file is git-ignored.

## Incomplete Run Recovery

The runner tracks which ticket is currently being processed in `tickets/.in-progress`. If a run is interrupted (disconnection, timeout, crash), the next run detects the incomplete state and prepends a resume note to the ticket file with:

- When and which agent last attempted the ticket
- A pointer to the prior run's log file
- Instructions to read the log, assess progress, and resume rather than restart

The agent sees this note as part of the ticket content and can read the log to understand what was already accomplished. The resume note is removed by the agent when it begins working.

The resume note is committed to the ticket file itself, so it carries across runs regardless of strategy. Under `batch` and `chase`, when the resumed ticket is present in the new run's snapshot it is also hoisted to the front of the queue so it runs first — even if it sits in a later stage than other queued tickets (in `chase`, it becomes the first root and is chased forward from its current stage). Under `live` there is no frozen queue to hoist within; the ticket is re-discovered with its note in place and selected by normal cross-stage priority.

If the incomplete ticket is no longer present (e.g., it was manually moved), the runner simply clears the stale state and proceeds normally.

### Idle-timeout retries

If the agent goes idle for too long (10 minutes with no output), the runner kills it and retries the same ticket once with a resume note pointing at the prior run's log. If the retry also times out, the runner commits a resume note to the ticket and moves on to the next one rather than aborting the whole batch — so an unattended run can finish the rest of the queue and you can pick up the timed-out ticket on the next invocation.

## Clean Working Tree

The runner commits with `git add -A`, so each commit it makes captures **whatever is in the tree**, not what that particular ticket changed. That is deliberate — ticket agents touch arbitrary paths and the runner cannot enumerate them ahead of time — but it means uncommitted edits that were already sitting there when a ticket started get absorbed into that ticket's commit, under that ticket's name. A killed agent leaves exactly those edits behind, and the mis-filing is silent. Nothing is lost; what breaks is attribution.

So before it starts any ticket — once at startup, then again before each ticket — the runner checks the tree and, by default, commits anything it finds under its own honest message first:

| What was found | Commit message |
|---|---|
| A ticket was interrupted (named by `tickets/.in-progress` at startup, or the previous ticket this run) | `ticket(<stage>): <slug> (partial — salvaged from interrupted run)` |
| No owner can be worked out — your own uncommitted work, a prior `--no-commit` run | `tess: salvage uncommitted working tree (no ticket in progress)` |

Every case except "the tree was already clean" prints the paths and what was done with them, and a salvage prints `git reset --soft HEAD~1` in case the attribution is wrong. A clean tree says nothing.

`--dirty-tree` picks the behaviour:

- **`salvage`** (default) — commit the leftovers, then carry on.
- **`abort`** — refuse to start: print the paths and exit 1. Startup only; there is no useful place to stop mid-run, so a mid-run dirty tree is always salvaged.
- **`ignore`** — proceed and let the leftovers roll into the next ticket's commit (the behaviour before this check existed), but say so loudly.

`--no-commit` suppresses the salvage — nothing is committed, so nothing can be mis-attributed — but it does not soften `abort`. `--dry-run` reports what a real run would have done and changes nothing.

If a mid-run salvage cannot be committed (it would capture a suspicious mass deletion, or git itself failed), the runner stops before the next ticket and exits non-zero rather than working on a tree it does not understand.

`scripts/garden.mjs` runs the same check at the top of its pass, before it invokes the gardener and before its own `git add -A` commit — its commit is unscoped too, so leftovers sitting there would otherwise land under `tess: garden backlog (...)`. It has no `--dirty-tree` flag of its own: it is human-invoked and single-shot, so it always salvages and the operator sees the notice.

## Pre-existing Test Failure Triage

If the agent working a ticket runs tests and one fails in a way that is plainly unrelated to its own changes — broken at HEAD before its edits, in code it never touched — it writes `tickets/.pre-existing-error.md` summarising what it ran and what failed, then finishes its own ticket normally. The workflow rule for this lives in `agent-rules/tickets.md` (§ *Pre-existing test failures*).

After each ticket commits (and again once the run is wrapping up), the runner checks for that file. Policy is **fix the root cause as early as possible — never work around, skip, or defer it**. If the report is present, it dispatches a triage agent — same adapter, focused prompt — instructed to either:

- reproduce the failure, fix the root cause in place, and let the runner commit; or
- file a prioritized ticket into `tickets/fix/` (the top-priority processing stage) so the normal fix→implement→review pipeline resolves the root cause on its next iteration, ahead of feature work; or
- only when the cause is genuinely upstream, file into `tickets/blocked/` naming the external dependency.

Triage never routes a reproducible failure to `backlog/` and never resolves one with `it.skip`, a deleted test, or a loosened assertion. To keep the same failure from being re-triaged from cold by every subsequent ticket, triage records the failing-test signature in `tickets/.pre-existing-known.md` (test signature → tracking slug → state); before dispatching, the runner consults that ledger and short-circuits when an in-flight `fix/`/`blocked/` ticket already owns the failure.

The runner deletes the report afterwards and commits any resulting changes as `tess: triage pre-existing test failure`. Triage respects `--token-budget` and `--no-commit`. The `.pre-existing-error.md` file is gitignored.

**Ledger reconciliation.** The ledger is committed (not gitignored) so it persists across runs and agents — which means it also needs sweeping, or it accumulates entries for failures long since fixed and starts suppressing re-triage of *genuine regressions* that reuse the same test path. Triage removes an entry only when it personally re-runs the test and finds it gone, or lands a fix in place; the common case — a failure that flows `fix → implement → review → complete` through the normal pipeline — leaves its entry orphaned, since nothing re-reads the ledger when the tracking ticket lands. So at the start of every run (alongside the completed-ticket sweep, and gated by the same `--no-prune-completed` / `--dry-run` flags), the runner reconciles the ledger against live ticket state: any entry whose tracking slug has reached `complete/` or vanished from the board is dropped, and the change is committed as `tess: prune <n> resolved known-failure ledger entr(y/ies)`. Entries whose slug is still live (`fix`/`plan`/`implement`/`review`/`blocked`/`backlog`) stay. This is safe-conservative — pruning removes only the *suppression*, never re-detection: if a failure is in fact still broken after its tracker completed, the next ticket that trips it reproduces it at HEAD, re-files, and re-adds the entry.

## Design Philosophy

- **Snapshot-based** — Ticket list captured once per run; newly created tickets wait for the next run
- **Agent-owned transitions** — The agent creates and deletes ticket files; the runner handles commits
- **Commit per ticket** — Clean git history for human review between runs
- **Sequence-driven** — Tickets processed lowest-sequence-first within each stage (optional prefix; unnumbered tickets trail numbered ones)
- **Prereq-aware** — `prereq:` edges topologically sort tickets within a stage and gate them across stages by pipeline rank; conflicts with explicit sequence numbers fail fast
- **Non-interactive** — Batch processing with human review between runs

## Ticket Format Migration

`tickets/.version` records the ticket format. Legacy format v1 used numeric prefixes to encode *priority* (higher = sooner) and a `dependencies:` header; the current format v2 uses *sequence* (lower = sooner) with a `prereq:` header and slug-only references.

The runner auto-migrates on first invocation against a v1 project: it inverts numbering (preserving execution order), renames `dependencies:` to `prereq:`, strips sequence prefixes from inter-ticket references, and commits the migration as its own commit. The migration is source-controlled — inspect the diff and revert if needed.

To run the migration explicitly (with a dry-run preview):

```bash
node tess/scripts/migrate.mjs --dry-run
node tess/scripts/migrate.mjs
```

## Web Dashboard

Tess includes a web dashboard for browsing the ticket pipeline, viewing tickets by stage, and reading ticket details.

### Running the Dashboard

```bash
cd tess/ui
npm install
npm run dev
```

The dashboard starts on `http://localhost:3004` by default.

### Cross-Linking

If a sibling system is detected (e.g., `teamos/` exists at the project root), the dashboard shows a link in the navigation bar. Both teamos and tess auto-detect each other and display reciprocal links. Override the project root with the `TESS_PROJECT_ROOT` environment variable:

```bash
TESS_PROJECT_ROOT=/path/to/project npm run dev
```

## Further Reading

- [docs/](docs/) — Design principles, installation architecture, and development status
