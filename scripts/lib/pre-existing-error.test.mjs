import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { buildTriagePrompt, pruneKnownFailures, readLedgerEntries } from './pre-existing-error.mjs';
import { anchorFieldsOf, readProjectRules } from './project-rules.mjs';
import { makeBoard } from './test-board.mjs';

test('the triage prompt requires a filed fix/ ticket to carry one of the anchor fields the board accepts', async () => {
	const ticketsDir = await makeBoard({ rules: [['rubric.md', '---\nanchor-fields: features, aspects\n---\n']] });
	const anchorFields = anchorFieldsOf((await readProjectRules(ticketsDir)).rules);

	const prompt = buildTriagePrompt('failing test report', anchorFields);

	assert.match(prompt, /plus at least one anchor field \(`architecture:`, `features:`, `aspects:`\)/);
	assert.match(prompt, /## Report\n\nfailing test report$/);
});

test('with no anchor fields the triage prompt asks for none and offers architecture: as optional', () => {
	const prompt = buildTriagePrompt('failing test report', []);

	assert.doesNotMatch(prompt, /at least one anchor field/);
	assert.match(prompt, /`architecture:` line naming the project's testing document is\n\s+welcome but not required/);
});

// regression: tess-known-failure-ledger-is-inert-every-entry-fails-the-runner-parser
//
// Copied verbatim out of a live `tickets/.pre-existing-known.md`, not composed
// here: for a year every entry an agent actually wrote failed the parser, and a
// fixture written to the documented shape would have passed against a parser
// that tracked nothing. These four are the structurally distinct ones — a short
// plain entry, the longest (3036 chars, three pipes in its prose), one whose
// signature is a package name rather than a path and whose state is `one-off`,
// and one carrying a second arrow mid-prose that the greedy `.*` must skip past.
const LIVE_LEDGER_LINES = [
	"- `src/routes/org.test.ts` — `org routes — tier enforcement > enterprise (null max_team_members = unlimited) invites past every numeric tier cap` (line 463), `Error: Test timed out in 15000ms.` (`@sitecad/site-cad-backend`). Same cause and same run as the `api-keys` entry above, and the same shape: the test invites past every tier cap in one loop, paying the per-row lamina write cost once per invite. Passed alone at the same commit. → lamina-row-writes-cost-15ms-each | blocked | 2026-09-15",
	"- `src/routes/admin.test.ts` — **any** `beforeAll` hook in this file, `Error: Hook timed out in 10000ms.`, sometimes with a downstream `ProviderCloseWhileInflight: close while 1 op(s) in flight on node-fs handle '.../cluster.lamina'` as the describe's `afterAll` reaches `systemStore.shutdown()` while the abandoned hook's own write is still in flight (`@sitecad/site-cad-backend`). Same upstream lamina per-row write cost as the entries above: every hook in this file opens a fresh `SystemStore`/`WarehouseStore` pair and seeds its fixture with a run of sequential, unbatched lamina writes before the first assertion — `GET /api/admin/subscriptions — drill-down`'s (line 2710) runs ~28 (`createUser` ×2, `promoteToAdmin`, `createOrganization` ×2, `createSubscription` ×2, plus `seedPlanSwitchFixture`'s 17 subscription writes and 4 tier-change inserts); `GET /api/admin/metrics/subscriptions — plan switches, endings Stripe made, and downgrade rate`'s (line 2574) and `GET /api/admin/metrics/milestone-funnel`'s (line 3391) are the same shape (`createUser`/`seedAccount` plus per-fixture seed calls). The `ProviderCloseWhileInflight` is not a second defect: it is the expected shape of a hook-timeout race (vitest gives up awaiting the hook but does not cancel the promise chain still running inside `SystemStore`), the same mechanism the 2026-09-08 `account-purge-sweep.test.ts` FIXED note above describes for a timed-out test body; `SystemStore`'s `runBackground`/`drainBackground` seam (2026-08-22 FIXED note above) does not cover it because these writes are awaited by the hook's own code, not fire-and-forget. First isolated to the drill-down hook alone on 2026-09-23 from a throwaway CI dispatch (`--reporter=verbose`, run 35888831918) — the only failure in an otherwise-clean 34m24s run — then, on a same-day follow-up dispatch (run 35900605805, dev tip `de2e87c8f`) under heavier contention, three of this file's `beforeAll` hooks (drill-down, plan-switches, milestone-funnel) hit the same 10000ms hook timeout in one run, plus the already-listed `org.test.ts` enterprise-tier-cap entry above — the \"many files/hooks fail, one cause\" saturation shape, matching how the `library.test.ts` entry above generalized from a single describe to file-wide. That second run's own summary shows the mechanism is a slow run, not a genuine hang: `Test Files 2 failed | 176 passed (178)`, `Tests 1 failed | 3704 passed | 38 skipped (3743)`, 2452.53s test time inside a 42m15s job step, exit code 1 — a ~40-minute stretch with no completed-test output (because nothing completed) is not the same as the process never finishing or never printing a diagnosis. Confirmed the same way as the rest of this file: the whole file passed alone in this sandbox, `Test Files 1 passed (1)`, `Tests 228 passed (228)`, 77.7s wall / 74.66s test time, unloaded. Treat this entry as file-wide, like `library.test.ts` above — re-run the file alone before concluding a given hook here is something else. → lamina-row-writes-cost-15ms-each | blocked | 2026-09-23",
	"- `@sitecad/site-cad` — **any** file that imports `src/lib/db/lamina-scope.ts` (most of the database suite), dying during collection with `Error: Cannot find module '/@fs/…/lamina/packages/lamina-quereus/dist/<file>.js' imported from …/dist/index.js` and `Tests  no tests`. Observed once, 2026-09-24, after moving the lamina pin and rebuilding; not reproduced since, and not tracked by a ticket. A first read blamed the `experimental.fsModuleCache` transform cache; that was measured and ruled out. Read `docs/development-patterns.md` § *Reading a red test run* before triaging a recurrence — its last paragraph owns both the ruling-out and the two checks that do discriminate, and warns why clearing the cache is not one of them. → no tracking ticket | one-off | 2026-09-24",
	"- `packages/lamina-quereus-test/src/sqllogic/sqllogic.test.ts` and `packages/lamina-quereus-test/src/sqllogic/known-failures.test.ts` — **both fail during collection**, so no test registers: `Error: ENOENT: no such file or directory, scandir '/work/SiteCAD/quereus/packages/quereus/test/logic'` at `Module.listCorpusFiles src/sqllogic/corpus.ts:29:9`. Reproduced at `831aac55c` (`yarn workspace lamina-quereus-test test` → `Test Files 2 failed | 181 passed | 2 skipped`), dist guard exit 0; ruled out as build drift, since the corpus is read from the filesystem and no rebuild can produce it. **These are lamina's own tests, not SiteCAD's, and no SiteCAD lane runs them** — `scripts/test-affected.mjs:275` maps a lamina change onto the SiteCAD suites that chain the dist guard, never onto lamina's suites, and no `.github/workflows/*` job invokes them — so this is never red on this board and there is nothing here to gate. It is red on lamina's `main` and CI, where it is tracked in full (250+ lines of analysis, a recorded 2026-09-01 decision, and three dated recurrences) by `lamina/tickets/blocked/bug-sqllogic-corpus-read-from-sibling-checkout-not-the-pinned-engine.md`, also registered in `lamina/tickets/.pre-existing-known.md`. Cause in one line: `corpus.ts` locates the `.sqllogic` corpus by walking five levels up into a sibling `../quereus` git checkout, while the engine itself has come from npm since lamina `002f13ca` and the published tarball ships no `test/`. Note where that walk lands under a submodule — `<parent of the lamina checkout>/quereus`, i.e. **inside this project**, a directory no SiteCAD clone has or should have. Blocked on an upstream publish: `@quereus/quereus` must ship `test/logic/*.sqllogic` in `files` plus a `\"./package.json\"` `exports` entry (quereus board, `feat-publish-sqllogic-corpus-in-the-package`). Verified still unlanded on 2026-09-24 in 4.19.4, the newest release — two versions shipped since the last check without it. **Do not re-triage this from here.** Do not vendor the corpus or otherwise \"fix\" it on the SiteCAD side: option (b) was considered and a human took option (a) on lamina's board on 2026-09-01, and any fix belongs in the lamina submodule regardless. Confirm in one command: `ls /work/SiteCAD/quereus/packages/quereus/test/logic` — ENOENT means it is this. → bug-sqllogic-corpus-read-from-sibling-checkout-not-the-pinned-engine | blocked | 2026-09-24",
];

test("ledger entries as agents actually write them parse — prose between the signature and the tail included", async () => {
	const ticketsDir = await makeBoard();
	await writeFile(join(ticketsDir, ".pre-existing-known.md"), ["# Known pre-existing failures (tess)", "", ...LIVE_LEDGER_LINES, ""].join("\n"), "utf-8");

	const entries = await readLedgerEntries(ticketsDir);

	assert.deepEqual(entries, [
		{ signature: "src/routes/org.test.ts", slug: "lamina-row-writes-cost-15ms-each", state: "blocked" },
		{ signature: "src/routes/admin.test.ts", slug: "lamina-row-writes-cost-15ms-each", state: "blocked" },
		{ signature: "@sitecad/site-cad", slug: "no tracking ticket", state: "one-off" },
		{
			signature: "packages/lamina-quereus-test/src/sqllogic/sqllogic.test.ts",
			slug: "bug-sqllogic-corpus-read-from-sibling-checkout-not-the-pinned-engine",
			state: "blocked",
		},
	]);
});

// regression: tess-known-failure-ledger-is-inert-every-entry-fails-the-runner-parser
test('the prune drops an entry only when its tracker resolves to complete/ — an unfindable slug is kept and reported', async () => {
	const ticketsDir = await makeBoard(
		{ complete: ['landed-fix.md'], blocked: ['still-parked.md'] },
		{ tombstones: [{ slug: 'swept-fix', completedAt: '2026-01-02', commit: 'abc1234' }] },
	);
	const ledger = [
		'# Known pre-existing failures (tess)',
		'',
		'- `a.test.ts` — prose → landed-fix | in-flight | 2026-01-01',
		'- `b.test.ts` — prose → swept-fix | blocked | 2026-01-01',
		'- `c.test.ts` — prose → still-parked | blocked | 2026-01-01',
		'- `d.test.ts` — prose → tracked-on-another-board | blocked | 2026-01-01',
		'- `e.test.ts` — prose → no tracking ticket | one-off | 2026-01-01',
		'',
	].join('\n');
	await writeFile(join(ticketsDir, '.pre-existing-known.md'), ledger, 'utf-8');

	const result = await pruneKnownFailures(ticketsDir, dirname(ticketsDir), { noCommit: true });

	// Pruned: the tracker landed in complete/, and the tracker that landed and was
	// then swept off the board (tombstones index as complete/ too).
	assert.deepEqual(result.slugs.sort(), ['landed-fix', 'swept-fix']);
	// Kept and reported: absence from the board is a typo or a cross-repo tracker
	// as often as it is a landed fix, so it never justifies deleting the entry.
	assert.deepEqual(result.unresolved, ['tracked-on-another-board']);

	const after = await readFile(join(ticketsDir, '.pre-existing-known.md'), 'utf-8');
	assert.equal(after.includes('a.test.ts'), false);
	assert.equal(after.includes('b.test.ts'), false);
	assert.match(after, /^# Known pre-existing failures \(tess\)$/m);
	for (const sig of ['c.test.ts', 'd.test.ts', 'e.test.ts']) assert.ok(after.includes(sig), `${sig} should survive`);
});

// regression: the sweep deleted the whole file once its last entry resolved, taking
// the `<!-- FIXED ... -->` records with it — 485 of this repo's 497 ledger lines.
test('a ledger whose last entry prunes keeps its human notes, and is removed only when nothing but the heading is left', async () => {
	const withNotes = await makeBoard({ complete: ['landed-fix.md'] });
	const bare = await makeBoard({ complete: ['landed-fix.md'] });
	const entry = '- `a.test.ts` — prose → landed-fix | in-flight | 2026-01-01';
	const note = '<!-- FIXED 2026-01-03 — root cause found and fixed in place; no ticket. -->';
	await writeFile(join(withNotes, '.pre-existing-known.md'), ['# Known', '', note, '', entry, ''].join('\n'), 'utf-8');
	await writeFile(join(bare, '.pre-existing-known.md'), ['# Known', '', entry, ''].join('\n'), 'utf-8');

	assert.equal((await pruneKnownFailures(withNotes, dirname(withNotes), { noCommit: true })).removed, 1);
	assert.equal((await pruneKnownFailures(bare, dirname(bare), { noCommit: true })).removed, 1);

	const after = await readFile(join(withNotes, '.pre-existing-known.md'), 'utf-8');
	assert.ok(after.includes(note), 'the FIXED record must survive the sweep');
	assert.equal(after.includes('a.test.ts'), false);
	await assert.rejects(readFile(join(bare, '.pre-existing-known.md'), 'utf-8'), { code: 'ENOENT' });
});
