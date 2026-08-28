/**
 * Tombstones for pruned completed tickets.
 *
 * `prune-completed.mjs` deletes tickets from `tickets/complete/` once they age
 * out, which loses the only on-board evidence that the work landed.  Anything
 * resolving a `prereq:` slug afterwards — the runner, or an agent triaging a
 * ticket that names the pruned slug — cannot tell a *completed and pruned*
 * prereq from one that never existed, and has historically mis-triaged the
 * former as blocked-on-missing-work.
 *
 * So each prune first appends one tombstone per removed ticket to a single
 * git-tracked ledger, `tickets/.pruned-tickets.jsonl`.  JSON Lines because it
 * is append-only (no read-modify-write, so a prune costs one `open`+`write`
 * regardless of ledger size) and because concurrent runs or divergent branches
 * merge by union rather than conflicting on a rewritten document.
 *
 * One record per line:
 *   {"slug":"…","file":"…","completedAt":"2026-01-02","commit":"<sha>","prunedAt":"<iso>"}
 *
 * `completedAt` / `commit` come from the ticket file's last commit — the one
 * that put it in (or last touched it in) `complete/` — so the ledger answers
 * "did this land, and when?" without a `git log` archaeology pass.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Ledger filename, relative to the tickets directory. */
export const TOMBSTONE_FILE = '.pruned-tickets.jsonl';

/** Absolute path to the tombstone ledger for a given tickets directory. */
export function tombstonePath(ticketsDir) {
	return join(ticketsDir, TOMBSTONE_FILE);
}

/**
 * Append tombstone records to the ledger.  One write, no read-back — the file
 * is never rewritten, only extended.  Records are written in the order given.
 *
 * Each record: `{ slug, file, completedAt, commit }`; `prunedAt` is stamped
 * here so callers don't have to.  Returns the number of records appended.
 */
export async function appendTombstones(ticketsDir, records) {
	if (records.length === 0) return 0;
	const prunedAt = new Date().toISOString();
	const lines = records.map(r => JSON.stringify({ ...r, prunedAt }) + '\n').join('');
	await appendFile(tombstonePath(ticketsDir), lines, 'utf-8');
	return records.length;
}

/**
 * Every well-formed record in the ledger, in file order.  A missing ledger
 * yields an empty array; malformed lines (hand-edits, a torn write, a merge
 * artifact) are skipped rather than throwing, because a damaged ledger must
 * never stop a run.  A record carrying no usable `slug` is not a tombstone —
 * nothing can be looked up by it — so it is dropped here too.
 */
export async function readTombstoneRecords(ticketsDir) {
	let text;
	try {
		text = await readFile(tombstonePath(ticketsDir), 'utf-8');
	} catch {
		return [];
	}
	const records = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let record;
		try {
			record = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!record || typeof record.slug !== 'string' || !record.slug) continue;
		records.push(record);
	}
	return records;
}

/** A record's landing date as a sortable string; '' when absent, which sorts lowest. */
function landingKey(record) {
	return typeof record.completedAt === 'string' ? record.completedAt : '';
}

/**
 * Read the ledger into `slug → record`, keeping each slug's *most recent
 * landing*.
 *
 * A slug can legitimately appear more than once — a ticket reopened after
 * its first completion is completed and pruned again.  Which of those wins is
 * decided on `completedAt`, not on file order, because the ledger is appended
 * to from more than one direction and its line order is therefore not
 * chronological: two branches that both pruned merge by union in whatever
 * order the merge produces, and `backfill-tombstones.mjs` appends
 * historically-old reconstructed records to the end of a ledger that already
 * holds newer live ones.  Ties — and records with no `completedAt` at all —
 * fall back to the later line.
 */
export async function readTombstones(ticketsDir) {
	const bySlug = new Map();
	for (const record of await readTombstoneRecords(ticketsDir)) {
		const prior = bySlug.get(record.slug);
		if (prior && landingKey(prior) > landingKey(record)) continue;
		bySlug.set(record.slug, record);
	}
	return bySlug;
}
