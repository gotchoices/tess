Tickets flow forward through stages:

```
  backlog/ ─→ plan/ ─┐
                     ├─→ implement/ ──→ review/ ──→ complete/
              fix/ ──┘
                     ↕
                 blocked/
```

Each stage's job is to advance the ticket to the next stage. Tickets only move sideways into `blocked/` (and back out once unblocked); they never flow backward. In particular, `review/` is **after** `implement/` — a review ticket exists because code has already been written and now needs a code-review pass.

The tickets/ folder at the project root contains `backlog`, `fix`, `plan`, `implement`, `review`, `blocked`, and `complete` subfolders.  Each ticket is a markdown file inside one of these folders.

Filename convention: `<slug>.md`, optionally prefixed with a numeric **sequence** (integer or decimal) — `3-my-ticket.md` or `3.5-my-ticket.md`.  **Lower sequence runs sooner.**  The prefix is optional; unnumbered tickets (`my-ticket.md`) follow after all numbered ones in the same stage.  The sequence number is not part of the ticket's identity — when referencing another ticket, use only its slug (`my-ticket`), not the full filename.

You own the full stage transition.  When you are done:
  1. Create the next-stage output file(s) in the appropriate tickets/ subfolder.
     You may split one ticket into multiple next-stage tickets if warranted.
     You may keep, add, or adjust the sequence prefix.  Respect `prereq:` relationships:
     a prereq must have a sequence ≤ its dependent (or be unnumbered only if the
     dependent is also unnumbered).
  2. Delete the original source ticket file from its current stage folder.
* **Important**: Only proceed if you are clear on the ticket after research.  If there are questions or important decisions, transition the ticket into the blocked/ folder, with appropriate question(s) and/or discussion of tradeoffs.

Stages:
- Backlog - specification tickets (like *plan*) that aren't ready to be worked yet.  Use this when splitting or scoping work: items the team will get to eventually but shouldn't enter the active pipeline.  Prefer `backlog/` over `blocked/` when the reason is "not now" rather than "unresolved question."  Not in the runner's default processing set — the human (or an explicit `--stages backlog:<max>` invocation) promotes these into `plan/` when ready.
- Fix - for bugs.  Start with a reproducing test case, or a trace modality if the issue is intermittent.  Once reproduced and researched, form one or more hypotheses as to the cause and correction.  Output is one or more ticket file(s) in *implement/* (or blocked/backlog).  References should be made to key files and documentation.  TODO tasks should be at the bottom of the ticket file(s).  Split into multiple tickets if warranted.
- Plan - specs for features and enhancements (not already designed/planned).  After research, provided no major questions/options remain, output is one or more plan and implement/ tickets.  When you discover adjacent work that is out of scope for the current pass, park it in `backlog/` rather than growing the current ticket.  References should be made to key files and documentation.  TODO tasks should be at the bottom of the ticket file(s).  Don't switch to your agent's "planning mode" when working these tickets - that's too meta.  In the spirit of TDD, your plan may include bullets describing key tests that might come in later phases, and what the expected outputs should be.
- Implement - These tickets are ready for implementation (fix, build, update, ...whatever the ticket specifies).  If more than one agent would be useful, without stepping on toes, spawn sub-agents.  Be sure the build and tests pass when done.  Output is a distilled summary of the ticket, with emphasis on use cases for testing, validation and usage into the review/ folder.
- Review - Code review and follow up for the completed implementation.  Inspect the code against all aspect-oriented criteria (SPP, DRY, modular, scalable, maintainable, performant, resource cleanup, etc.).  Ensure there are tests for the ticket, and that the build and tests pass.  Try to look only at the interface points for the ticket initially to avoid biasing the tests towards the implementation.  Ensure that relevant docs are up-to-date.  Output to complete/ once the tests pass and code is solid.
- Blocked - This is where to put tickets with unresolved questions, important decisions, or unclear requirements.  Include the question(s) and/or discussion of tradeoffs.
- Complete - Archived summary of finished work.  Contains briefly what was built, key files, testing notes, and usage information.

If the ticket contains a `<!-- resume-note -->` block, a prior agent run was interrupted before completion.  Read the referenced log file to understand what was already done, check the current codebase state for partial changes, and resume from where it left off.  If the prior run failed on a specific tool call or timed out, be careful not to just launch into the same situation.

Don't combine tickets unless they are tightly related.

Efficiency tips:
- Use the `files:` header in tickets — it saves the next agent from re-discovering paths.
- Use the `prereq:` header to name other tickets (by slug, without sequence prefix) whose landing you depend on.  Omit sequence prefixes — they may change.
- When spawning sub-agents, give them specific file paths rather than asking them to explore.
- Use the appropriate section of AGENTS.md for the project layout — don't guess paths.
- Run tests and type checks during implement, not just during review.
- Long-running validation: the runner kills any agent that produces no output for 10 minutes (idle timeout).  If a command might run that long, **stream its output** (e.g. `yarn foo 2>&1 | tee /tmp/foo.log`) — never `> /tmp/foo.log 2>&1`, since silent redirection lets the idle timer expire and the run is lost.  If a single command's wall-clock routinely exceeds ~10 minutes (full bench sweeps, exhaustive fuzz/property runs, etc.), it is **not agent-runnable**: skip it inside the ticket, document the deferral, and let a human or CI handle it out-of-band.

For new tickets: put a new file into `fix/` or `plan/` (or `backlog/` if it's a future concern rather than active work) but focus on the **description, requirements, and specifications** of the issue or feature, expected behavior, use case, etc.  **Don't do planning, don't add TODO items, or get ahead**, unless you already possess key information that would be useful.  Think use cases, expectations, and specifications.

Ticket file template:

----
description: <brief description>
prereq: <slugs of other tickets that must land first — comma-separated, no sequence prefix, no .md>
files: <list key files touched/relevant — saves the next agent significant discovery time>
----
<timeless architecture description focused on prose, diagrams, and interfaces/types/schema>

<if implement: TODO list of tasks - avoid numbering of tasks, besides phases>
