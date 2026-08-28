/**
 * One-shot reconstruction of tombstones for tickets pruned *before* the
 * tombstone ledger (`tickets/.pruned-tickets.jsonl`, see lib/tombstones.mjs)
 * existed.  Those sweeps deleted completed tickets without leaving a trace,
 * so any `prereq:` naming one of them now resolves to neither a live ticket
 * nor a tombstone — indistinguishable from a slug that never existed.
 *
 * The reconstruction needs no guessing: every prune is its own commit whose
 * subject starts `tess: prune `, `git show --diff-filter=D` on that commit
 * names exactly which tickets it deleted, and `git log` against the
 * commit's parent gives each deleted ticket's landing date and commit — the
 * same two values `pruneCompletedTickets` reads live.
 *
 * Idempotent by construction: a candidate record is skipped whenever its
 * `(slug, landing commit)` pair is already in the ledger, whether written
 * live by a later prune (once the ledger existed) or by an earlier run of
 * this same backfill.  Re-running always adds zero once the ledger is
 * complete — there is no separate "already ran" flag to maintain.
 */

import { appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { readTombstoneRecords, tombstonePath } from './tombstones.mjs';
import { parseSlug } from './tickets.mjs';

/** Commit subject prefix every prune sweep shares (see prune-completed.mjs's commitPrune). */
const SWEEP_GREP = '^tess: prune ';

// NOTE: one `git` process per deleted ticket, and execFileSync's default 1 MB
// stdout buffer.  Both are comfortable at the scale this was written for (the
// repo it was built against: 42 sweeps, 1342 tickets, 63 s measured, largest
// single sweep ~38 KB of paths).  If a project ever runs this over a history
// an order of magnitude larger, batch the per-ticket `git log` into one
// `--name-only` walk and pass an explicit `maxBuffer`.
function git(repoRoot, args) {
	return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

/** SHAs of every prune-sweep commit reachable from `ref`, oldest first. */
function findSweeps(repoRoot, ref) {
	const out = git(repoRoot, ['log', '--reverse', `--grep=${SWEEP_GREP}`, '-E', '--format=%H', ref]);
	return out ? out.split('\n') : [];
}

/** Ticket paths under tickets/complete/ that a sweep commit deleted. */
function deletedTickets(repoRoot, sweep) {
	const out = git(repoRoot, ['show', '--name-only', '--diff-filter=D', '--format=', sweep, '--', 'tickets/complete']);
	return out ? out.split('\n').filter(p => p.endsWith('.md')) : [];
}

/** `{ epoch, commit }` of the last commit to touch `path` as of just before `sweep`, or null. */
function landingBeforeSweep(repoRoot, sweep, path) {
	const out = git(repoRoot, ['log', '-1', '--format=%ct%x09%H', `${sweep}^`, '--', path]);
	if (!out) return null;
	const [ct, commit] = out.split('\t');
	const epoch = parseInt(ct, 10);
	return Number.isFinite(epoch) && commit ? { epoch, commit } : null;
}

/** A sweep commit's own commit time, in epoch seconds — stands in for the live `prunedAt`. */
function sweepEpoch(repoRoot, sweep) {
	return parseInt(git(repoRoot, ['show', '-s', '--format=%ct', sweep]), 10);
}

/** The dedup identity of a tombstone: one landing of one slug. */
function recordKey(slug, commit) {
	return `${slug} ${commit}`;
}

/**
 * Every `(slug, commit)` pair already in the ledger — every record, not just
 * whichever one `readTombstones` would elect as latest for a slug, because a
 * slug pruned twice must not have its older landing reconstructed on top.
 */
async function existingKeys(ticketsDir) {
	const keys = new Set();
	for (const record of await readTombstoneRecords(ticketsDir)) {
		if (record.commit) keys.add(recordKey(record.slug, record.commit));
	}
	return keys;
}

/**
 * Reconstruct and append the tombstones missing from the ledger.
 *
 * Walks every prune-sweep commit reachable from `ref` (default `HEAD`),
 * oldest first, and appends one record per deleted ticket not already
 * covered by an existing `(slug, commit)` pair in the ledger.  Records are
 * appended in sweep order so the ledger reads as a history, but nothing
 * depends on that: `readTombstones` elects a slug's winner by `completedAt`,
 * precisely because these reconstructed records land *after* the newer live
 * ones already in the file.
 *
 * In `dryRun`, computes and returns what would be added without touching
 * the ledger file.
 *
 * Returns `{ sweeps, added }` — `sweeps` is the number of prune commits
 * scanned, `added` the list of newly-appended (or, in dry-run, pending)
 * records.
 */
export async function backfillTombstones(ticketsDir, repoRoot, { ref = 'HEAD', dryRun = false } = {}) {
	const seen = await existingKeys(ticketsDir);
	const sweeps = findSweeps(repoRoot, ref);
	const added = [];

	for (const sweep of sweeps) {
		const prunedAt = new Date(sweepEpoch(repoRoot, sweep) * 1000).toISOString();
		const paths = deletedTickets(repoRoot, sweep).sort();
		for (const path of paths) {
			const landing = landingBeforeSweep(repoRoot, sweep, path);
			if (!landing) continue; // untracked before the sweep — nothing to reconstruct
			const file = basename(path);
			const slug = parseSlug(file);
			const key = recordKey(slug, landing.commit);
			if (seen.has(key)) continue; // already tombstoned — live write or an earlier backfill run
			seen.add(key);
			added.push({
				slug,
				file,
				completedAt: new Date(landing.epoch * 1000).toISOString().slice(0, 10),
				commit: landing.commit,
				prunedAt,
			});
		}
	}

	if (!dryRun && added.length > 0) {
		const lines = added.map(r => JSON.stringify(r) + '\n').join('');
		await appendFile(tombstonePath(ticketsDir), lines, 'utf-8');
	}

	return { sweeps: sweeps.length, added };
}
