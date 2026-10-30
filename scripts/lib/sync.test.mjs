/**
 * Tests for the per-ticket sync (lib/sync.mjs). Each case builds real throwaway git repos in the
 * OS temp dir — a bare "origin" plus one or two clones — and drives `syncAfterTicket` /
 * `sweepSyncBlocked` against them. The resolve agent itself is never really invoked: `agentRunner`
 * is injected with a fake that edits the working tree the way a real resolve turn would, so the
 * git-state verification in `runResolveAgent` (no remaining conflict markers, exit code) is
 * exercised for real.
 *
 *   cd tess && node --test scripts/lib/sync.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	syncAfterTicket, sweepSyncBlocked, readSyncBlocked, upstreamRef, splitUpstream,
	conflictedFiles, MAX_CONSECUTIVE_SYNC_FAILURES,
} from './sync.mjs';

// ── fixtures ────────────────────────────────────────────────────────────────

function run(cwd, cmd) {
	return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

function makeBareOrigin(t) {
	const dir = mkdtempSync(join(tmpdir(), 'tess-sync-origin-'));
	run(dir, 'git init -q --bare -b dev');
	t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* windows locks .git objects */ } });
	return dir;
}

/** Clone `originDir` into a fresh temp dir, with user/email set and `dev` tracked. */
function makeClone(t, originDir, label) {
	const dir = mkdtempSync(join(tmpdir(), `tess-sync-${label}-`));
	run(dir, `git clone -q "${originDir}" .`);
	run(dir, 'git config user.email tess@example.invalid');
	run(dir, 'git config user.name "tess test"');
	run(dir, 'git config commit.gpgsign false');
	t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* windows locks .git objects */ } });
	return dir;
}

/** Seed the bare origin with one commit on `dev`, via a throwaway seed clone. */
function seedOrigin(t, originDir, files) {
	const seed = makeClone(t, originDir, 'seed-tmp');
	for (const [name, content] of Object.entries(files)) writeFileSync(join(seed, name), content);
	run(seed, 'git add -A');
	run(seed, 'git commit -q -m seed');
	run(seed, 'git push -q origin dev');
}

function writeFile(dir, name, content) {
	mkdirSync(join(dir, name, '..'), { recursive: true });
	writeFileSync(join(dir, name), content);
}

function commit(dir, message) {
	run(dir, 'git add -A');
	run(dir, `git commit -q -m "${message}"`);
}

const headSha = dir => run(dir, 'git rev-parse HEAD').trim();
const originLog = originDir => run(originDir, 'git log --reverse --format=%s dev').trim().split('\n');

function makeCtx(repoRoot, overrides = {}) {
	const ticketsDir = join(repoRoot, 'tickets');
	const logsDir = join(ticketsDir, '.logs');
	mkdirSync(logsDir, { recursive: true });
	return {
		repoRoot,
		ticketsDir,
		opts: { agent: 'fake', noCommit: false, noSync: false, ...overrides.opts },
		tessVersion: 'test',
		logsDir,
	};
}

const fakeTicket = { stage: 'implement', slug: 'example-ticket', file: 'example-ticket.md' };

// ── upstreamRef / splitUpstream ──────────────────────────────────────────────

test('upstreamRef reads the tracked remote branch; null with none configured', (t) => {
	const origin = makeBareOrigin(t);
	seedOrigin(t, origin, { 'a.txt': 'a\n' });
	const clone = makeClone(t, origin, 'a');
	assert.equal(upstreamRef(clone), 'origin/dev');

	run(clone, 'git checkout -q -b no-upstream-branch'); // a fresh local branch tracks nothing by default
	assert.equal(upstreamRef(clone), null);
});

test('splitUpstream splits on the first slash only', () => {
	assert.deepEqual(splitUpstream('origin/dev'), { remote: 'origin', branch: 'dev' });
	assert.deepEqual(splitUpstream('origin/feature/x'), { remote: 'origin', branch: 'feature/x' });
});

// ── clean sync, no conflict ──────────────────────────────────────────────────

test('syncAfterTicket pushes a clean commit and resets the failure counter', async (t) => {
	const origin = makeBareOrigin(t);
	seedOrigin(t, origin, { 'a.txt': 'a\n' });
	const clone = makeClone(t, origin, 'a');
	writeFile(clone, 'b.txt', 'b\n');
	commit(clone, 'ticket(implement): example-ticket');
	const ctx = makeCtx(clone);
	ctx.syncConsecutiveFailures = 2; // simulate prior failures; a clean push must reset this

	const result = await syncAfterTicket(ctx, { ticket: fakeTicket });

	assert.equal(result.outcome, 'pushed');
	assert.equal(ctx.syncConsecutiveFailures, 0);
	assert.deepEqual(originLog(origin), ['seed', 'ticket(implement): example-ticket']);
	assert.equal(headSha(clone), run(origin, 'git rev-parse dev').trim());
});

test('syncAfterTicket is a no-op with --no-commit or --no-sync, and with no upstream', async (t) => {
	const origin = makeBareOrigin(t);
	seedOrigin(t, origin, { 'a.txt': 'a\n' });
	const clone = makeClone(t, origin, 'a');
	writeFile(clone, 'b.txt', 'b\n');
	commit(clone, 'ticket(implement): example-ticket');

	assert.equal((await syncAfterTicket(makeCtx(clone, { opts: { noCommit: true } }))).outcome, 'skipped');
	assert.equal((await syncAfterTicket(makeCtx(clone, { opts: { noSync: true } }))).outcome, 'skipped');

	run(clone, 'git branch --unset-upstream');
	assert.equal((await syncAfterTicket(makeCtx(clone))).outcome, 'no-upstream');
	// Nothing was pushed in any of the three cases.
	assert.deepEqual(originLog(origin), ['seed']);
});

test('syncAfterTicket reports nothing-to-sync when there are no unpushed commits', async (t) => {
	const origin = makeBareOrigin(t);
	seedOrigin(t, origin, { 'a.txt': 'a\n' });
	const clone = makeClone(t, origin, 'a');
	const result = await syncAfterTicket(makeCtx(clone));
	assert.equal(result.outcome, 'nothing-to-sync');
});

test('syncAfterTicket rebases a non-conflicting upstream advance before pushing', async (t) => {
	const origin = makeBareOrigin(t);
	seedOrigin(t, origin, { 'a.txt': 'a\n' });
	const clone = makeClone(t, origin, 'a');

	// Someone else lands a commit on a different file while our ticket is in flight.
	const other = makeClone(t, origin, 'other');
	writeFile(other, 'c.txt', 'c\n');
	commit(other, 'other work');
	run(other, 'git push -q origin dev');

	writeFile(clone, 'b.txt', 'b\n');
	commit(clone, 'ticket(implement): example-ticket');

	const result = await syncAfterTicket(makeCtx(clone), { ticket: fakeTicket });
	assert.equal(result.outcome, 'pushed');
	assert.deepEqual(originLog(origin), ['seed', 'other work', 'ticket(implement): example-ticket']);
	assert.ok(existsSync(join(clone, 'c.txt')), 'rebased in the other side\'s file');
});

// ── conflict → resolve agent ─────────────────────────────────────────────────

/** A fake `agentRunner` that resolves every currently-conflicted file to `content`, `git add`s it, and exits 0. */
function fakeResolver(content) {
	return async (_agent, _prompt, cwd) => {
		for (const f of conflictedFiles(cwd)) {
			writeFileSync(join(cwd, f), content);
			run(cwd, `git add -- "${f}"`);
		}
		return { exitCode: 0 };
	};
}

/** A fake `agentRunner` that reports success without actually resolving anything. */
async function lyingResolver() {
	return { exitCode: 0 };
}

/** A fake `agentRunner` that reports it gave up. */
async function givingUpResolver() {
	return { exitCode: 1 };
}

function makeConflict(t, origin) {
	seedOrigin(t, origin, { 'shared.txt': 'base\n' });
	const clone = makeClone(t, origin, 'a');

	const other = makeClone(t, origin, 'other');
	writeFileSync(join(other, 'shared.txt'), 'their change\n');
	commit(other, 'their change');
	run(other, 'git push -q origin dev');

	writeFileSync(join(clone, 'shared.txt'), 'our change\n');
	commit(clone, 'ticket(implement): example-ticket');
	return clone;
}

test('syncAfterTicket resolves a real conflict via the resolve agent and pushes', async (t) => {
	const origin = makeBareOrigin(t);
	const clone = makeConflict(t, origin);

	const result = await syncAfterTicket(makeCtx(clone), { ticket: fakeTicket, agentRunner: fakeResolver('resolved\n') });

	assert.equal(result.outcome, 'pushed');
	assert.equal(readFileSync(join(clone, 'shared.txt'), 'utf-8'), 'resolved\n');
	assert.deepEqual(originLog(origin), ['seed', 'their change', 'ticket(implement): example-ticket']);
	assert.deepEqual(conflictedFiles(clone), []);
	assert.ok(!existsSync(join(clone, '.git', 'rebase-merge')) && !existsSync(join(clone, '.git', 'rebase-apply')), 'rebase finished, not left mid-flight');
});

test('syncAfterTicket aborts and keeps the local commit when the resolve agent cannot actually resolve it', async (t) => {
	const origin = makeBareOrigin(t);
	const clone = makeConflict(t, origin);
	const localHead = headSha(clone);

	const result = await syncAfterTicket(makeCtx(clone), { ticket: fakeTicket, agentRunner: givingUpResolver });

	assert.equal(result.outcome, 'failed');
	assert.equal(headSha(clone), localHead, 'local commit preserved, not rewritten');
	assert.deepEqual(originLog(origin), ['seed', 'their change'], 'nothing pushed');
	assert.deepEqual(conflictedFiles(clone), [], 'rebase was aborted, not left conflicted');
	assert.ok(!existsSync(join(clone, '.git', 'rebase-merge')));
});

test('syncAfterTicket distrusts an exit-0 resolver that left conflict markers unresolved', async (t) => {
	const origin = makeBareOrigin(t);
	const clone = makeConflict(t, origin);
	const localHead = headSha(clone);

	const result = await syncAfterTicket(makeCtx(clone), { ticket: fakeTicket, agentRunner: lyingResolver });

	assert.equal(result.outcome, 'failed');
	assert.equal(headSha(clone), localHead);
	assert.deepEqual(originLog(origin), ['seed', 'their change']);
});

// ── post-rebase duplicate-slug gate ──────────────────────────────────────────

/**
 * Two independent, non-conflicting histories that each legitimately create a ticket file for the
 * same slug — one already on `origin/dev`, one in our own unpushed commit. Rebasing ours onto
 * theirs is a plain, non-overlapping file add on each side, so git never flags it as a conflict —
 * exactly the shape `check-ticket-slug-uniqueness.mjs` exists to catch after the fact.
 */
function makeDuplicateSlug(t, origin) {
	seedOrigin(t, origin, { 'seed.txt': 'seed\n' });
	const clone = makeClone(t, origin, 'a');

	const other = makeClone(t, origin, 'other');
	writeFile(other, 'tickets/complete/foo.md', 'description: x\n----\ndone\n');
	commit(other, 'ticket(complete): foo');
	run(other, 'git push -q origin dev');

	writeFile(clone, 'tickets/implement/foo.md', 'description: x\n----\nin progress\n');
	commit(clone, 'ticket(implement): foo');
	return clone;
}

/** A fake `agentRunner` that resolves a duplicate-slug finding by deleting the stale copy at `path` — it does not commit; the runner does that once the board is confirmed clean. */
function fakeDuplicateResolver(path) {
	return async (_agent, _prompt, cwd) => {
		run(cwd, `git rm -q -- "${path}"`);
		return { exitCode: 0 };
	};
}

test('syncAfterTicket catches a clean-rebase duplicate slug, resolves it, and pushes', async (t) => {
	const origin = makeBareOrigin(t);
	const clone = makeDuplicateSlug(t, origin);

	const result = await syncAfterTicket(makeCtx(clone), { ticket: fakeTicket, agentRunner: fakeDuplicateResolver('tickets/implement/foo.md') });

	assert.equal(result.outcome, 'pushed');
	assert.ok(!existsSync(join(clone, 'tickets', 'implement', 'foo.md')), 'stale copy removed');
	assert.ok(existsSync(join(clone, 'tickets', 'complete', 'foo.md')), 'the other side\'s copy kept');
	assert.deepEqual(originLog(origin), ['seed', 'ticket(complete): foo', 'ticket(implement): foo', 'sync: resolve duplicate ticket slug(s) found after implement/example-ticket']);
});

test('syncAfterTicket resets to the pre-rebase commit when a duplicate slug cannot be resolved', async (t) => {
	const origin = makeBareOrigin(t);
	const clone = makeDuplicateSlug(t, origin);
	const localHead = headSha(clone);

	const result = await syncAfterTicket(makeCtx(clone), { ticket: fakeTicket, agentRunner: givingUpResolver });

	assert.equal(result.outcome, 'failed');
	assert.equal(headSha(clone), localHead, 'local commit preserved, not rewritten');
	assert.deepEqual(originLog(origin), ['seed', 'ticket(complete): foo'], 'nothing pushed');
	assert.ok(existsSync(join(clone, 'tickets', 'implement', 'foo.md')), 'working tree restored, not left mid-resolve');
	assert.ok(!existsSync(join(clone, '.git', 'rebase-merge')) && !existsSync(join(clone, '.git', 'rebase-apply')));
});

// ── failure budget → .sync-blocked ───────────────────────────────────────────

test('repeated failures write .sync-blocked only once the budget is spent, and never before', async (t) => {
	const origin = makeBareOrigin(t);
	const clone = makeConflict(t, origin);
	const ctx = makeCtx(clone);

	for (let i = 1; i < MAX_CONSECUTIVE_SYNC_FAILURES; i++) {
		const result = await syncAfterTicket(ctx, { ticket: fakeTicket, agentRunner: givingUpResolver });
		assert.equal(result.outcome, 'failed', `attempt ${i} should not block yet`);
		assert.equal(await readSyncBlocked(ctx.ticketsDir), null);
	}

	const final = await syncAfterTicket(ctx, { ticket: fakeTicket, agentRunner: givingUpResolver });
	assert.equal(final.outcome, 'blocked');
	const onDisk = await readSyncBlocked(ctx.ticketsDir);
	assert.equal(onDisk.attempts, 1);
	assert.equal(onDisk.lastTicket, 'implement/example-ticket');
	assert.ok(onDisk.reason);
	assert.deepEqual(onDisk.ourCommits.length, 1);
});

// ── sweepSyncBlocked ──────────────────────────────────────────────────────────

test('sweepSyncBlocked is a no-op when there is nothing to sweep', async (t) => {
	const origin = makeBareOrigin(t);
	seedOrigin(t, origin, { 'a.txt': 'a\n' });
	const clone = makeClone(t, origin, 'a');
	const result = await sweepSyncBlocked(makeCtx(clone));
	assert.deepEqual(result, { blocked: false });
});

test('sweepSyncBlocked clears the file once the retry resolves cleanly', async (t) => {
	const origin = makeBareOrigin(t);
	const clone = makeConflict(t, origin);
	const ctx = makeCtx(clone);

	// Spend the budget (with a resolver that gives up) to produce a real .sync-blocked file.
	for (let i = 0; i < MAX_CONSECUTIVE_SYNC_FAILURES; i++) {
		await syncAfterTicket(ctx, { ticket: fakeTicket, agentRunner: givingUpResolver });
	}
	assert.ok(await readSyncBlocked(ctx.ticketsDir));

	// A fresh process (fresh ctx, counter reset) retries at startup — this time the resolver
	// actually fixes the conflict, same as a real agent turn that succeeds on a second look.
	const freshCtx = makeCtx(clone);
	const swept = await sweepSyncBlocked(freshCtx, { agentRunner: fakeResolver('resolved\n') });

	assert.equal(swept.blocked, false);
	assert.equal(await readSyncBlocked(ctx.ticketsDir), null, 'file cleared');
	assert.deepEqual(originLog(origin), ['seed', 'their change', 'ticket(implement): example-ticket']);
});

test('sweepSyncBlocked leaves the file untouched when sync is disabled for this run', async (t) => {
	const origin = makeBareOrigin(t);
	const clone = makeConflict(t, origin);
	const ctx = makeCtx(clone);
	for (let i = 0; i < MAX_CONSECUTIVE_SYNC_FAILURES; i++) {
		await syncAfterTicket(ctx, { ticket: fakeTicket, agentRunner: givingUpResolver });
	}
	const before = await readSyncBlocked(ctx.ticketsDir);

	const noSyncCtx = makeCtx(clone, { opts: { noSync: true } });
	const swept = await sweepSyncBlocked(noSyncCtx);

	assert.equal(swept.blocked, false, 'does not hold this run hostage to a block it never checked');
	assert.deepEqual(await readSyncBlocked(ctx.ticketsDir), before, 'file left exactly as it was — not cleared on a run that never verified it');
});

test('sweepSyncBlocked updates (not replaces) the record when the conflict recurs, and exits blocked', async (t) => {
	const origin = makeBareOrigin(t);
	const clone = makeConflict(t, origin);
	const ctx = makeCtx(clone);
	for (let i = 0; i < MAX_CONSECUTIVE_SYNC_FAILURES; i++) {
		await syncAfterTicket(ctx, { ticket: fakeTicket, agentRunner: givingUpResolver });
	}
	const before = await readSyncBlocked(ctx.ticketsDir);
	assert.equal(before.attempts, 1);

	const freshCtx = makeCtx(clone);
	const swept = await sweepSyncBlocked(freshCtx, { agentRunner: givingUpResolver });

	assert.equal(swept.blocked, true);
	const after = await readSyncBlocked(ctx.ticketsDir);
	assert.equal(after.firstBlockedAt, before.firstBlockedAt, 'first-blocked timestamp preserved');
	assert.equal(after.attempts, 2, 'attempts incremented, not reset');
});
