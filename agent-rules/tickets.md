The tickets/ folder at the project root contains fix, plan, implement, review, blocked, and complete subfolders.  Each ticket is an md file under these folders, having a descriptive filename prefixed with a 1-5 priority (5 being highest priority).

You own the full stage transition.  When you are done:
  1. Create the next-stage output file(s) in the appropriate tickets/ subfolder.
     You may split one ticket into multiple next-stage tickets if warranted.
     You may keep or adjust the priority prefix as appropriate.
  2. Delete the original source ticket file from its current stage folder.
  3. Commit everything with a message like: "ticket(<stage>): <short description>"
* **Important**: Only proceed if you are clear on the ticket after research.  If there are questions or important decisions, transition the ticket into the blocked/ folder, with appropriate question(s) and/or discussion of tradeoffs.

Stages:
- Fix - for bugs.  Start with a reproducing test case, or a trace modality if the issue is intermittent.  Once reproduced and researched, form one or more hypotheses as to the cause and correction.  Provided enough confidence, output is one or more implementation ticket file(s) in implement/.  References should be made to key files and documentation.  TODO sub-tasks should be at the bottom of the ticket file(s).  Split into multiple tickets if warranted.
- Plan - for features and enhancements.  Where feasible, begin with a test expressing the desired API or behavior.  After research, provided no major questions/options remain, output is one or more design and implement/ tickets.  References should be made to key files and documentation.  TODO sub-tasks should be at the bottom of the ticket file(s).  Don't switch to your agent's "planning mode" when working these tickets - that's too meta.  After planning, you may immediately proceed to implement iff: * the plan is concrete; * you haven't filled your context with a bunch of bunny trails (context is fresh); * no unresolved design questions remain; * the ticket doesn't indicate otherwise.
- Implement - These tickets are ready for implementation (fix, build, update, ...whatever the ticket specifies).  If more than one agent would be useful, without stepping on toes, spawn sub-agents.  Be sure the build and tests pass when done.  Once complete, output a distilled summary of the ticket, with emphasis on testing, validation and usage into the review/ folder and delete the ticket from implement/.
- Review - Inspect the code against all aspect-oriented criteria (SPP, DRY, modular, scalable, maintainable, performant, etc.).  Ensure there are tests for the ticket, and that the build and tests pass.  Try to look only at the interface points for the ticket initially to avoid biasing the tests towards the implementation.  Ensure that relevant docs are up-to-date.  Output to complete/ once the tests pass and code is solid.
- Blocked - For tickets with unresolved questions, important decisions, or unclear requirements.  Include the question(s) and/or discussion of tradeoffs.  A blocked ticket returns to the appropriate stage once the questions are resolved.
- Complete - Archived summary of finished work.  Contains what was built, key files, testing notes, and usage information.

Don't combine tickets unless they are tightly related.

For new tickets: put a new file into fix/ or plan/ but focus on the description/requirements of the issue or feature, expected behavior, use case, etc.  Don't do planning, don't add TODO items, or get ahead, unless you already possess key information that would be useful.

Ticket file template:

description: <brief description>
dependencies: <needed other tickets, modularity points, external libraries>
files: <optional list of known relevant files>
----
<timeless architecture description focused on prose, diagrams, and interfaces/types/schema>

<if applicable: TODO list of sub-tasks - avoid numbering of tasks, besides phases>
