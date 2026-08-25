/**
 * Prune stale tickets from tickets/complete/.
 *
 * Completed tickets are an archive of finished work; left unbounded the folder
 * grows forever.  This sweep removes any completed ticket whose landing commit
 * is older than a cutoff (default 30 days), keeping the archive recent.
 *
 * Age is measured by the file's most-recent git commit timestamp — not the
 * filesystem mtime, which a checkout resets — so it reflects when the ticket
 * actually landed in complete/.  Deletions are git-tracked, so anything pruned
 * stays recoverable from history.
 *
 * Deleting the file also deletes the board's only evidence that the work
 * landed, which silently turns every `prereq:` naming it into an unresolvable
 * slug.  So each removal first writes a tombstone (see lib/tombstones.mjs)
 * recording the slug, its landing date and the commit that last touched it;
 * prereq resolution consults those tombstones, and the ledger is committed
 * alongside the deletions it explains.
 */

import { readdir, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { execSync } from 'node:child_process';
import { appendTombstones, tombstonePath } from './tombstones.mjs';
import { parseSlug } from './tickets.mjs';

export const DEFAULT_PRUNE_AGE_DAYS = 30;

/**
 * Landing commit for a tracked path: `{ epoch, commit }` where `epoch` is the
 * commit time in unix seconds.  Null when the path is untracked or unknown.
 * One `git log` per ticket covers both the age check and the tombstone.
 */
function lastCommit(path, cwd) {
	try {
		const out = execSync(`git log -1 --format=%ct%x09%H -- "${path}"`, { cwd, encoding: 'utf-8' }).trim();
		if (!out) return null;
		const [ct, commit] = out.split('\t');
		const epoch = parseInt(ct, 10);
		return Number.isFinite(epoch) && commit ? { epoch, commit } : null;
	} catch {
		return null;
	}
}

/** Repo-root-relative, forward-slashed path — the form git pathspecs want. */
function gitPath(repoRoot, absolute) {
	return relative(repoRoot, absolute).split(sep).join('/');
}

/** Stage the complete/ deletions plus the tombstone ledger and commit them.  Returns true on commit. */
function commitPrune(count, maxAgeDays, repoRoot, ledgerPath) {
	const pathspec = `tickets/complete "${ledgerPath}"`;
	try {
		execSync(`git add -A -- ${pathspec}`, { cwd: repoRoot, encoding: 'utf-8' });
		const status = execSync(`git status --porcelain -- ${pathspec}`, { cwd: repoRoot, encoding: 'utf-8' }).trim();
		if (!status) return false;
		const msg = `tess: prune ${count} completed ticket(s) older than ${maxAgeDays} days`;
		execSync(`git commit -m "${msg}"`, { cwd: repoRoot, encoding: 'utf-8' });
		return true;
	} catch (err) {
		console.error(`[runner] Prune commit failed: ${err.message}`);
		return false;
	}
}

/**
 * Remove completed tickets older than `maxAgeDays` (by git landing date).
 *
 * In `dryRun`, reports what would be removed without touching the filesystem —
 * no tombstones are written either.
 * Untracked completed tickets (no commit history) are left alone — we can't
 * date them, and they were presumably just dropped in by hand.
 *
 * Returns `{ removed, files }` where `files` is the list of pruned filenames.
 */
export async function pruneCompletedTickets(ticketsDir, repoRoot, { maxAgeDays = DEFAULT_PRUNE_AGE_DAYS, dryRun = false, noCommit = false } = {}) {
	const completeDir = join(ticketsDir, 'complete');
	let entries;
	try {
		entries = await readdir(completeDir);
	} catch {
		return { removed: 0, files: [] };  // no complete/ folder yet
	}

	const cutoffEpoch = Math.floor(Date.now() / 1000) - maxAgeDays * 24 * 60 * 60;
	const stale = [];
	for (const entry of entries) {
		if (!entry.endsWith('.md')) continue;
		const path = join(completeDir, entry);
		const landing = lastCommit(path, repoRoot);
		if (landing == null) continue;        // untracked or unknown age — leave it
		if (landing.epoch < cutoffEpoch) stale.push({ file: entry, path, landing });
	}

	if (stale.length === 0) return { removed: 0, files: [] };

	const files = stale.map(s => s.file);
	if (dryRun) return { removed: stale.length, files, dryRun: true };

	// Tombstone first: a ledger entry for a file that then fails to unlink is
	// harmless (the board copy still wins on lookup), whereas the reverse order
	// would lose the record entirely if the process died mid-sweep.
	await appendTombstones(ticketsDir, stale.map(s => ({
		slug: parseSlug(s.file),
		file: s.file,
		completedAt: new Date(s.landing.epoch * 1000).toISOString().slice(0, 10),
		commit: s.landing.commit,
	})));

	for (const s of stale) {
		try {
			await unlink(s.path);
		} catch { /* race or permission; skip */ }
	}
	if (!noCommit) commitPrune(stale.length, maxAgeDays, repoRoot, gitPath(repoRoot, tombstonePath(ticketsDir)));

	return { removed: stale.length, files };
}
