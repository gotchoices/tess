/**
 * Git operations: tess version stamp, per-ticket commit, migration commit, and the
 * clean-working-tree invariant the runner enforces before it starts any ticket.
 */

import { execFileSync, execSync } from 'node:child_process';
import { migrate, needsMigration, FORMAT_VERSION } from '../migrate.mjs';
import { bypassesReview } from './tickets.mjs';

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
		// execFileSync, not execSync: the message carries the ticket slug, which comes from a
		// filename an agent wrote.  Interpolating that into a shell string let a slug containing
		// a quote, `$(…)` or a backtick corrupt the commit — or run.
		execFileSync('git', ['commit', '-m', message], { cwd, encoding: 'utf-8' });
		return true;
	} catch (err) {
		console.error(`[runner] Git commit failed: ${err.message}`);
		return false;
	}
}

/** Print the dirty-tree notice.  Every reconcile branch except the clean one prints this — the
 *  mis-attribution this whole mechanism exists to prevent happened silently, and a run that
 *  says nothing about a dirty tree is how it stayed invisible.
 *
 *  NOTE: `git status --porcelain` collapses a wholly-untracked directory into one `?? dir/`
 *  entry, so the count is a signal that something is there, not an inventory of what gets
 *  committed.  Fine while the notice exists to make a salvage visible; if it ever has to
 *  enumerate exactly what was swept, the probe needs `-uall` — which also makes it walk every
 *  file under a large untracked tree, on every ticket. */
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
 *   owner    — { stage, slug } the residue most plausibly belongs to, or null
 *   mode     — 'salvage' (default) | 'abort' | 'ignore'
 *   refusal  — why `abort` refuses, shown in the notice; defaults to the runner's flag
 *
 * Returns `{ action: 'clean' | 'salvaged' | 'ignored' | 'abort', entries }`.
 */
export function reconcileWorkingTree(cwd, { owner = null, mode = 'salvage', noCommit = false, dryRun = false, label = 'the next ticket', refusal = '--dirty-tree abort' } = {}) {
	// NOTE: this probe is deliberately NOT wrapped — a `git status` that throws (git missing, the
	// cwd not a repo, an `index.lock` held by a concurrent git command) fails the run at its first
	// step rather than letting it proceed over a tree whose state is unknown.  If lock contention
	// with a human working the same checkout ever makes startup flaky, retry the probe here; do
	// not degrade it into "assume clean".
	const probe = inspectWorkingTree(cwd);
	if (!probe.dirty) return { action: 'clean', entries: [] };

	printDirtyNotice(probe.entries, label, owner);

	// `--dry-run` never changes what happens or what the process exits with — it reports what a
	// real run would have done and leaves the tree exactly as it found it.
	if (dryRun) {
		const would = mode === 'abort'
			? `a real run would refuse to start (${refusal})`
			: mode === 'ignore'
				? 'a real run would leave it in place (--dirty-tree ignore)'
				: `a real run would salvage it as: ${salvageMessage(owner)}`;
		console.log(`[runner]   Left in place (--dry-run) — ${would}.`);
		return { action: 'ignored', entries: probe.entries };
	}

	// `abort` is a refusal to run, not a commit, so it outranks `--no-commit`: an operator who
	// asked the runner not to start on a dirty tree means it whether or not commits are enabled.
	if (mode === 'abort') {
		console.error(`[runner]   Refusing to start with a dirty tree (${refusal}).  Commit or park it, then re-run:`);
		console.error(`[runner]     git commit -a -m "<what this work actually was>"`);
		console.error(`[runner]     git stash push -u -m "tess: pre-run working tree"`);
		return { action: 'abort', entries: probe.entries };
	}

	if (noCommit || mode === 'ignore') {
		const why = noCommit ? '--no-commit' : '--dirty-tree ignore';
		console.log(`[runner]   Left in place (${why}) — it will be swept into the next commit the runner makes.`);
		return { action: 'ignored', entries: probe.entries };
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

/** Stage and commit all changes for a completed ticket.  Returns true if a commit was created.
 *
 *  A ticket that skipped its review stage says so here, after the `ticket(<stage>): <slug>`
 *  prefix the review rules grep for (`git log --grep="ticket(implement): <slug>"`), so the
 *  history still answers "why is there no review commit for this slug?" long after the run's
 *  console output is gone. */
export function commitTicket(ticket, cwd) {
	const skipped = bypassesReview(ticket) ? ' — review skipped (review: skip)' : '';
	return commitAll(cwd, `ticket(${ticket.stage}): ${ticket.slug}${skipped}`, { context: ticket.slug });
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
	// Through commitAll like every other commit the runner makes: same mass-deletion guard, and
	// the same `--ignore-submodules=dirty` probe (a plain `git status` reads a repo whose
	// submodule content is dirty as non-empty, then fails the commit with "nothing to commit").
	if (!commitAll(repoRoot, `tess: migrate ticket format to v${FORMAT_VERSION}`, { context: 'ticket-format migration' })) return false;
	console.log('    Committed migration.');
	return true;
}
