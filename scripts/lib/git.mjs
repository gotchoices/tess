/**
 * Git operations: tess version stamp, per-ticket commit, migration commit, and the
 * clean-working-tree invariant the runner enforces before it starts any ticket.
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

/** Default ceiling on file deletions a single ticket commit may capture.  A transient or
 *  partial working tree (the cause of the engine-wipe incident) surfaces as a mass deletion
 *  far above any legitimate single-ticket change.  Override with TESS_MAX_DELETIONS. */
const DEFAULT_MAX_DELETIONS = 100;

/** Valid `--dirty-tree` modes, in help order. */
export const DIRTY_TREE_MODES = ['salvage', 'abort', 'ignore'];

/** Cap on how many dirty paths the reconcile notice lists before summarizing. */
const MAX_NOTICE_ENTRIES = 50;

/** Parse `git status --porcelain` output into `{ code, path }` entries.  `code` is the raw
 *  two-character XY status; `path` is the destination path for renames and copies.  Lines are
 *  NOT trimmed — the leading space of a worktree-only status (` M`, ` D`) is load-bearing, and
 *  trimming the whole blob would shift the first line's columns by one. */
function parsePorcelain(raw) {
	const entries = [];
	for (let line of String(raw ?? '').split('\n')) {
		if (line.endsWith('\r')) line = line.slice(0, -1);
		if (line.length < 4) continue;
		const code = line.slice(0, 2);
		let path = line.slice(3);
		// Rename/copy entries read `old -> new`; the destination is the path that exists now.
		if (code[0] === 'R' || code[0] === 'C') {
			const arrow = path.indexOf(' -> ');
			if (arrow !== -1) path = path.slice(arrow + 4);
		}
		entries.push({ code, path });
	}
	return entries;
}

/**
 * Probe the working tree.  Submodule *content* changes are excluded — the parent repo cannot
 * commit them, so they are not "dirt the runner can clean".  (A submodule whose HEAD moved
 * still shows up, because that gitlink bump IS committable.)  Without that exclusion, a repo
 * with a dirty submodule reads as permanently dirty and every salvage attempt stages nothing
 * and then fails with "nothing to commit", on every run.
 *
 * `exec` is injectable so tests can assert the command shape without a nested-repo fixture.
 *
 * NOTE: the exclusion also hides *uncommitted* submodule edits from `commitAll`, which used to
 * notice them by failing loudly with "nothing to commit".  Fine today — those edits were
 * unrecoverable from the parent either way, and agent rules already require committing inside
 * the submodule.  If the runner ever needs to warn about that state, it needs a second probe
 * (plain `git status --porcelain`, compared against this one), not a relaxation of this flag.
 */
export function inspectWorkingTree(cwd, { exec = execSync } = {}) {
	const raw = exec('git status --porcelain --ignore-submodules=dirty', { cwd, encoding: 'utf-8' });
	const entries = parsePorcelain(raw);
	const deletions = entries.filter(e => e.code[0] === 'D' || e.code[1] === 'D').length;
	return { dirty: entries.length > 0, entries, deletions };
}

/** Stage and commit all working-tree changes under one message.  Returns true if a commit
 *  was created.  `context` labels the abort message when the deletion guard trips.
 *
 *  NOTE: accepted tradeoff — this stages with `git add -A`, so it captures whatever is in the
 *  tree rather than only what the current ticket changed.  Per-ticket path tracking was weighed
 *  and declined: ticket agents touch arbitrary paths and the runner has no way to enumerate
 *  them.  What makes the unscoped sweep safe is the clean-tree invariant enforced by
 *  `reconcileWorkingTree` before any ticket agent starts — there is nothing foreign left for
 *  this to sweep.  Revisit if the runner ever learns which paths a ticket touched. */
export function commitAll(cwd, message, { context = message } = {}) {
	try {
		const probe = inspectWorkingTree(cwd);
		if (!probe.dirty) return false;

		// Safety guard: refuse to capture a spurious mass deletion (e.g. a transient/partial
		// working tree that drops a whole package).  Checked before `git add -A`, so on abort
		// nothing is staged and the working tree is left untouched for inspection.
		const maxDeletions = Number(process.env.TESS_MAX_DELETIONS ?? DEFAULT_MAX_DELETIONS);
		if (probe.deletions > maxDeletions) {
			console.error(`[runner] ABORTING commit for ${context}: ${probe.deletions} deletions exceed the safety threshold (${maxDeletions}).`);
			console.error('[runner] This looks like a spurious mass-deletion (transient/partial working tree), not an intended change.');
			console.error('[runner] Nothing was staged or committed; inspect with `git status` and re-run once the tree is intact.');
			console.error('[runner] If the deletion is genuinely intended, raise TESS_MAX_DELETIONS and re-run.');
			return false;
		}

		execSync('git add -A', { cwd, encoding: 'utf-8' });
		execSync(`git commit -m "${message}"`, { cwd, encoding: 'utf-8' });
		return true;
	} catch (err) {
		console.error(`[runner] Git commit failed: ${err.message}`);
		return false;
	}
}

/** Print the dirty-tree notice.  Every reconcile branch except the clean one prints this — the
 *  mis-attribution this whole mechanism exists to prevent happened silently, and a run that
 *  says nothing about a dirty tree is how it stayed invisible. */
function printDirtyNotice(entries, label, owner) {
	console.log(`[runner] Working tree dirty before ${label} — ${entries.length} uncommitted path(s):`);
	for (const e of entries.slice(0, MAX_NOTICE_ENTRIES)) {
		console.log(`[runner]     ${e.code} ${e.path}`);
	}
	if (entries.length > MAX_NOTICE_ENTRIES) {
		console.log(`[runner]     … +${entries.length - MAX_NOTICE_ENTRIES} more`);
	}
	if (owner) {
		console.log(`[runner]   Attributing to interrupted ticket: ${owner.stage}/${owner.slug}`);
	} else {
		console.log(`[runner]   No ticket in progress — cannot attribute this to a ticket.`);
	}
}

function salvageMessage(owner) {
	return owner
		? `ticket(${owner.stage}): ${owner.slug} (partial — salvaged from interrupted run)`
		: 'tess: salvage uncommitted working tree (no ticket in progress)';
}

/**
 * Enforce "the working tree is clean before a ticket runs".
 *
 * The runner cannot know which paths belong to the ticket it is about to start, but it does
 * know that anything already dirty belongs to something *else* — an interrupted agent, an
 * earlier ticket that committed nothing, or a human.  Committing that residue under its own
 * honest message is what keeps every unscoped `git add -A` in the runner from silently
 * mis-attributing it to the next ticket that happens to finish.
 *
 *   owner  — { stage, slug } the residue most plausibly belongs to, or null
 *   mode   — 'salvage' (default) | 'abort' | 'ignore'
 *
 * Returns `{ action: 'clean' | 'salvaged' | 'ignored' | 'abort', entries }`.
 */
export function reconcileWorkingTree(cwd, { owner = null, mode = 'salvage', noCommit = false, dryRun = false, label = 'the next ticket' } = {}) {
	const probe = inspectWorkingTree(cwd);
	if (!probe.dirty) return { action: 'clean', entries: [] };

	printDirtyNotice(probe.entries, label, owner);

	// `--dry-run` and `--no-commit` both mean "do not touch git", in every mode.
	if (dryRun || noCommit || mode === 'ignore') {
		const why = dryRun ? '--dry-run' : noCommit ? '--no-commit' : '--dirty-tree ignore';
		console.log(`[runner]   Left in place (${why}) — it will be swept into the next commit the runner makes.`);
		return { action: 'ignored', entries: probe.entries };
	}

	if (mode === 'abort') {
		console.error(`[runner]   Refusing to start with a dirty tree (--dirty-tree abort).  Commit or park it, then re-run:`);
		console.error(`[runner]     git commit -a -m "<what this work actually was>"`);
		console.error(`[runner]     git stash push -u -m "tess: pre-run working tree"`);
		return { action: 'abort', entries: probe.entries };
	}

	const message = salvageMessage(owner);
	if (commitAll(cwd, message, { context: owner ? owner.slug : 'working-tree salvage' })) {
		console.log(`[runner]   Salvaged as: ${message}`);
		console.log('[runner]   If that attribution is wrong, `git reset --soft HEAD~1` puts it back.');
		return { action: 'salvaged', entries: probe.entries };
	}

	// commitAll returned false: the deletion guard tripped, git failed, or the tree went clean
	// underneath us.  Re-probe to tell the benign race from the two real failures — proceeding
	// with a still-dirty tree is exactly the mis-attribution this function exists to prevent.
	const after = inspectWorkingTree(cwd);
	if (after.dirty) {
		console.error('[runner]   Salvage commit failed — refusing to continue with a dirty working tree.');
		return { action: 'abort', entries: after.entries };
	}
	console.log('[runner]   Tree went clean during salvage — continuing.');
	return { action: 'salvaged', entries: probe.entries };
}

/** Stage and commit all changes for a completed ticket.  Returns true if a commit was created. */
export function commitTicket(ticket, cwd) {
	return commitAll(cwd, `ticket(${ticket.stage}): ${ticket.slug}`, { context: ticket.slug });
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
