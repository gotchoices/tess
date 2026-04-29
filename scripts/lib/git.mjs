/**
 * Git operations: tess version stamp, per-ticket commit, migration commit.
 */

import { execSync } from 'node:child_process';
import { migrate, needsMigration, FORMAT_VERSION } from '../migrate.mjs';

/** Short sha of the tess submodule's HEAD, for the run banner. */
export function getTessVersion(tessRoot) {
	try {
		const hash = execSync('git log -1 --format=%h', { cwd: tessRoot, encoding: 'utf-8' }).trim();
		return hash;
	} catch {
		return 'unknown';
	}
}

/** Stage and commit all changes for a completed ticket.  Returns true if a commit was created. */
export function commitTicket(ticket, cwd) {
	try {
		// Check if there are any changes to commit
		const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8' }).trim();
		if (!status) return false;

		execSync('git add -A', { cwd, encoding: 'utf-8' });
		const msg = `ticket(${ticket.stage}): ${ticket.slug}`;
		execSync(`git commit -m "${msg}"`, { cwd, encoding: 'utf-8' });
		return true;
	} catch (err) {
		console.error(`[runner] Git commit failed: ${err.message}`);
		return false;
	}
}

/** Run migration if needed and commit the result.  Returns whether a commit was made. */
export async function runMigrationIfNeeded(ticketsDir, repoRoot, { noCommit, dryRun }) {
	if (!await needsMigration(ticketsDir)) return false;
	console.log('\n  Legacy ticket format detected — running migration to v' + FORMAT_VERSION + '...');
	const result = await migrate(ticketsDir, { dryRun });
	if (dryRun) {
		console.log(`    [dry-run] Would migrate ${result.migrated} ticket(s), rewrite ${result.rewrites} body/bodies.`);
		console.log('    Note: schedule below uses current (pre-migration) filenames and new ascending-seq');
		console.log('          ordering — it is REVERSED from what a real run will actually execute. To');
		console.log('          preview accurately: run `node tess/scripts/migrate.mjs`, commit, then re-dry-run.');
		return false;
	}
	console.log(`    Renamed ${result.renamed} ticket(s); rewrote ${result.rewrites} body/bodies; stamped .version=${FORMAT_VERSION}.`);
	if (noCommit) return false;
	try {
		const status = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf-8' }).trim();
		if (!status) return false;
		execSync('git add -A', { cwd: repoRoot, encoding: 'utf-8' });
		execSync(`git commit -m "tess: migrate ticket format to v${FORMAT_VERSION}"`, { cwd: repoRoot, encoding: 'utf-8' });
		console.log('    Committed migration.');
		return true;
	} catch (err) {
		console.error(`    Migration commit failed: ${err.message}`);
		return false;
	}
}
