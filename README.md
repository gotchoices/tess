# Tess

*From Latin "tessera" — a ticket or token.*

Tess is a lightweight, agent-driven ticketing system for software projects. It provides a structured pipeline where AI coding agents (Claude, Cursor, Augment, Codex) process tickets through workflow stages — from triage through implementation and review to completion.

When using the Codex adapter, `codex-cli` must be version `0.112.0` or newer.

Tess lives as its own repository and integrates into any project, giving every repo the same ticket pipeline without duplicating code.

## How It Works

Tickets are markdown files organized into stage folders inside a project's `tickets/` directory. Each ticket file is named with an optional sequence prefix (`3-my-feature.md` — lower runs sooner) and contains a lightweight metadata header followed by architecture notes and TODO items. The sequence prefix is optional; unnumbered tickets follow after all numbered ones in a stage.

A runner script processes tickets one at a time, invoking an AI agent for each. The agent owns the full stage transition: it creates the next-stage file(s), deletes the source ticket, and commits. The runner snapshots the ticket list at startup and traverses it under one of two strategies — **batch** (drain stage-by-stage; default) or **chase** (follow one ticket through every stage before moving to the next). See [Strategies](#strategies) below.

```
tickets/
├── backlog/       # Parked specs — not yet ready to work
├── fix/           # Bug triage and reproduction
├── plan/          # Feature design and research
├── implement/     # Ready for implementation
├── review/        # Code review and validation
├── complete/      # Archived completed work
├── blocked/       # Parked — unresolved questions
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

**Cross-stage prereqs.** Prereqs are also resolved across the whole pipeline, not just the current stage. The runner ranks stages as `backlog (0) < fix = plan (1) < implement (2) < review (3) < complete (4)`; a prereq is *satisfied* for a ticket `T` when it sits in a strictly later rank than `T`, or in the same stage (where in-stage ordering is enforced by topo sort). A prereq found in an earlier-rank stage, in a peer-but-different stage (e.g. `T` in plan with prereq still in fix), or parked in `blocked/` causes `T` to be **deferred** for this run — `T` is skipped with a warning, and any sibling that lists `T` as a prereq is deferred too, cascading through the queue. Unresolved prereqs (slug not present anywhere) are assumed already complete and ignored, as before.

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
| `--stages <list>` | `fix,plan,implement,review` | Stages to process, with optional per-stage max (`implement:12,review:10`). `backlog` is a valid target but excluded from the default set. |
| `--agent <name>` | `claude` | Agent adapter: `claude`, `cursor`, `auggie`, or `codex` |
| `--strategy <name>` | `batch` | Traversal strategy: `batch` or `chase`. See [Strategies](#strategies). |
| `--max <n>` | _unlimited_ | Stop after processing at most n tickets |
| `--token-budget <n>` | _unset_ | Soft per-ticket context budget (claude only). When the running context size crosses *n* tokens, a one-shot `BUDGET_WARNING` is injected via a PreToolUse hook so the agent splits residual work into continuation tickets. See [Token Budget](#token-budget). |
| `--no-commit` | — | Skip automatic git commit after each ticket (also skips the migration commit) |
| `--skip-blocked` | — | Pre-filter the snapshot: drop any ticket whose prereq chain reaches a slug parked in `blocked/`. The runtime cross-stage prereq gate still applies to other misses. |
| `--refresh-index` | — | Run the local code indexer incrementally before each ticket. No-op if `tickets/.index/` does not exist. See [Local Code Search](#local-code-search-optional). |
| `--dry-run` | — | List tickets without invoking the agent |

### Init Options

| Option | Default | Description |
|---|---|---|
| `--ignore-stages` | — | Add ticket stage folders (fix/, plan/, etc.) to .gitignore |
| `--no-ignore-stages` | — | Keep ticket stage folders tracked in git |
| `--with-search` | — | Wire the MCP code-search server for the chosen agent |
| `--no-search` | — | Skip the MCP code search prompt |
| `--agent <name>` | `claude` | Target agent for `--with-search`: `claude`, `cursor`, `codex`, `auggie` |

When neither flag is passed, init will prompt interactively. The default is to **not** ignore stage folders. Use `--ignore-stages` when each developer maintains separate tickets that shouldn't be committed to the shared repo.

## Strategies

The runner picks the next ticket to work using a strategy. Both strategies share the same snapshot, agent invocation, logging, and commit pipeline — they differ only in traversal order.

### `batch` (default)

Drain each stage in topo/sequence order: every ticket advances exactly **one** stage per run. The pipeline-wide order is `--stages` (default `fix,plan,implement,review`); within each stage, prereqs come before dependents and lower sequences come first.

Best for: steady, reviewable progress across the whole pipeline. Each run produces a clean diff per stage so you can inspect what each stage did.

### `chase`

Pick one root ticket and follow it through **every** stage to `complete/` before moving to the next root. Ticket-major instead of stage-major.

After each stage transition, chase looks up the same slug in `NEXT_STAGE`, then in `blocked/` and `backlog/` (it does **not** rely on a filesystem diff — other agents may be modifying `tickets/` in parallel). If the same slug landed in the next stage, the chase continues; if it landed in `blocked/` or `backlog/`, the chain ends and the slug is recorded as **deferred** for the rest of the run.

**Deferral cascade.** A slug enters the run's deferred set when the agent moves it to `blocked/` or `backlog/`, *or* when the cross-stage prereq gate rejects it because a prereq is still behind. A queued root that lists a deferred slug as `prereq:` is skipped — and the skipped root is itself added to the deferred set, so the skip cascades transitively through the queue. The same cascade applies in `batch` mode. This prevents tess from charging into work whose prerequisite just bounced or hasn't caught up.

**Splits.** If an agent splits one ticket into multiple next-stage tickets, chase follows the same-slug branch and leaves the siblings in place for the next run.

**Safety cap.** A single chain is bounded to 6 stage transitions, in case an agent regresses a ticket (e.g. `implement` → `plan`) and creates a loop. The natural pipeline tops out at 4 (`backlog → plan → implement → review → complete`).

Best for: focused work on a single feature, or when you want fewer parallel work-in-progress trails in git history.

```bash
# Default — drain stage by stage
node tess/scripts/run.mjs

# Follow each root ticket all the way through
node tess/scripts/run.mjs --strategy chase

# Chase only the earliest tickets
node tess/scripts/run.mjs --strategy chase --max 3
```

## Token Budget

A long-running ticket can outgrow the model's context window mid-task, leaving an interrupted commit that is awkward to resume from. The `--token-budget <n>` flag (claude only) gives you a soft cushion: the runner watches Claude's per-turn context size and, when the threshold is crossed, injects a one-shot `BUDGET_WARNING` through a PreToolUse hook. The agent's instructions (in `agent-rules/tickets.md`) tell it to stop investigating, capture remaining TODOs as continuation ticket(s) in the **same** stage, delete the source ticket, and exit cleanly.

```bash
# Suggested starting point — claude's context is 200k.
node tess/scripts/run.mjs --token-budget 160000
```

The warning is purely advisory; the agent stays in control. After the agent splits and the runner commits, behavior depends on strategy:

- **chase** picks up the new same-stage continuations as part of the current chain (depth-first, before advancing the original slug forward).
- **batch** lets the continuations roll into the next run, preserving the snapshot-once-per-run guarantee.

The budget applies per ticket — every new ticket invocation starts from zero.

## Local Code Search (optional)

Tess can build a local vector index of the repository and expose it to the agent as an MCP `search_code` tool.  No API keys, no network calls after the first model download.

Three pieces, each independent:

1. **Indexer** — `node tess/scripts/index.mjs` walks `git ls-files`, chunks each file, embeds the chunks with a local sentence-transformers model (`Xenova/all-MiniLM-L6-v2`, 384-dim, ~80MB on first run), and stores vectors in `tickets/.index/index.db` (sqlite + sqlite-vec).  Incremental by content hash — re-running on a typical diff is sub-second.
2. **MCP server** — `tess/scripts/mcp-search.mjs` is a stdio MCP server exposing `search_code`, `find_references`, and `read_chunk` against the same DB.  Started by the agent, dies with it; nothing runs in the background between invocations.
3. **Per-agent config** — `init` writes the right MCP config for the chosen agent (Claude `.mcp.json`, Cursor `.cursor/mcp.json`, codex sample TOML).

### Enable it

```bash
cd tess && npm install
cd ..
node tess/scripts/init.mjs --with-search --agent claude
node tess/scripts/index.mjs                    # first build (downloads model)
```

### Keep it fresh

```bash
node tess/scripts/index.mjs                    # incremental refresh
node tess/scripts/index.mjs --watch            # debounced fs watcher
node tess/scripts/index.mjs --status           # row counts + last refresh
node tess/scripts/index.mjs --rebuild          # full rebuild
node tess/scripts/run.mjs --refresh-index ...  # refresh between every ticket
```

All artifacts live under `tickets/.index/` (gitignored).  Full uninstall: delete that folder and remove the `tess-search` entry from your agent's MCP config.

See [`docs/SEARCH.md`](docs/SEARCH.md) for storage layout, model swap policy, and MCP tool surface.

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
- **review** — Inspect code quality, verify tests, update docs, output complete ticket
- **complete** — Archived summary of finished work
- **blocked** — Parked when there are unresolved questions or decisions

## Ticket Format

```markdown
description: <brief description>
prereq: <slugs of other tickets that must land first — comma-separated, no prefix, no .md>
files: <optional list of relevant files>
----
<Architecture description — prose, diagrams, interfaces/types>

<TODO list of sub-tasks, organized by phase if needed>
```

**Filename convention:** `<slug>.md` with an optional `<sequence>-` prefix where lower sequence runs sooner (integer or decimal, e.g. `3-my-feature.md` or `3.5-my-feature.md`). The sequence number is not part of the ticket's identity — reference tickets by slug only in `prereq:`.

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

If the incomplete ticket is no longer in the batch (e.g., it was manually moved), the runner simply clears the stale state and proceeds normally.

### Idle-timeout retries

If the agent goes idle for too long (10 minutes with no output), the runner kills it and retries the same ticket once with a resume note pointing at the prior run's log. If the retry also times out, the runner commits a resume note to the ticket and moves on to the next one rather than aborting the whole batch — so an unattended run can finish the rest of the queue and you can pick up the timed-out ticket on the next invocation.

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
