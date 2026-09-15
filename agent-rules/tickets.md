Tickets flow forward through stages:

```
  backlog/ ─→ plan/ ─┐
                     ├─→ implement/ ──→ review/ ──→ complete/
              fix/ ──┘
                     ↕
                 blocked/
```

Each stage's job: advance ticket to next stage. Tickets only move sideways into `blocked/` (and back out once unblocked); never flow backward. `review/` is **after** `implement/` — a review ticket exists because code already written, now needs a code-review pass.

**Cross-stage gating automatic.** If a `prereq:` slug sits anywhere earlier in the pipeline (including `blocked/` or `backlog/`), runner defers the dependent this run and re-picks once the chain clears. Runner also cascades: errored, deferred, or blocked-prereq slugs transitively defer their downstream. Never mirror this by hand. `prereq:` is a hint to the runner, not an instruction to you.

tickets/ folder at project root contains `backlog`, `fix`, `plan`, `implement`, `review`, `blocked`, `complete` subfolders. Each ticket = markdown file inside one of these folders.

Filename convention: `<slug>.md`, optionally prefixed with numeric **sequence** (integer or decimal) — `3-my-ticket.md` or `3.5-my-ticket.md`. **Lower sequence runs sooner.** Prefix optional; unnumbered tickets (`my-ticket.md`) follow after all numbered ones in same stage. Sequence number is not part of ticket identity — when referencing another ticket, use only its slug (`my-ticket`), not the full filename.

You own the full stage transition. When done:
  1. Create the next-stage output file(s) in the appropriate tickets/ subfolder, keeping the anchor fields (see *Name an anchor*). May split one ticket into multiple next-stage tickets if warranted — give each a distinct slug and chain with `prereq:` so runner enforces topo order. Don't combine unrelated tickets. May keep, add, or adjust the sequence prefix. Respect `prereq:` relationships: a prereq must have a sequence ≤ its dependent (or be unnumbered only if the dependent is also unnumbered) — runner fails fast on conflicts.
  2. Delete the original source ticket file from its current stage folder. Delete only the file — leave the stage folder in place even when it ends up empty.

**Never sanitize the working tree.** Don't run `git checkout -- `, `git restore`, `git reset`, `git clean`, or `git stash`, and don't otherwise revert or discard changes you didn't make. Runner may be processing other tickets and a human may be promoting tickets concurrently — uncommitted board moves and in-flight tree edits are not yours to undo. Touch only the files your own ticket requires.

**A `prereq:` slug you can't find on the board has probably already landed.** Completed tickets are archived, then swept out of `complete/` once they age out, so a finished prereq eventually leaves no ticket file behind. Check `tickets/.pruned-tickets.jsonl` — one JSON record per swept ticket, with its slug, completion date, and landing commit — before concluding anything is missing. The runner also resolves this for you: if your prompt carries a `## Prereq status` section, a slug marked `pruned` is **done**, and one marked `unknown` matched neither the board nor that ledger. Never file a ticket or route to `blocked/` on "the prereq doesn't exist."

**`prereq:` is a hint, not an instruction to park.** Assume every `prereq:` ticket's work will land; design as if it has. The only reasons to deviate are the two `blocked/` categories below — neither is "an upstream tess ticket isn't done yet." Otherwise pick the best option, document the tradeoff in the next-stage ticket, and proceed.

Stages (overview — full rules for your active stage under "Active stage details" below):
- **backlog** — specs not yet ready to work; human (or `--stages backlog:N`) promotes into plan/.
- **fix** — reproduce + research a bug; output implement/ ticket(s).
- **plan** — design a feature; output plan/ or implement/ ticket(s); park out-of-scope work in backlog/.
- **implement** — build it; ensure build + tests pass; output a review/ handoff honest about gaps (reviewer treats your work as a starting point, not a finish line).
- **review** — adversarial pass over implement output: minor findings → fix inline; major → ticket(s) past the filing bar, else a tripwire; conditional/speculative → record as a tripwire, not a ticket. Output complete/ with a `## Review findings` section.
- **blocked** — human's inbox: proposed text where the specification or architecture is silent or contradictory, or a dependency outside this repo. Never "a sibling ticket isn't done" — that's `prereq:`.
- **complete** — archived summary of finished work, including review findings.

## Active stage details

<!-- stage:backlog -->
**Backlog** — specification tickets (like *plan*) that aren't ready to be worked yet. Use when splitting or scoping work: items the team will get to eventually but shouldn't enter the active pipeline. Prefer `backlog/` over `blocked/` when the reason is "not now" rather than "the spec can't settle it" — and "not now" at the top level still means this release (see *Backlog prefixes*). Not in the runner's default processing set — the human (or an explicit `--stages backlog:<max>` invocation) promotes these into `plan/` when ready.
<!-- /stage -->

<!-- stage:fix -->
**Fix** — for bugs. Start with a reproducing test case, or a trace modality if the issue is intermittent. Once reproduced and researched, form one or more hypotheses as to the cause and correction. Output is one or more ticket file(s) in *implement/* (or blocked/backlog). Reference key files and documentation. TODO tasks at the bottom of the ticket file(s). Split into multiple tickets if warranted.
<!-- /stage -->

<!-- stage:plan -->
**Plan** — specs for features and enhancements (not already designed/planned). After research, output is one or more plan and implement/ tickets. When you discover adjacent work out of scope for the current pass, park it in `backlog/` (prefixed `feat-`/`debt-`; see *Backlog prefixes*) rather than growing the current ticket. Reference key files and documentation. TODO tasks at the bottom of the ticket file(s). Don't switch to your agent's "planning mode" for these tickets — too meta. In the spirit of TDD, your plan may include bullets describing key tests that might come in later phases, and expected outputs.

**Resolve the design before you emit an implement ticket.** Hand off to `implement/` only once no major question or open option remains: settle it with more research, or pick the best option and document the tradeoff in the ticket. If the specification or architecture is silent or contradictory on a question of consequence, route to `blocked/` with proposed text (form under *Before you file a ticket*) — never emit an under-specified implement ticket and leave the call to the implementer.

**Enumerate the adversarial surface.** Every implement ticket you produce should carry an `## Edge cases & interactions` section naming the boundary states, concurrent/forked access, partial-failure paths, and cross-subsystem interactions the implementer must cover and the reviewer will check. A case you name here is a test written up front; a case you omit tends to return as a separate fix ticket.

**Size each ticket to one agent run.** Split so each implement ticket is a single coherent change an agent can finish well inside the runner's idle-timeout window. If a ticket would span several subsystems or carry multiple independent failure modes, break it into `prereq:`-chained tickets rather than one oversized ticket.
<!-- /stage -->

<!-- stage:implement -->
**Implement** — these tickets are ready for implementation (fix, build, update, ...whatever the ticket specifies). If more than one agent would be useful without stepping on toes, spawn sub-agents. Ensure build and tests pass when done. Output is a distilled summary of the ticket, emphasis on use cases for testing, validation and usage, into the review/ folder. Write the handoff honestly — the reviewer is instructed to treat your work as a starting point and your tests as a floor, so flag known gaps rather than papering over them. Comments say what the code cannot — a why, a constraint, a non-obvious consequence; a run of statements that needs narrating becomes a named subroutine instead.
<!-- /stage -->

<!-- stage:review -->
**Review** — adversarial pass over the completed implementation. The ticket will read as finished — find what it overlooked. **Read the implement-stage diff first**, with fresh eyes, before considering the handoff summary (find it via `git log --grep="ticket(implement): <slug>" -1 --format=%H` then `git show <hash>`). Scrutinize from every aspect angle (SPP, DRY, modular, scalable, maintainable, performant, resource cleanup, error handling, type safety). Watch source hygiene: file size, and comments that narrate statements instead of saying what the code cannot (a why, a constraint, a non-obvious consequence) — extract the narrated run into a named subroutine. The implementer's tests are a *starting point* — cover happy path, edge cases, error paths, regressions, and interactions. Treat docs as out-of-date until you read every file the change touches — and the ones it *should* have touched — and confirm they reflect the new reality. Run lint + tests; they must pass. Disposition of findings: **minor** — fix in this pass; **major** — climb *Architecture first* (in *Before you file a ticket*) before filing: prefer the invariant that retires the whole class over a ticket for the instance. Filing bar: a ticket only when the finding serves a current-release anchor or names a class-level invariant (rungs 1–3), else a `NOTE:` tripwire at the site. Exception: a real latent defect (*Conditional, or just not-yet-reached?*) whose only anchor is deferred to a later release goes into that release's `backlog/<CODE>/` rather than a comment; **conditional/speculative** ("fine now; only matters if X happens later") — record as a tripwire, not a ticket (see *Tripwires*); **considered-and-declined** — a finding whose site carries an accepted-tradeoff `NOTE:` is already decided; leave it alone unless its stated revisit condition has tripped (see *Accepted tradeoffs*). The output `complete/` ticket must include a `## Review findings` section listing what was checked, what was found, and what was done. Empty categories are fine — but say so *explicitly and with a reason*, not silently or "Looks good".
<!-- /stage -->

<!-- stage:blocked -->
**Blocked** is the human's inbox — use it for the two things the runner genuinely cannot resolve on its own, and nothing else: (a) **The specification or architecture is silent or contradictory** on a product, design or go/no-go question — including one you surface *during review or planning* that blocks no in-flight ticket: it still goes here, not into `backlog/`. (b) **A dependency outside this repo** that `prereq:` cannot track — an external service or upstream library, a stub primitive that doesn't exist yet, or a premise mismatch with code beyond this repo.

Use the form under *Before you file a ticket*, written for a human with no prior context (see *Write for a reader without your context*): the decider must be able to accept or edit the proposal without reconstructing your session.

**Do not block on a sibling tess ticket.** If your only obstacle is that another ticket in this pipeline isn't done, that is *not* blocked — add it to `prereq:` and design as if it has already landed. The runner defers your dependent and re-picks it the moment the prereq chain clears, then cascades that deferral to anything depending on you; you never mirror this by hand. Also not blocked: uncertainty more research would resolve (do the research), or "we'll get to it later" (that's `backlog/`).
<!-- /stage -->

<!-- stage:complete -->
**Complete** — archived summary of finished work. Briefly: what was built, key files, testing notes, and usage information.
<!-- /stage -->

If the ticket contains a `<!-- resume-note -->` block, a prior agent run was interrupted before completion. Read the referenced log file to understand what was already done, check the current codebase state for partial changes, and resume from where it left off. If the prior run failed on a specific tool call or timed out, be careful not to just launch into the same situation.

## Tripwires (conditional concerns)

A **tripwire** is a concern that is fine *now* and only becomes work *if* some condition trips later — "this re-counts on every save; if scenarios get large, keep a running count", "reading this does one extra lookup; if it ever shows up as slow, cache it". A tripwire is knowledge, not a queued task — **do not file it as a ticket.** Record it where a future reader will actually meet it:

- **Default — a code comment at the exact site,** tagged `NOTE:` so the set stays greppable: `// NOTE: re-counts every entity per save; if scenarios get large, keep a running count.`
- **A bullet in the relevant `docs/` file** instead, when the concern is architectural and has no single code site.
- **Always** add one line to the review's `## Review findings` saying what you noticed and where you parked it — findings is the *index*, not the home; don't restate the analysis.

**Conditional, or just not-yet-reached?** Only demote things that are genuinely conditional ("fine now; *if* X then Y"). A concern that is *definitely wrong the moment a currently-dormant path runs* is a real latent defect, not a tripwire — keep it as a ticket (`debt-` if dormant, `bug-` if reachable now).

## Accepted tradeoffs (declined findings)

There is no perfect code — some findings get weighed by a human and **declined by design**. Deleting the ticket alone invites the next reviewer to re-discover and re-file the same finding. When a decline happens (typically during backlog gardening, on human feedback), record the decision where the next reviewer will actually look — at the code site:

```
// NOTE: accepted tradeoff — config reload re-parses the whole file on every change; simplicity weighed over incremental parsing and kept; revisit if reload ever shows up in profiles.
```

- Same greppable `NOTE:` tag as tripwires — one set to sweep.
- One line at the most specific site; the relevant `docs/` file instead when the decision is architectural with no single site.
- State **what** was declined, **why**, and the **revisit condition**. No revisit condition means a permanent decision — fine, but that should be deliberate.
- **Reviewers:** an accepted-tradeoff `NOTE:` at your finding's site means the call was already made — do not re-file unless the stated revisit condition has tripped or the surrounding facts have materially changed (say which, in your findings).

## Backlog prefixes

`backlog/` is the one stage that mixes kinds of work — every other stage encodes its type by its folder. So prefix each backlog ticket's slug with its kind, to keep the queue sortable at a glance:

- `bug-` — a defect to fix
- `feat-` — a new capability or enhancement
- `debt-` — tests, guards, refactors, hardening

Form: `bug-<slug>.md` (or `<seq>-bug-<slug>.md` if you number it — the sequence stays leading). The prefix is part of the slug and **travels with the ticket** for its whole life; `prereq:` references include it, and there's no need to strip it on promotion (`fix/bug-foo` is fine). Decisions don't get a prefix — they go to `blocked/`. Tickets you create directly into a working stage (`fix/`, `plan/`, …) don't need a prefix; the folder already says what they are. With `tickets/releases.md`, each sub-folder of `backlog/` is a release deferral folder named after a later code in that list; the top level, like every other stage, is the current release. File into `backlog/<CODE>/` only when the ticket's anchor is explicitly deferred to that release or a human said so; never create a folder for an unlisted code, or move a ticket between releases on your own. Without `releases.md`, sub-folders are the human's to curate — don't create or reorganize them.

## Write for a reader without your context

At every stage you are writing for someone — a teammate, the next agent, your future self — who does **not** have your session in their head. De-jargon as you go:

- No coined vocabulary presented as established fact. If you must name an internal concept ("the lens seam", "covering structures"), define it on first use or don't use it.
- Spell out acronyms and name the concrete thing (the actual limit, the actual file) instead of gesturing at it.
- This matters most for the human-facing stages — `backlog/` and `blocked/` — where the reader is *deciding*, not implementing. A ticket dense with inside-baseball is one a human can't triage; if you can't state it plainly, you don't yet understand it well enough to file it.
- No hard-wrapping. One paragraph per line, editors soft-wrap; `yarn unwrap:md <path>` fixes existing files.

## Pre-existing test failures

If the tests you run surface a failure that is plainly **not yours** — broken at HEAD before your edits, in a subsystem outside your diff, or otherwise clearly unrelated — do NOT try to chase it inside this ticket. But equally, do **not** paper over it: `it.skip`, `describe.skip`, commenting out the test, or loosening its assertions to get a green run are **forbidden** — they bury a real defect and cost far more to rediscover later than to fix now. Instead:

1. Check `tickets/.pre-existing-known.md` for the failing test. If it is already listed with an in-flight `fix/` or `blocked/` slug, the root cause is already tracked — do **not** re-report it. Note in your handoff that you are aware of / blocked on that slug and move on.
2. Otherwise write `tickets/.pre-existing-error.md` (overwrite if it already exists) containing:
   - the exact test command(s) you ran (and from which package, for monorepos),
   - the failing test name(s) and its exact path, plus a short excerpt of the error output,
   - one sentence on why you believe it is pre-existing (e.g. "fails on `main` at the same SHA", "asserts against module X which this ticket never touches").
3. Finish your own ticket normally — without having skipped or disabled the failing test.

After your ticket commits, the runner reads `.pre-existing-error.md` and dispatches a triage agent whose job is to **fix the root cause as early as possible**: it lands a scoped fix in place, or files a prioritized ticket into `tickets/fix/` (the top-priority stage) so the normal pipeline resolves it next — ahead of feature work — or, only if the cause is genuinely upstream, into `tickets/blocked/`. It never routes a reproducible failure to `backlog/` and never skips a test. Don't second-guess that pass — your job is to flag the failure accurately, not resolve or hide it. Failures clearly caused by your own changes are not pre-existing; fix those before handing off.

## BUDGET_WARNING

If you receive a `BUDGET_WARNING` from the runner, the conversation has crossed its soft token budget — wrap up rather than continuing to investigate or implement:

- Once you wrap up what you are in the middle of, update the ticket to reflect your progress and learnings.
- If the work is too significant for one ticket, create additional ticket(s) in the **same stage** (not next) to decompose the work; use `prereq:` headers to determine the order.
- If the additional tickets replace the original ticket, delete the original.
- Exit cleanly and don't run more tests or tools after the ticket update/writes.

## Efficiency tips:

- Use the `files:` header in tickets — it saves the next agent from re-discovering paths.
- Use the `prereq:` header to name other tickets (by slug, without sequence prefix) whose landing you depend on. Omit sequence prefixes — they may change.
- When spawning sub-agents, give them specific file paths rather than asking them to explore.
- Use the appropriate section of AGENTS.md for the project layout — don't guess paths.
- Run tests and type checks during implement, not just during review.
- Long-running validation: runner kills if no output for 10 minutes (idle timeout). **Default: run it in the foreground with no redirection at all** — the output streams to the runner, which is exactly what keeps the idle timer alive. Never `> file 2>&1`: silent redirection lets the timer expire and the run is lost.
- Only add `| tee` when you actually need to grep the output afterwards — and then write it inside **`tickets/.logs/`**, e.g. `yarn workspace @sitecad/site-cad test 2>&1 | tee tickets/.logs/<slug>.test.log`. That directory is already git-ignored and the runner prunes it (14 days / 50 runs), so a log written there cleans itself up.
- **A log written anywhere else in the tree is still litter — it is just visible litter now.** The host project's `.gitignore` should ignore logs only inside the directories that own them (in this repo, `tickets/.logs/*.log` and `.runs/*`), not `*.log` repo-wide, so a stray log elsewhere shows up in a plain `git status` and someone deletes it. Don't rely on that to clean up after you: delete what you wrote. And don't write to `/tmp/...` — it is not a real path for agents running under PowerShell on Windows, so the file lands in the current directory instead, usually the repo root.
- Non-log artifacts — screenshots, heap dumps, JSON captures — don't belong in `tickets/.logs/` either. The pruner does age them out (an unrecognised name is pruned as its own single-file group), but they are opaque to anyone reading the directory and they consume slots in the 50-group cap, evicting real logs sooner. If a ticket needs an artifact to make its point, attach the finding to the ticket in words; if you must keep the file, say where it is and delete it before you hand off.
- If a command's wall-clock routinely exceeds ~10 minutes, it is **not agent-runnable**: skip it inside the ticket, document the deferral, and let a human or CI handle it out-of-band.
- **Never use `run_in_background: true` / `Monitor` / wait-for-notification patterns under tess.** Agent in `claude -p` mode — first `result` message ends the turn and runner will tree-kill agent. Validate in foreground with `tee`. To parallelize, chain in single shell pipeline.

## Before you file a ticket

Gated on filing. Everything resolved inline — skip this.

**Root cause, not symptom.** Name the one code site — or one unsettled decision — that must change. Two findings resolving at the same site are ONE ticket with two arms, even when the symptoms look unrelated. Can't name the site? Investigation isn't done.

**Name an anchor.** A ticket names the part of the specification it serves — tess's `architecture:` (a repo-relative document path, optionally `#section`) or a field the project declares in `tickets/rules/`. When a `## Project rules` section of this prompt declares anchor fields, an anchor is required and the runner won't work a ticket without one; otherwise `architecture:` is optional — fill it when a document clearly owns the work, leave it off when none does.

**Architecture first — a point ticket is the last resort.** The goal is a codebase that gets *harder to break*, not a queue that gets longer. Before filing a bug instance, climb this ladder and file at the **highest rung that applies** (in review, only past the filing bar):

1. **Types/representation** — could a type or representation change make the bad state unrepresentable? File a `debt-` ticket for that change, citing this instance as evidence.
2. **Property/generalized test** — would one general test or generator (e.g. "serialize-then-deserialize round-trips every value type") catch this whole class, now and after future edits? File a `debt-` ticket for the test, citing instances.
3. **Boundary invariant** — would an assertion or layering check at a seam catch the class at runtime/build time? Same treatment.
4. Only when the finding is genuinely a one-off with no class behind it: file the point `bug-` ticket.

The Nth instance of a class that already has a ticket is **evidence, not a new ticket** — the site-claim grep below finds the theme ticket; append your instance as an arm.

**Respect accepted tradeoffs.** The site-claim grep only sees open tickets; human decisions live in the code. Read around the site before filing — an accepted-tradeoff `NOTE:` there (see *Accepted tradeoffs*) means a human already weighed and declined this finding. Don't re-file unless its revisit condition has tripped.

**Backlog tickets carry triage metadata.** The context that files a ticket knows its impact better than the human triaging a flat list weeks later — don't discard that. Bug tickets headed for `backlog/` carry `severity:` and `likelihood:`; **every** backlog ticket carries `tradeoffs:` — one honest sentence on why a maintainer might decline or defer it. If you can't articulate the decline argument, you haven't weighed the ticket enough to file it.

**Check the site isn't already claimed.** The board is not in the code-search index and nothing hands it to you. For each path headed for `files:`:

```bash
grep -rl "<path or symbol>" tickets/backlog tickets/fix tickets/plan tickets/implement tickets/review
```

Hit → append your arm to that ticket's body, say so in your findings. File fresh only when nothing open touches the site.

**A blocked ticket is a proposal, not a question.** What the spec can't settle — "should we do this at all" included — goes to `blocked/`, not `backlog/` (backlog is for settled shape, unsettled timing). Lead with one line: the blocked category and the exact thing that unblocks it. For a silent or contradictory specification or architecture, carry the proposed text — capability wording for a feature question, a principle or mechanism for an architecture question — as the recommended default for the human to accept or edit, with the alternatives you rejected and why, what happens if we do nothing, and how reversible the call is.

**No unmeasured magnitudes.** Complexity class, slowdown factor, blast radius — say how you measured. Didn't measure → write the weaker claim.

**Size-debt: state the line count you measured, with the command.** The split may already have shipped.

**Bug tickets carry `repro:`** — `verified` (ran it, saw it) | `static` (read code, inferred) | `none`. Unverified suspicion is fine; filing it *as* observed is not. `static` → name what would confirm it.

For new tickets: put a new file into `fix/` or `plan/` (or `backlog/` if it's a future concern rather than active work) but focus on the **description, requirements, and specifications** of the issue or feature, expected behavior, use case, etc. **Don't do planning, don't add TODO items, or get ahead**, unless you already possess key information that would be useful. Think use cases, expectations, and specifications.

**The `description:` field is the plain-language summary — write it for a newcomer, not for yourself.** One sentence (two at most) that someone with *no prior context* can understand: what is wrong / what to build, and why, in human terms. It is the first — often only — thing skimmers, dashboards, and the next agent read. Keep symbol names, file paths, acronyms, commit SHAs, ticket slugs, and internal-mechanism detail **out** of it; all of that belongs in the body below the header fence. A multi-paragraph `description:` block dense with jargon is an anti-pattern — it makes the queue unreadable. If you can't say what the ticket is about in a plain sentence, you don't yet understand it well enough to file it. The same plain-language standard applies to the whole ticket body, not just this field — see *Write for a reader without your context*.

Ticket file template:

----
description: <ONE plain-language sentence (two at most), jargon-free, understandable with no prior context — what the ticket is about and why. NOT a technical abstract; the detail goes in the body.>
prereq: <slugs of other tickets that must land first — comma-separated, no sequence prefix, no .md>
architecture: <anchor: repo-relative architecture document path, optionally #section — or a field declared in tickets/rules/; required only when a project rules section declares anchor fields>
files: <list key files touched/relevant — saves the next agent significant discovery time>
difficulty: <optional; easy|medium|hard — how much horsepower the work needs. Default medium. Drives model/effort selection (e.g. hard → a stronger model); omit unless the work is unusually simple or hard.>
target: <optional; a release code from tickets/releases.md that agrees with the ticket's folder — normally omit: the folder already says its release>
repro: <bug tickets only; verified|static|none — ran it and saw it / inferred from code / neither.>
severity: <backlog bugs; corruption|wrong-result|edge-case|cosmetic — worst plausible user-visible effect.>
likelihood: <backlog bugs; normal-use|unusual|contrived — how a user would actually hit it.>
tradeoffs: <backlog tickets; one honest sentence on why a maintainer might decline or defer this.>
----
<timeless architecture description focused on prose, diagrams, and interfaces/types/schema>

<if implement: TODO list of tasks - avoid numbering of tasks, besides phases>
----

**Header fences.** The header is the field block above the body, and the parser accepts all three shapes already in the tree — write new tickets as shown above, but don't "correct" an existing ticket into a different one:

- **Closing fence only** (the template above): fields from line 1, then a fence line.
- **Opened and closed** — `----` … `----`, or YAML-style `---` … `---`. If the *first* line is a fence, the header starts after it.
- **No fence at all**: the header runs to the first fence line anywhere in the file, or to end-of-file.

A fence is a line of three or more dashes and nothing else. Two consequences worth knowing: a `---` horizontal rule in the prose of an unfenced ticket **ends the header**, and any line inside the header region that starts with a header field name is read as a field. Keep prose that begins with a field name below the fence.

**Leave a field off rather than leaving it empty** when it has no value — `prereq:` with nothing after it is fine and parses as "no prereqs", but the field name has to be alone on its line.
