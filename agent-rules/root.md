## Tickets (tess)

Project uses [tess](tess/) for AI-driven ticket management.
Read + follow ticket workflow rules in tess/agent-rules/tickets.md.
Tickets in [tickets/](tickets/) directory.

## Tending the garden

If asked to "tend the garden" or similar,the user wishes you to keep progress going by monitoring pending (fix/implement/plan/review) tickets, starting a background tess runner (`node tess/scripts/run.mjs`), and checking on things periodically (every 1-2 hours unless other cadence justified).  Don't interfere with other repo tess runners.

If more tickets needed and no systematic block, limited allowance to pull from root of backlog.  Maintain `tickets/.garden-report.md` and pull in pressing and clear tickets that require no human design decisions.  If nothing important, don't do busy-work; let user know and standy.
