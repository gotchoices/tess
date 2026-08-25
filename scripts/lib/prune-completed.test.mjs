import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { pruneCompletedTickets } from './prune-completed.mjs';
import { TOMBSTONE_FILE, readTombstones } from './tombstones.mjs';

const tempDirs = [];
after(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** Run git in `cwd` with signing/hooks/identity forced to safe test values. */
function git(cwd, ...args) {
	return execFileSync('git', [
		'-c', 'user.name=tess-test',
		'-c', 'user.email=tess@example.invalid',
		'-c', 'commit.gpgsign=false',
		'-c', 'core.hooksPath=',
		...args,
	], { cwd, encoding: 'utf-8' });
}

/** A throwaway git repo with a `tickets/complete/` folder. */
async function makeRepo() {
	const dir = await mkdtemp(join(tmpdir(), 'tess-prune-test-'));
	tempDirs.push(dir);
	git(dir, 'init', '-q');
	await mkdir(join(dir, 'tickets', 'complete'), { recursive: true });
	return dir;
}

/** Add a completed ticket and commit it `daysAgo` days in the past. */
async function commitCompleted(repo, filename, daysAgo) {
	await writeFile(join(repo, 'tickets', 'complete', filename), `description: done\n----\nbody\n`, 'utf-8');
	git(repo, 'add', '-A');
	const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
	execFileSync('git', [
		'-c', 'user.name=tess-test',
		'-c', 'user.email=tess@example.invalid',
		'-c', 'commit.gpgsign=false',
		'-c', 'core.hooksPath=',
		'commit', '-q', '-m', `land ${filename}`,
	], { cwd: repo, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
	return git(repo, 'rev-parse', 'HEAD').trim();
}

test('pruning a stale completed ticket writes a tombstone naming its slug, date and landing commit', async () => {
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');
	const sha = await commitCompleted(repo, '3-session-store.md', 60);

	const result = await pruneCompletedTickets(ticketsDir, repo, { maxAgeDays: 30, noCommit: true });

	assert.equal(result.removed, 1);
	assert.deepEqual(await readdir(join(ticketsDir, 'complete')), []);

	const tombstones = await readTombstones(ticketsDir);
	const tomb = tombstones.get('session-store');
	assert.ok(tomb, 'expected a tombstone keyed by slug, without the sequence prefix');
	assert.equal(tomb.file, '3-session-store.md');
	assert.equal(tomb.commit, sha);
	assert.match(tomb.completedAt, /^\d{4}-\d{2}-\d{2}$/);
	assert.ok(Date.parse(tomb.prunedAt), 'prunedAt should be an ISO timestamp');
});

test('tombstones append rather than rewrite, so earlier prunes survive later ones', async () => {
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');

	await commitCompleted(repo, 'first-ticket.md', 60);
	await pruneCompletedTickets(ticketsDir, repo, { maxAgeDays: 30, noCommit: true });
	await commitCompleted(repo, 'second-ticket.md', 60);
	await pruneCompletedTickets(ticketsDir, repo, { maxAgeDays: 30, noCommit: true });

	const raw = await readFile(join(ticketsDir, TOMBSTONE_FILE), 'utf-8');
	assert.equal(raw.trim().split('\n').length, 2);
	const tombstones = await readTombstones(ticketsDir);
	assert.deepEqual([...tombstones.keys()].sort(), ['first-ticket', 'second-ticket']);
});

test('a fresh completed ticket is neither pruned nor tombstoned', async () => {
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');
	await commitCompleted(repo, 'recent-ticket.md', 1);

	const result = await pruneCompletedTickets(ticketsDir, repo, { maxAgeDays: 30, noCommit: true });

	assert.equal(result.removed, 0);
	assert.deepEqual(await readdir(ticketsDir), ['complete']);
});

test('a dry run reports the prune without deleting the ticket or writing a tombstone', async () => {
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');
	await commitCompleted(repo, 'dry-ticket.md', 60);

	const result = await pruneCompletedTickets(ticketsDir, repo, { maxAgeDays: 30, dryRun: true });

	assert.equal(result.removed, 1);
	assert.deepEqual(await readdir(join(ticketsDir, 'complete')), ['dry-ticket.md']);
	assert.equal((await readTombstones(ticketsDir)).size, 0);
});

test('the prune commit carries the tombstone ledger alongside the deletion', async () => {
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');
	await commitCompleted(repo, 'committed-ticket.md', 60);

	await pruneCompletedTickets(ticketsDir, repo, { maxAgeDays: 30 });

	const touched = git(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n');
	assert.ok(touched.includes(`tickets/${TOMBSTONE_FILE}`), `ledger missing from prune commit: ${touched.join(', ')}`);
	assert.ok(touched.includes('tickets/complete/committed-ticket.md'));
	assert.equal(git(repo, 'status', '--porcelain').trim(), '');
});
