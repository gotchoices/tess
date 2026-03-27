# Tess

*From Latin "tessera" — a ticket or token.*

Tess is a lightweight, agent-driven ticketing system for software projects. It provides a structured pipeline where AI coding agents (Claude, Cursor, Augment, Codex) process tickets through workflow stages — from triage through implementation and review to completion.

When using the Codex adapter, `codex-cli` must be version `0.112.0` or newer.

Tess lives as its own repository and integrates into any project, giving every repo the same ticket pipeline without duplicating code.

## How It Works

Tickets are markdown files organized into stage folders inside a project's `tickets/` directory. Each ticket file is named with a priority prefix (`3-my-feature.md`) and contains a lightweight metadata header followed by architecture notes and TODO items.

A runner script processes tickets one at a time, invoking an AI agent for each. The agent owns the full stage transition: it creates the next-stage file(s), deletes the source ticket, and commits. The runner snapshots the ticket list at startup so each ticket advances exactly one stage per run.

```
tickets/
├── fix/           # Bug triage and reproduction
├── plan/          # Feature design and research
├── implement/     # Ready for implementation
├── review/        # Code review and validation
├── complete/      # Archived completed work
├── blocked/       # Parked — unresolved questions
├── AGENTS.md      # Points to tess agent rules
├── CLAUDE.md      # Points to tess agent rules
└── .logs/         # Agent execution logs (git-ignored)
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

Drop a markdown file into `tickets/fix/` or `tickets/plan/`:

```
tickets/plan/3-user-auth.md
```

```markdown
description: Add JWT-based authentication
dependencies: express, jsonwebtoken
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

### 3. Run the pipeline

```bash
# See what would be processed
node tess/scripts/run.mjs --dry-run

# Process all tickets (priority >= 3)
node tess/scripts/run.mjs

# Only specific stages
node tess/scripts/run.mjs --stages fix,implement

# Priority specific at multiple stages
node tess/scripts/run.mjs --stages fix:1,implement:1,review:1,plan:4

# Use a different agent
node tess/scripts/run.mjs --agent cursor
```

### Options

| Option | Default | Description |
|---|---|---|
| `--min-priority <n>` | `3` | Minimum priority threshold (1-5, 5 = highest) |
| `--stages <list>` | `fix,plan,implement,review` | Stages to process, with optional per-stage priority (`review:5,implement:3`) |
| `--agent <name>` | `claude` | Agent adapter: `claude`, `cursor`, `auggie`, or `codex` |
| `--no-commit` | — | Skip automatic git commit after each ticket |
| `--dry-run` | — | List tickets without invoking the agent |

### Init Options

| Option | Default | Description |
|---|---|---|
| `--ignore-stages` | — | Add ticket stage folders (fix/, plan/, etc.) to .gitignore |
| `--no-ignore-stages` | — | Keep ticket stage folders tracked in git |

When neither flag is passed, init will prompt interactively. The default is to **not** ignore stage folders. Use `--ignore-stages` when each developer maintains separate tickets that shouldn't be committed to the shared repo.

## Ticket Lifecycle

```
fix/ ──┐
       ├──→ implement/ ──→ review/ ──→ complete/
plan/ ─┘
       ↕
    blocked/
```

- **fix** — Reproduce a bug, research cause, output implementation ticket(s)
- **plan** — Design a feature, resolve questions, output implementation ticket(s)
- **implement** — Build it, ensure tests pass, output review ticket
- **review** — Inspect code quality, verify tests, update docs, output complete ticket
- **complete** — Archived summary of finished work
- **blocked** — Parked when there are unresolved questions or decisions

## Ticket Format

```markdown
description: <brief description>
dependencies: <other tickets, modules, external libraries>
files: <optional list of relevant files>
----
<Architecture description — prose, diagrams, interfaces/types>

<TODO list of sub-tasks, organized by phase if needed>
```

## Stopping the Runner

Create a `tickets/.stop` file to gracefully halt the runner between tickets:

```bash
touch tickets/.stop
```

The runner checks for this file before each ticket. When found, it finishes any in-progress commit, removes the stop file, and exits. The `.stop` file is git-ignored.

## Design Philosophy

- **Snapshot-based** — Ticket list captured once per run; newly created tickets wait for the next run
- **Agent-owned transitions** — The agent creates and deletes ticket files; the runner handles commits
- **Commit per ticket** — Clean git history for human review between runs
- **Priority-driven** — Tickets processed highest-priority-first within each stage
- **Non-interactive** — Batch processing with human review between runs

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
