# Tess

*From Latin "tessera" — a ticket or token.*

Tess is a lightweight, agent-driven ticketing system for software projects. It provides a structured pipeline where AI coding agents (Claude, Cursor, Augment, Codex) process tickets through workflow stages — from triage through implementation and review to completion.

When using the Codex adapter, `codex-cli` must be version `0.112.0` or newer.

Tess lives as its own repository and integrates into any project, giving every repo the same ticket pipeline without duplicating code.

## How It Works

Tickets are markdown files organized into stage folders inside a project's `tickets/` directory. Each ticket file is named with an optional sequence prefix (`3-my-feature.md` — lower runs sooner) and contains a lightweight metadata header followed by architecture notes and TODO items. The sequence prefix is optional; unnumbered tickets follow after all numbered ones in a stage.

A runner script processes tickets one at a time, invoking an AI agent for each. The agent owns the full stage transition: it creates the next-stage file(s), deletes the source ticket, and commits. The runner snapshots the ticket list at startup so each ticket advances exactly one stage per run.

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
```

### Options

| Option | Default | Description |
|---|---|---|
| `--max-sequence <n>` | _unlimited_ | Default sequence ceiling for all stages (sequences can include decimals). Unnumbered tickets are skipped whenever this is finite. |
| `--stages <list>` | `fix,plan,implement,review` | Stages to process, with optional per-stage max (`implement:12,review:10`). `backlog` is a valid target but excluded from the default set. |
| `--agent <name>` | `claude` | Agent adapter: `claude`, `cursor`, `auggie`, or `codex` |
| `--max <n>` | _unlimited_ | Stop after processing at most n tickets |
| `--no-commit` | — | Skip automatic git commit after each ticket (also skips the migration commit) |
| `--dry-run` | — | List tickets without invoking the agent |

### Init Options

| Option | Default | Description |
|---|---|---|
| `--ignore-stages` | — | Add ticket stage folders (fix/, plan/, etc.) to .gitignore |
| `--no-ignore-stages` | — | Keep ticket stage folders tracked in git |

When neither flag is passed, init will prompt interactively. The default is to **not** ignore stage folders. Use `--ignore-stages` when each developer maintains separate tickets that shouldn't be committed to the shared repo.

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

## Design Philosophy

- **Snapshot-based** — Ticket list captured once per run; newly created tickets wait for the next run
- **Agent-owned transitions** — The agent creates and deletes ticket files; the runner handles commits
- **Commit per ticket** — Clean git history for human review between runs
- **Sequence-driven** — Tickets processed lowest-sequence-first within each stage (optional prefix; unnumbered tickets trail numbered ones)
- **Prereq-aware** — `prereq:` edges topologically sort tickets; conflicts with explicit sequence numbers fail fast
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
