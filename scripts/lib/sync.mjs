/**
 * Per-ticket sync: after each ticket commits, rebase this checkout's unpushed commits onto its
 * upstream branch and push, so a runner checkout never drifts more than a ticket or two from the
 * shared remote. Design: team message "tess per-ticket sync: design Nate approved" (2026-10-30).
 *
 * Flow per attempt:
 *   1. Fetch the upstream remote/branch, rebase onto it.
 *   2. Clean rebase → push. A push rejected by a racing pusher retries fetch+rebase+push a
 *      bounded number of times (MAX_PUSH_RACE_RETRIES) rather than force-pushing.
 *   3. A conflicted rebase hands the conflict to one bounded agent turn per conflicting commit
 *      (runResolveAgent): it resolves the files in place, verifies the repo's own build/tests,
 *      and stops — it never runs rebase/commit/push itself. The runner trusts the agent's verdict
 *      only as far as the git state it left behind: exit 0 AND no remaining conflict markers is
 *      "resolved"; anything else is `git rebase --abort`.
 *   4. A resolve that fails leaves the local commit(s) in place, unpushed, and counts toward
 *      MAX_CONSECUTIVE_SYNC_FAILURES. Once that budget is spent, `.sync-blocked` is written and
 *      the caller (run-ticket.mjs) reports a `stopped` outcome so the run ends — a human (or a
 *      fresh restart, which re-attempts via `sweepSyncBlocked`) has to look at it.
 *
 * Hard rules carried over from the design: never force-push; never resolve a conflict by taking
 * one side wholesale (see buildResolvePrompt); push only commits a verification step passed.
 *
 * Deliberately not built yet: resolving a pure ticket-stage-move conflict (both sides only moved
 * the same ticket file between stage folders) mechanically, without an agent turn. The design
 * message calls this a "probably" optimization, not a requirement, and the rename/delete shapes
 * such a conflict can take are varied enough that a first cut risks mis-resolving exactly the
 * case this feature exists to get right. Every conflict goes through the resolve agent for now.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgent } from './process.mjs';

export const SYNC_BLOCKED_FILE = '.sync-blocked';

/** "a few tickets" (design message) before the runner gives up and stops for a human. */
export const MAX_CONSECUTIVE_SYNC_FAILURES = 3;

/** "retry a couple times" when a push loses a race to another pusher. */
export const MAX_PUSH_RACE_RETRIES = 2;

function runGit(cwd, args) {
	return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Never throws. `{ ok, output }` — `output` is stdout+stderr either way, for logging/diagnosis. */
function tryGit(cwd, args) {
	try {
		return { ok: true, output: runGit(cwd, args) };
	} catch (err) {
		return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message };
	}
}

/** HEAD's upstream as `remote/branch`, or null when none is configured (sync is then a no-op). */
export function upstreamRef(cwd) {
	try {
		return runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim() || null;
	} catch {
		return null;
	}
}

/** Split an `@{u}`-shaped ref on its first `/` — a remote name never contains one. */
export function splitUpstream(upstream) {
	const slash = upstream.indexOf('/');
	return { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) };
}

function isRebaseInProgress(cwd) {
	return existsSync(join(cwd, '.git', 'rebase-merge')) || existsSync(join(cwd, '.git', 'rebase-apply'));
}

/** Paths with unmerged (`U*`) index entries — empty once every conflict in the current rebase step is resolved and staged. */
export function conflictedFiles(cwd) {
	const out = tryGit(cwd, ['diff', '--name-only', '--diff-filter=U']);
	return out.ok ? out.output.split('\n').map(s => s.trim()).filter(Boolean) : [];
}

/** `["<short-sha> <subject>", ...]` for `range`, oldest first — what a conflict prompt shows for "our"/"their" commits. */
function commitSummaries(cwd, range) {
	const out = tryGit(cwd, ['log', '--reverse', '--format=%h %s', range]);
	return out.ok ? out.output.split('\n').map(s => s.trim()).filter(Boolean) : [];
}

function formatCommits(commits) {
	return commits.length === 0 ? '  (none)' : commits.map(c => `  - ${c}`).join('\n');
}

/**
 * The prompt for one bounded resolve turn. Gives the agent everything it has to reconcile by
 * hand — it cannot `git log` its way to "our" commits mid-rebase, since HEAD is a synthetic
 * mid-replay state — and is explicit that git-state transitions (`rebase --continue/--abort`,
 * `commit`, `push`) stay the runner's job: trusting the agent for those would make an unverifiable
 * "done" claim the only signal the runner has, which is exactly what it must not do (see
 * `runResolveAgent`'s own git-state check after the agent exits).
 */
function buildResolvePrompt({ ticket, upstream, conflicts, ourCommits, theirCommits, round }) {
	return [
		`# Sync conflict resolution (round ${round})`,
		'',
		`Rebasing this checkout's unpushed commit(s) onto \`${upstream}\` hit a conflict.`,
		ticket ? `The ticket just completed on this checkout: **${ticket.stage}/${ticket.slug}** (${ticket.file}).` : 'No specific ticket is attributed to this sync attempt (this is a startup retry of a previously blocked sync).',
		'',
		'## Our commit(s) being replayed onto the upstream tip',
		'',
		formatCommits(ourCommits),
		'',
		`## Commit(s) already on ${upstream} that this checkout did not have`,
		'',
		formatCommits(theirCommits),
		'',
		'## Files currently in conflict',
		'',
		...conflicts.map(f => `- \`${f}\``),
		'',
		'## Your job',
		'',
		'1. Resolve every conflict marker in the files above so the result reflects the real, intended content of BOTH sides. Never resolve by deleting one side wholesale or keeping only "ours"/"theirs" without reading what each side actually changed — a prior incident: a rebase resolved this way silently brought back a section the other side had deliberately deleted.',
		'2. If a conflict is purely a ticket file that moved between `tickets/` stage folders on both sides, resolve it to whichever location reflects real, confirmed progress — do not resurrect a stage the ticket has already moved past, and do not drop real content from either side.',
		'3. Once resolved, `git add` every file listed above — nothing else. Do not stage or touch files that are not in that list.',
		'4. Run this repository\'s own build and test commands for the package(s) the resolved files belong to — check its AGENTS.md / docs/development.md for the real commands rather than guessing. Confirm they pass before finishing.',
		'5. Do NOT run `git rebase --continue`, `git rebase --abort`, `git commit`, or `git push` — the runner does that once you are done. Do NOT create, move, or delete any ticket files beyond what resolving the conflict above requires.',
		'6. If you cannot safely resolve a conflict — content you cannot reconcile, or a test you cannot get to pass — leave it unresolved and say so plainly in your final message. Exit normally either way: the runner checks the actual git state, not your narration, and aborts the rebase itself if anything is still conflicted.',
		'',
		'Work only inside this repository\'s working tree. Nothing else is expected of you this turn.',
	].join('\n');
}

/**
 * Run one bounded resolve turn and report what the git state actually looks like afterward —
 * not what the agent claimed. `agentRunner` is injectable (tests supply a fake; production is
 * `runAgent` from lib/process.mjs).
 */
async function runResolveAgent(ctx, { ticket, upstream, conflicts, ourCommits, theirCommits, round }, { agentRunner = runAgent } = {}) {
	const { repoRoot, logsDir, opts, tessVersion } = ctx;
	const prompt = buildResolvePrompt({ ticket, upstream, conflicts, ourCommits, theirCommits, round });
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const logFile = join(logsDir, `sync-resolve.${ts}.round${round}.log`);
	await writeFile(logFile, [
		`Sync conflict resolve — round ${round}`,
		`Upstream: ${upstream}`,
		`Conflicted files: ${conflicts.join(', ') || '(none listed)'}`,
		`Agent: ${opts.agent}`,
		`Tess: ${tessVersion}`,
		`Started: ${new Date().toISOString()}`,
		'═'.repeat(72),
		'',
	].join('\n'));

	const result = await agentRunner(opts.agent, prompt, repoRoot, logFile, { stage: 'sync-resolve', difficulty: 'hard' });
	const stillConflicted = conflictedFiles(repoRoot);
	if (result.exitCode !== 0) {
		return { ok: false, reason: `resolve agent exited ${result.exitCode}`, logFile };
	}
	if (stillConflicted.length > 0) {
		return { ok: false, reason: `resolve agent exited 0 but left ${stillConflicted.length} file(s) still conflicted: ${stillConflicted.join(', ')}`, logFile };
	}
	return { ok: true, logFile };
}

/**
 * Rebase onto `upstream`, driving the resolve agent through as many conflict rounds as the
 * replay needs (bounded by one more than the number of local commits — a well-formed rebase
 * never needs more rounds than commits being replayed). Returns `{ ok, ourCommits, theirCommits,
 * conflictedFiles, reason? }`. On any failure the rebase is left aborted — the working tree is
 * exactly what it was before this call, local commits included.
 */
async function rebaseOntoUpstream(ctx, { upstream, ticket }, { agentRunner } = {}) {
	const { repoRoot } = ctx;
	const ourCommits = commitSummaries(repoRoot, `${upstream}..HEAD`);
	const theirCommits = commitSummaries(repoRoot, `HEAD..${upstream}`);

	if (ourCommits.length === 0) return { ok: true, ourCommits, theirCommits }; // nothing of ours to replay

	let rebase = tryGit(repoRoot, ['rebase', upstream]);
	let round = 0;
	const maxRounds = ourCommits.length + 1;

	while (!rebase.ok && isRebaseInProgress(repoRoot)) {
		round++;
		if (round > maxRounds) {
			tryGit(repoRoot, ['rebase', '--abort']);
			return { ok: false, reason: `needed more than ${maxRounds} conflict round(s) for ${ourCommits.length} commit(s) — aborting`, ourCommits, theirCommits, conflictedFiles: conflictedFiles(repoRoot) };
		}
		const conflicts = conflictedFiles(repoRoot);
		const resolved = await runResolveAgent(ctx, { ticket, upstream, conflicts, ourCommits, theirCommits, round }, { agentRunner });
		if (!resolved.ok) {
			tryGit(repoRoot, ['rebase', '--abort']);
			return { ok: false, reason: resolved.reason, ourCommits, theirCommits, conflictedFiles: conflicts };
		}
		// `-c core.editor=true`: every conflict is already staged with its original message intact,
		// so continuing never needs an editor — but refuse to let one hang the run if it ever does.
		rebase = tryGit(repoRoot, ['-c', 'core.editor=true', 'rebase', '--continue']);
	}

	if (!rebase.ok) {
		tryGit(repoRoot, ['rebase', '--abort']);
		return { ok: false, reason: `rebase failed: ${rebase.output.trim()}`, ourCommits, theirCommits, conflictedFiles: [] };
	}
	return { ok: true, ourCommits, theirCommits };
}

function pushUpstream(repoRoot, upstream) {
	const { remote, branch } = splitUpstream(upstream);
	// Explicit refspec, never `git push` bare: this must never become a force-push, and spelling
	// out `HEAD:<branch>` keeps that true regardless of how `push.default` is configured locally.
	return tryGit(repoRoot, ['push', remote, `HEAD:${branch}`]);
}

function syncBlockedPath(ticketsDir) {
	return join(ticketsDir, SYNC_BLOCKED_FILE);
}

export async function readSyncBlocked(ticketsDir) {
	try {
		return JSON.parse(await readFile(syncBlockedPath(ticketsDir), 'utf-8'));
	} catch {
		return null;
	}
}

/** Write (or update, preserving `firstBlockedAt`) the `.sync-blocked` record. Returns the record written. */
async function writeSyncBlocked(ticketsDir, { upstream, ticket, reason, ourCommits, theirCommits, conflictedFiles: files }) {
	const prior = await readSyncBlocked(ticketsDir);
	const now = new Date().toISOString();
	const record = {
		firstBlockedAt: prior?.firstBlockedAt ?? now,
		lastAttemptAt: now,
		attempts: (prior?.attempts ?? 0) + 1,
		upstream,
		lastTicket: ticket ? `${ticket.stage}/${ticket.slug}` : (prior?.lastTicket ?? null),
		reason,
		ourCommits,
		theirCommits,
		conflictedFiles: files,
	};
	await writeFile(syncBlockedPath(ticketsDir), JSON.stringify(record, null, '\t') + '\n', 'utf-8');
	return record;
}

export async function clearSyncBlocked(ticketsDir) {
	await unlink(syncBlockedPath(ticketsDir)).catch(() => {});
}

/**
 * Attempt to land this checkout's unpushed commits on `upstream`. Returns one of:
 *   { outcome: 'skipped' }       — sync disabled (`--no-commit` or `--no-sync`)
 *   { outcome: 'no-upstream' }   — HEAD has no upstream branch; sync is a no-op for this checkout
 *   { outcome: 'nothing-to-sync' } — no unpushed commits
 *   { outcome: 'pushed' }        — landed; `ctx.syncConsecutiveFailures` reset to 0
 *   { outcome: 'blocked', record } — hit MAX_CONSECUTIVE_SYNC_FAILURES; `record` is the
 *                                   `.sync-blocked` content (also written to disk)
 *   { outcome: 'failed' }        — this attempt failed but the budget isn't spent yet; local
 *                                   commit(s) kept, nothing pushed, try again after the next ticket
 *
 * `ticket` is the just-landed ticket for the resolve prompt's context, or null for the startup
 * sweep retry, which has no specific ticket to attribute the attempt to.
 */
export async function syncAfterTicket(ctx, { ticket = null, agentRunner } = {}) {
	const { repoRoot, ticketsDir, opts } = ctx;
	if (opts.noCommit || opts.noSync) return { outcome: 'skipped' };

	const upstream = upstreamRef(repoRoot);
	if (!upstream) {
		if (!ctx.syncNoUpstreamWarned) {
			console.warn('[runner] sync: HEAD has no upstream branch — per-ticket sync is disabled for this checkout.');
			ctx.syncNoUpstreamWarned = true;
		}
		return { outcome: 'no-upstream' };
	}
	const { remote, branch } = splitUpstream(upstream);

	for (let attempt = 0; attempt <= MAX_PUSH_RACE_RETRIES; attempt++) {
		const fetch = tryGit(repoRoot, ['fetch', remote, branch]);
		if (!fetch.ok) {
			// A network blip isn't a conflict the resolve agent could fix — don't burn the
			// consecutive-failure budget on it, just try again after the next ticket.
			console.error(`[runner] sync: fetch ${remote} ${branch} failed — ${fetch.output.trim()}`);
			return { outcome: 'failed' };
		}

		const rebased = await rebaseOntoUpstream(ctx, { upstream, ticket }, { agentRunner });
		if (!rebased.ok) {
			return await recordOrCountFailure(ctx, { upstream, ticket, ...rebased });
		}
		if (rebased.ourCommits.length === 0) return { outcome: 'nothing-to-sync' };

		const push = pushUpstream(repoRoot, upstream);
		if (push.ok) {
			ctx.syncConsecutiveFailures = 0;
			console.log(`[runner] sync: pushed ${rebased.ourCommits.length} commit(s) to ${upstream}.`);
			return { outcome: 'pushed' };
		}
		if (attempt < MAX_PUSH_RACE_RETRIES) {
			console.warn(`[runner] sync: push to ${upstream} rejected (attempt ${attempt + 1}/${MAX_PUSH_RACE_RETRIES + 1}) — another pusher won the race; retrying.`);
		}
	}

	return await recordOrCountFailure(ctx, { upstream, ticket, reason: `push kept losing the race to another pusher past ${MAX_PUSH_RACE_RETRIES} retries`, ourCommits: commitSummaries(repoRoot, `${upstream}..HEAD`), theirCommits: [], conflictedFiles: [] });
}

/** Bump the in-memory streak; only touch disk once the budget is actually spent. */
async function recordOrCountFailure(ctx, info) {
	ctx.syncConsecutiveFailures = (ctx.syncConsecutiveFailures ?? 0) + 1;
	console.error(`[runner] sync: did not land (failure ${ctx.syncConsecutiveFailures}/${MAX_CONSECUTIVE_SYNC_FAILURES}) — ${info.reason}. Local commit(s) kept; nothing pushed.`);
	if (ctx.syncConsecutiveFailures < MAX_CONSECUTIVE_SYNC_FAILURES) return { outcome: 'failed' };
	const record = await writeSyncBlocked(ctx.ticketsDir, info);
	return { outcome: 'blocked', record };
}

/**
 * Startup sweep: if a prior run left `.sync-blocked`, retry before picking any ticket. Success
 * clears the file and returns `{ blocked: false }`. A conflict that recurs updates the file (not
 * a fresh one — `writeSyncBlocked` preserves `firstBlockedAt`) and returns `{ blocked: true,
 * record }` so the caller can exit without touching the board. Nobody deletes the file by hand;
 * restarting tess IS the retry.
 */
export async function sweepSyncBlocked(ctx, { agentRunner } = {}) {
	const { ticketsDir, opts } = ctx;
	const existing = await readSyncBlocked(ticketsDir);
	if (!existing) return { blocked: false };

	// A run with sync disabled for itself (`--no-commit`/`--no-sync`) has no way to verify
	// whether the block is still real, and clearing the file on its say-so would throw away
	// that information for the next run that DOES sync. Leave the file alone and let this run
	// proceed anyway — it was never going to touch the remote regardless.
	if (opts.noCommit || opts.noSync) {
		console.log('[runner] .sync-blocked present, but sync is disabled for this run (--no-commit/--no-sync) — leaving it as-is and continuing.');
		return { blocked: false };
	}

	console.log(`[runner] .sync-blocked present (blocked since ${existing.firstBlockedAt}, ${existing.attempts} attempt(s)) — retrying before picking any ticket.`);
	// The startup retry isn't attributable to a specific ticket, and a prior failed attempt may
	// already have spent the whole in-run failure budget conceptually — but this is a fresh
	// process, so the streak starts at 0 and one more failure here writes straight back to the
	// same file (attempts increments, firstBlockedAt is preserved) rather than resetting the clock.
	ctx.syncConsecutiveFailures = MAX_CONSECUTIVE_SYNC_FAILURES - 1;
	const result = await syncAfterTicket(ctx, { ticket: null, agentRunner });
	if (result.outcome === 'pushed' || result.outcome === 'nothing-to-sync' || result.outcome === 'no-upstream') {
		await clearSyncBlocked(ticketsDir);
		console.log('[runner] .sync-blocked resolved — cleared, continuing startup.');
		return { blocked: false };
	}
	return { blocked: true, record: result.record ?? await readSyncBlocked(ticketsDir) };
}
