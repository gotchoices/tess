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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	syncAfterTicket, sweepSyncBlocked, readSyncBlocked, upstreamRef, splitUpstream,
	conflictedFiles, findSplitRaces, MAX_CONSECUTIVE_SYNC_FAILURES,
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
	for (const [name, content] of Object.entries(files)) writeFile(seed, name, content);
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

/** A fake `agentRunner` that resolves a post-rebase gate finding by deleting the ticket files at `paths` — it does not commit; the runner does that once the board is confirmed clean. */
function removingResolver(...paths) {
	return async (_agent, _prompt, cwd) => {
		run(cwd, `git rm -q -- ${paths.map(p => `"${p}"`).join(' ')}`);
		return { exitCode: 0 };
	};
}

test('syncAfterTicket catches a clean-rebase duplicate slug, resolves it, and pushes', async (t) => {
	const origin = makeBareOrigin(t);
	const clone = makeDuplicateSlug(t, origin);

	const result = await syncAfterTicket(makeCtx(clone), { ticket: fakeTicket, agentRunner: removingResolver('tickets/implement/foo.md') });

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

// ── split race: two checkouts splitting the same ticket differently ─────────

/** One commit of `ticketChanges` output: `changeset('ab12 subject', 'D plan/p.md', 'A implement/c.md')`. */
function changeset(summary, ...changes) {
	return { summary, changes: changes.map(c => { const [status, path] = c.split(' '); return { status, path }; }) };
}

test('findSplitRaces reports a ticket only when each side wrote successors the other did not', () => {
	// docs/DESIGN.md § Per-Ticket Sync: the split-race detection rule and its non-race shapes.
	const rows = [
		{
			name: 'different splits; one side split a child again and implemented a grandchild',
			ours: [changeset('o1 ticket(plan): p', 'D plan/p.md', 'A implement/a1.md', 'A implement/a2.md')],
			theirs: [
				changeset('t1 ticket(plan): p', 'D plan/p.md', 'A plan/b1.md', 'A implement/2-b2.md'),
				changeset('t2 ticket(implement): other', 'D implement/other.md', 'A review/other.md'),
				changeset('t3 ticket(plan): b1', 'D plan/b1.md', 'A implement/b1x.md', 'A implement/b1y.md'),
				changeset('t4 ticket(implement): b1x', 'D implement/b1x.md', 'A review/b1x.md'),
			],
			expected: [{
				parentPath: 'plan/p.md',
				ours: { only: ['a1', 'a2'], landed: false, commits: ['o1 ticket(plan): p'] },
				theirs: { only: ['b1', 'b1x', 'b1y', 'b2'], landed: true, commits: ['t1 ticket(plan): p', 't3 ticket(plan): b1', 't4 ticket(implement): b1x'] },
			}],
		},
		{
			name: 'partly overlapping splits, the shared child under different sequence prefixes',
			ours: [changeset('o1 ticket(plan): p', 'D plan/p.md', 'A implement/c.md', 'A implement/a1.md')],
			theirs: [changeset('t1 ticket(plan): p', 'D plan/p.md', 'A implement/3-c.md', 'A implement/b1.md')],
			expected: [{
				parentPath: 'plan/p.md',
				ours: { only: ['a1'], landed: false, commits: ['o1 ticket(plan): p'] },
				theirs: { only: ['b1'], landed: false, commits: ['t1 ticket(plan): p'] },
			}],
		},
		{
			name: 'the same stage move on both sides',
			ours: [changeset('o1 ticket(implement): x', 'D implement/x.md', 'A review/x.md')],
			theirs: [changeset('t1 ticket(implement): x', 'D implement/x.md', 'A review/x.md')],
			expected: [],
		},
		{
			name: 'the same move, one side also filing a backlog ticket',
			ours: [changeset('o1 ticket(implement): x', 'D implement/x.md', 'A review/x.md', 'A backlog/feat-y.md')],
			theirs: [changeset('t1 ticket(implement): x', 'D implement/x.md', 'A review/x.md')],
			expected: [],
		},
		{
			name: 'both prune sweeps deleting the same completed ticket',
			ours: [changeset('o1 tess: prune', 'D complete/old.md')],
			theirs: [changeset('t1 tess: prune', 'D complete/old.md')],
			expected: [],
		},
		{
			name: 'one side declined the ticket, the other worked it',
			ours: [changeset('o1 decline p', 'D plan/p.md')],
			theirs: [changeset('t1 ticket(plan): p', 'D plan/p.md', 'A implement/p1.md')],
			expected: [],
		},
	];
	const pick = ({ only, landed, commits }) => ({ only, landed, commits });
	for (const { name, ours, theirs, expected } of rows) {
		const races = findSplitRaces(ours, theirs).map(r => ({ parentPath: r.parentPath, ours: pick(r.ours), theirs: pick(r.theirs) }));
		assert.deepEqual(races, expected, name);
	}
});

/** Delete `tickets/plan/parent.md` and add one implement ticket per child, as a plan stage commit. */
function splitParent(dir, children) {
	rmSync(join(dir, 'tickets', 'plan', 'parent.md'));
	for (const child of children) writeFile(dir, `tickets/implement/${child}.md`, `description: ${child}\n----\nbody\n`);
	commit(dir, 'ticket(plan): parent');
}

/**
 * The 2026-11-13 incident: another checkout has pushed its split of `plan/parent.md` into
 * `b1..b3`, and ours split the same ticket into `a1..a4`. Both delete the same file and add
 * differently named ones, so the rebase is clean and the board repeats no slug.
 */
function makeSplitRace(t, origin) {
	seedOrigin(t, origin, { 'tickets/plan/parent.md': 'description: parent\n----\nbody\n' });
	const clone = makeClone(t, origin, 'a');
	const other = makeClone(t, origin, 'other');
	splitParent(other, ['b1', 'b2', 'b3']);
	run(other, 'git push -q origin dev');
	splitParent(clone, ['a1', 'a2', 'a3', 'a4']);
	return clone;
}

const implementFiles = clone => readdirSync(join(clone, 'tickets', 'implement')).sort();

test('syncAfterTicket discards our split when the upstream already holds a different split of the same ticket', async (t) => {
	// regression: self-sync-cant-see-two-checkouts-splitting-the-same-ticket-differently. Neither
	// split has code, so the one already pushed is kept.
	const origin = makeBareOrigin(t);
	const clone = makeSplitRace(t, origin);
	const ours = ['a1', 'a2', 'a3', 'a4'].map(s => `tickets/implement/${s}.md`);

	const result = await syncAfterTicket(makeCtx(clone), { ticket: fakeTicket, agentRunner: removingResolver(...ours) });

	assert.equal(result.outcome, 'pushed');
	assert.deepEqual(originLog(origin), ['seed', 'ticket(plan): parent', 'ticket(plan): parent', 'sync: discard duplicate split of parent found after implement/example-ticket']);
	assert.deepEqual(implementFiles(clone), ['b1.md', 'b2.md', 'b3.md']);
});

test('syncAfterTicket resets to the pre-rebase commit when a split race is left unresolved', async (t) => {
	// A resolve agent that cannot tell the splits apart changes nothing and exits 0 (its prompt
	// says so), so the board check, not the exit code, has to catch it.
	const origin = makeBareOrigin(t);
	const clone = makeSplitRace(t, origin);
	const localHead = headSha(clone);

	const result = await syncAfterTicket(makeCtx(clone), { ticket: fakeTicket, agentRunner: lyingResolver });

	assert.equal(result.outcome, 'failed');
	assert.equal(headSha(clone), localHead, 'local commit preserved, not rewritten');
	assert.deepEqual(originLog(origin), ['seed', 'ticket(plan): parent'], 'nothing pushed');
	assert.deepEqual(implementFiles(clone), ['a1.md', 'a2.md', 'a3.md', 'a4.md'], 'working tree restored');
});

test('a stage move and a prune made identically on both sides are not taken for a split race', async (t) => {
	const origin = makeBareOrigin(t);
	seedOrigin(t, origin, { 'tickets/implement/x.md': 'description: x\n----\nbody\n', 'tickets/complete/old.md': 'description: old\n----\ndone\n' });
	const clone = makeClone(t, origin, 'a');
	const other = makeClone(t, origin, 'other');
	for (const [dir, work] of [[other, 'their work'], [clone, 'our work']]) {
		writeFile(dir, 'tickets/review/x.md', 'description: x\n----\nbody\n');
		rmSync(join(dir, 'tickets', 'implement', 'x.md'));
		commit(dir, 'ticket(implement): x');
		rmSync(join(dir, 'tickets', 'complete', 'old.md'));
		commit(dir, 'tess: prune');
		writeFile(dir, `${work.replace(' ', '-')}.txt`, `${work}\n`);
		commit(dir, work);
	}
	run(other, 'git push -q origin dev');

	const result = await syncAfterTicket(makeCtx(clone), { ticket: fakeTicket, agentRunner: givingUpResolver });

	assert.equal(result.outcome, 'pushed', 'no resolve turn ran');
	assert.deepEqual(originLog(origin), ['seed', 'ticket(implement): x', 'tess: prune', 'their work', 'our work']);
});

// ── submodule checkouts follow a pin the rebase moved ────────────────────────

/** `git submodule` refuses a local-path remote unless told otherwise (CVE-2022-39253). */
const FILE_PROTOCOL = '-c protocol.file.allow=always';

/** A bare origin whose `dev` records the bare origin `subOrigin` as a submodule at `path`. */
function makeOriginWithSubmodule(t, subOrigin, path) {
	const origin = makeBareOrigin(t);
	const seed = makeClone(t, origin, 'seed-sub');
	run(seed, `git ${FILE_PROTOCOL} submodule add -q "${subOrigin}" ${path}`);
	commit(seed, `add ${path}`);
	run(seed, 'git push -q origin dev');
	return origin;
}

/** A bare superproject origin recording a submodule at `lib`; with `nested`, `lib` in turn records
 *  one at `deep`, and `inner.txt` lives there instead. */
function makeSubmoduleOrigin(t, { nested = false } = {}) {
	const leaf = makeBareOrigin(t);
	seedOrigin(t, leaf, { 'inner.txt': 'inner\n' });
	return makeOriginWithSubmodule(t, nested ? makeOriginWithSubmodule(t, leaf, 'deep') : leaf, 'lib');
}

/** `makeClone` with every submodule checked out at its pin and able to commit. */
function makeSubmoduleClone(t, origin, label) {
	const clone = makeClone(t, origin, label);
	run(clone, `git ${FILE_PROTOCOL} submodule update -q --init --recursive`);
	run(clone, 'git submodule foreach -q --recursive "git config user.email tess@example.invalid && git config user.name tess-test && git config commit.gpgsign false"');
	return { clone, lib: join(clone, 'lib') };
}

/** The other runner changes `inner.txt` in the innermost submodule of `levels`, moves every pin
 *  above it, and pushes each level while our ticket is in flight. */
function movePinUpstream(t, origin, levels = ['lib']) {
	const { clone } = makeSubmoduleClone(t, origin, 'other');
	const dirs = levels.map((_, i) => join(clone, ...levels.slice(0, i + 1)));
	writeFile(dirs.at(-1), 'inner.txt', 'newer\n');
	for (const dir of [...dirs.reverse(), clone]) {
		commit(dir, 'move forward');
		run(dir, 'git push -q origin HEAD:dev');
	}
}

test('a sync leaves a submodule checkout that was off the old pin where it is', async (t) => {
	// docs/DESIGN.md § The Clean-Tree Invariant: a checkout not on the pin may be there on purpose.
	const origin = makeSubmoduleOrigin(t);
	const ours = makeSubmoduleClone(t, origin, 'a');
	movePinUpstream(t, origin);
	writeFile(ours.lib, 'inner.txt', 'mid-edit\n');
	commit(ours.lib, 'local lib work');
	const localLib = headSha(ours.lib);
	writeFile(ours.clone, 'b.txt', 'b\n');
	run(ours.clone, 'git add b.txt'); // not `commit`: its `git add -A` would record the local lib commit as the pin
	run(ours.clone, 'git commit -q -m "ticket(implement): example-ticket"');

	const result = await syncAfterTicket(makeCtx(ours.clone), { ticket: fakeTicket });

	assert.equal(result.outcome, 'pushed');
	assert.equal(headSha(ours.lib), localLib);
});

test('a sync whose rebase moves a submodule pin checks out the new pin, nested submodules included, where the checkout sat on the old one', async (t) => {
	// regression: tess-per-ticket-sync-leaves-submodule-checkouts-behind-the-pin. The nested level:
	// a nested checkout left on the old commit is uncommitted content in the followed submodule, so
	// every later commit reports it stranded and the next follow refuses it as dirty.
	const origin = makeSubmoduleOrigin(t, { nested: true });
	const ours = makeSubmoduleClone(t, origin, 'a');
	movePinUpstream(t, origin, ['lib', 'deep']);
	writeFile(ours.clone, 'b.txt', 'b\n');
	commit(ours.clone, 'ticket(implement): example-ticket');

	const result = await syncAfterTicket(makeCtx(ours.clone), { ticket: fakeTicket });

	assert.equal(result.outcome, 'pushed');
	assert.equal(headSha(ours.lib), run(ours.clone, 'git rev-parse HEAD:lib').trim(), 'checkout is on the pin HEAD records');
	assert.equal(run(ours.clone, 'git status --porcelain'), '');
	assert.equal(run(ours.lib, 'git status --porcelain'), '', 'nested checkout is on the pin lib records');
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

test('a push refused by a local pre-push hook blocks at once, with the hook output as the reason', async (t) => {
	const origin = makeBareOrigin(t);
	seedOrigin(t, origin, { 'a.txt': 'a\n' });
	const clone = makeClone(t, origin, 'a');
	const hooks = mkdtempSync(join(tmpdir(), 'tess-sync-hooks-'));
	t.after(() => rmSync(hooks, { recursive: true, force: true }));
	writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\necho PIN-GUARD-MARKER >&2\nexit 1\n', { mode: 0o755 });
	run(clone, `git config core.hooksPath "${hooks}"`);
	writeFile(clone, 'b.txt', 'b\n');
	commit(clone, 'ticket(implement): example-ticket');
	const ctx = makeCtx(clone);

	const result = await syncAfterTicket(ctx, { ticket: fakeTicket });

	assert.equal(result.outcome, 'blocked');
	const onDisk = await readSyncBlocked(ctx.ticketsDir);
	assert.equal(onDisk.attempts, 1);
	assert.match(onDisk.reason, /PIN-GUARD-MARKER/);
	assert.deepEqual(originLog(origin), ['seed']);
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
