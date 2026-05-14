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
* **Important**: `prereq:` tickets run before this one — assume their work will land; don't block waiting for them. Move to `blocked/` only when (a) you're at *implement* and a prereq's code isn't actually present yet (out-of-tess upstream, stub primitive, premise mismatch), or (b) there's a design question of consequence requiring human sign-off with no defensible default. Otherwise pick the best option, document the tradeoff in the next-stage ticket, and proceed.

Stages (overview — full rules for your active stage appear under "Active stage details" below):
- **backlog** — specs not yet ready to work; the human (or `--stages backlog:N`) promotes into plan/.
- **fix** — reproduce + research a bug; output implement/ ticket(s).
- **plan** — design a feature; output plan/ or implement/ ticket(s); park out-of-scope work in backlog/.
- **implement** — build it; ensure build + tests pass; output a review/ handoff that is honest about gaps (the reviewer treats your work as a starting point, not a finish line).
- **review** — adversarial pass over implement output: minor findings → fix inline; major → spawn new fix/plan/backlog ticket(s). Output complete/ with a `## Review findings` section.
- **blocked** — last-resort park: missing-prereq-code (implement only) or design question needing human sign-off.
- **complete** — archived summary of finished work, including review findings.

## Active stage details

<!-- stage:backlog -->
**Backlog** — specification tickets (like *plan*) that aren't ready to be worked yet.  Use this when splitting or scoping work: items the team will get to eventually but shouldn't enter the active pipeline.  Prefer `backlog/` over `blocked/` when the reason is "not now" rather than "unresolved question."  Not in the runner's default processing set — the human (or an explicit `--stages backlog:<max>` invocation) promotes these into `plan/` when ready.
<!-- /stage -->

<!-- stage:fix -->
**Fix** — for bugs.  Start with a reproducing test case, or a trace modality if the issue is intermittent.  Once reproduced and researched, form one or more hypotheses as to the cause and correction.  Output is one or more ticket file(s) in *implement/* (or blocked/backlog).  References should be made to key files and documentation.  TODO tasks should be at the bottom of the ticket file(s).  Split into multiple tickets if warranted.
<!-- /stage -->

<!-- stage:plan -->
**Plan** — specs for features and enhancements (not already designed/planned).  After research, provided no major questions/options remain, output is one or more plan and implement/ tickets.  When you discover adjacent work that is out of scope for the current pass, park it in `backlog/` rather than growing the current ticket.  References should be made to key files and documentation.  TODO tasks should be at the bottom of the ticket file(s).  Don't switch to your agent's "planning mode" when working these tickets - that's too meta.  In the spirit of TDD, your plan may include bullets describing key tests that might come in later phases, and what the expected outputs should be.
<!-- /stage -->

<!-- stage:implement -->
**Implement** — these tickets are ready for implementation (fix, build, update, ...whatever the ticket specifies).  If more than one agent would be useful, without stepping on toes, spawn sub-agents.  Be sure the build and tests pass when done.  Output is a distilled summary of the ticket, with emphasis on use cases for testing, validation and usage into the review/ folder.  Write the handoff honestly — the reviewer is instructed to treat your work as a starting point and your tests as a floor, so flag known gaps rather than papering over them.
<!-- /stage -->

<!-- stage:review -->
**Review** — adversarial pass over the completed implementation. The ticket will read as finished — find what it overlooked. **Read the implement-stage diff first**, with fresh eyes, before considering the handoff summary (find it via `git log --grep="ticket(implement): <slug>" -1 --format=%H` then `git show <hash>`). Scrutinize from every aspect angle (SPP, DRY, modular, scalable, maintainable, performant, resource cleanup, error handling, type safety). The implementer's tests are a *starting point* — cover happy path, edge cases, error paths, regressions, and interactions. Treat docs as out-of-date until you read every file the change touches — and the ones it *should* have touched — and confirm they reflect the new reality. Run lint + tests; they must pass. Disposition of findings: **minor** — fix in this pass; **major** — file new ticket(s). The output `complete/` ticket must include a `## Review findings` section listing what was checked, what was found, and what was done. Empty categories are fine — but say so *explicitly and with a reason*, not silently or "Looks good".
<!-- /stage -->

<!-- stage:blocked -->
**Blocked** — last resort. For: implement-stage prereq code not actually present (out-of-tess upstream, stub, premise mismatch), or design questions of consequence requiring human sign-off. Lead the file with one line stating which category and what specifically unblocks it. **Not** for: uncertainty more research would resolve, in-tess prereqs still in flight (runner re-picks on later cycles), or design choices with a defensible default.
<!-- /stage -->

<!-- stage:complete -->
**Complete** — archived summary of finished work.  Contains briefly what was built, key files, testing notes, and usage information.
<!-- /stage -->

If the ticket contains a `<!-- resume-note -->` block, a prior agent run was interrupted before completion.  Read the referenced log file to understand what was already done, check the current codebase state for partial changes, and resume from where it left off.  If the prior run failed on a specific tool call or timed out, be careful not to just launch into the same situation.

Don't combine tickets unless they are tightly related.

## BUDGET_WARNING

If you receive a `BUDGET_WARNING` from the runner, the conversation has crossed its soft token budget and you should wrap up rather than continuing to investigate or implement:

- Once you wrap up what you are in the middle of, update the ticket to reflect your progress and learnings.
- If the work is too significant for one ticket, create additional ticket(s) in the **same stage** (not next) to decompose the work; use `prereq:` headers to determine the order.
- If the additional tickets replace the original ticket, delete the original.
- Exit cleanly and don't run more tests or run more tools after the ticket update/writes

## Efficiency tips:

- Use the `files:` header in tickets — it saves the next agent from re-discovering paths.
- Use the `prereq:` header to name other tickets (by slug, without sequence prefix) whose landing you depend on.  Omit sequence prefixes — they may change.
- When spawning sub-agents, give them specific file paths rather than asking them to explore.
- Use the appropriate section of AGENTS.md for the project layout — don't guess paths.
- Run tests and type checks during implement, not just during review.
- Long-running validation: the runner kills any agent that produces no output for 10 minutes (idle timeout).  If a command might run that long, **stream its output** (e.g. `yarn foo 2>&1 | tee /tmp/foo.log`) — never `> /tmp/foo.log 2>&1`, since silent redirection lets the idle timer expire and the run is lost.  If a single command's wall-clock routinely exceeds ~10 minutes (full bench sweeps, exhaustive fuzz/property runs, etc.), it is **not agent-runnable**: skip it inside the ticket, document the deferral, and let a human or CI handle it out-of-band.
- **Never use `run_in_background: true` / `Monitor` / wait-for-notification patterns under tess.** The runner invokes the agent in headless (`claude -p`) mode, where the first `result` message ends the turn — there is no follow-up wake-up when a backgrounded shell or sub-agent finishes. Tess will tree-kill the agent on `result`, and any bg tasks die with it. Run validation **in the foreground** with `tee` (the same streaming pattern above). To parallelize independent commands, chain them in a single shell pipeline (e.g. `(yarn check 2>&1 | tee a.log) & (yarn test 2>&1 | tee b.log) & wait`) so the agent stays attached until both finish — don't hand them to the harness's background mode.

For new tickets: put a new file into `fix/` or `plan/` (or `backlog/` if it's a future concern rather than active work) but focus on the **description, requirements, and specifications** of the issue or feature, expected behavior, use case, etc.  **Don't do planning, don't add TODO items, or get ahead**, unless you already possess key information that would be useful.  Think use cases, expectations, and specifications.

Ticket file template:

----
description: <brief description>
prereq: <slugs of other tickets that must land first — comma-separated, no sequence prefix, no .md>
files: <list key files touched/relevant — saves the next agent significant discovery time>
effort: <optional; claude --effort override, e.g. low|medium|high|xhigh — omit to use the stage default>
----
<timeless architecture description focused on prose, diagrams, and interfaces/types/schema>

<if implement: TODO list of tasks - avoid numbering of tasks, besides phases>
