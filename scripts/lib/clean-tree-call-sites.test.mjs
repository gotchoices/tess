/**
 * Guards on *where* the clean-tree reconcile is called from.
 *
 * `git.test.mjs` covers `reconcileWorkingTree` in isolation, but the things that make the
 * invariant actually hold are placement, not behaviour:
 *
 *   - in `run.mjs`, the reconcile must precede the migration and completed-ticket-prune commits,
 *     which are unscoped sweeps that would otherwise absorb the residue before anyone saw it;
 *   - in `run-ticket.mjs`, it must sit *outside* the timeout-retry loop, since a retry's dirt is
 *     the current ticket's own partial work and salvaging it would split the ticket across two
 *     commits and defeat the resume-note mechanism;
 *   - in `garden.mjs`, it must precede both the gardening agent and the end-of-run commit, for
 *     the same reason as the other two — the agent adds edits of its own, and the commit is an
 *     unscoped sweep.
 *
 * All are the kind of thing a later refactor reorders without noticing, and none is
 * observable from a unit test of `git.mjs`.  Exercising them for real needs a stub agent adapter
 * that does not exist, so these assert over the source text instead: coarse, but they fail loudly
 * and name the invariant that broke.  Replace them the day the runner grows an injectable agent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(join(HERE, rel), 'utf-8');

/** Index of `needle` in `src`, asserting it is present exactly once. */
function soleIndex(src, needle, what) {
	const first = src.indexOf(needle);
	assert.notEqual(first, -1, `${what}: "${needle}" not found — was it renamed?`);
	assert.equal(src.indexOf(needle, first + 1), -1, `${what}: expected exactly one "${needle}"`);
	return first;
}

test('run.mjs reconciles before any commit-making startup step', () => {
	const src = read('../run.mjs');
	const reconcile = soleIndex(src, 'reconcileWorkingTree(repoRoot', 'run.mjs');

	for (const later of ['runMigrationIfNeeded(', 'pruneCompletedTickets(', 'pruneKnownFailures(']) {
		assert.ok(
			reconcile < soleIndex(src, later, 'run.mjs'),
			`${later} makes its own commit and must run AFTER the reconcile, or it sweeps up the residue first`,
		);
	}
});

test('run.mjs exits non-zero when a mid-run dirty tree halted the run', () => {
	const src = read('../run.mjs');
	assert.match(
		src,
		/if \(runCtx\.dirtyTreeHalt\)[\s\S]{0,400}process\.exit\(1\)/,
		'a halt the runner did not choose must not conclude with a clean exit 0',
	);
});

test('run.mjs hands the strategy the same context the final triage sweep reads', () => {
	const src = read('../run.mjs');
	// Two separate context objects would silently drop the per-run flags `runOneStage` sets.
	assert.match(src, /strategy\.run\(runCtx\)/);
	assert.match(src, /handlePreExistingError\(runCtx\)/);
});

test('run-ticket.mjs reconciles once per ticket, outside the retry loop', () => {
	const src = read('./run-ticket.mjs');
	const reconcile = soleIndex(src, 'reconcileWorkingTree(repoRoot', 'run-ticket.mjs');
	const retryLoop = soleIndex(src, 'while (attempt <= MAX_TIMEOUT_RETRIES)', 'run-ticket.mjs');
	const agentCall = soleIndex(src, 'await runAgent(', 'run-ticket.mjs');

	assert.ok(reconcile < retryLoop, 'a retry would otherwise split the current ticket across two commits');
	assert.ok(reconcile < agentCall, 'the tree must be clean before an agent is allowed to add edits of its own');
});

test('garden.mjs reconciles before its agent and its end-of-run commit', () => {
	const src = read('../garden.mjs');
	const reconcile = soleIndex(src, 'reconcileWorkingTree(repoRoot', 'garden.mjs');
	const agentCall = soleIndex(src, 'await runAgent(', 'garden.mjs');
	const commit = soleIndex(src, 'commitAll(repoRoot', 'garden.mjs');

	// Ordering against the commit alone would still pass with the reconcile sitting between the
	// agent and the commit — which salvages the gardener's own output under the salvage message.
	assert.ok(reconcile < agentCall, 'the tree must be clean before the gardener is allowed to add edits of its own');
	assert.ok(reconcile < commit, 'the end-of-run commit must run AFTER the reconcile, or it sweeps up the residue first');
});

test('every unscoped tree sweep in the runner goes through commitAll', () => {
	// A scoped `git add -- <path>` cannot pick up anything foreign and is fine on its own; a bare
	// `git add -A` outside commitAll is the exact shape this whole invariant exists to contain.
	const files = ['./git.mjs', './run-ticket.mjs', './pre-existing-error.mjs', './prune-completed.mjs', '../run.mjs', '../garden.mjs'];
	const offenders = [];
	for (const f of files) {
		for (const line of read(f).split('\n')) {
			if (!line.includes('execSync(')) continue;
			if (!/git add -A(?!\s*--)/.test(line)) continue;
			if (f === './git.mjs' && line.includes("execSync('git add -A', { cwd, encoding")) continue;  // commitAll itself
			offenders.push(`${f}: ${line.trim()}`);
		}
	}
	assert.deepEqual(offenders, [], `unscoped sweeps bypassing commitAll (and so its mass-deletion guard):\n${offenders.join('\n')}`);
});
