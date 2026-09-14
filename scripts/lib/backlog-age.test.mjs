import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { ageInDays, arrivalsFromLog, topLevelArrivals } from './backlog-age.mjs';

const tempDirs = [];
after(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60;
const T1 = 1_700_000_000;
const T2 = T1 + 10 * DAY;
const T3 = T1 + 20 * DAY;

/** Run git in `cwd` with identity, signing, hooks and line endings forced to safe test values. */
function git(cwd, args, env = {}) {
	return execFileSync('git', [
		'-c', 'user.name=tess-test',
		'-c', 'user.email=tess@example.invalid',
		'-c', 'commit.gpgsign=false',
		'-c', 'core.hooksPath=',
		'-c', 'core.autocrlf=false',
		...args,
	], { cwd, encoding: 'utf-8', env: { ...process.env, ...env } });
}

async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), 'tess-backlog-age-test-'));
	tempDirs.push(dir);
	return dir;
}

async function makeRepo() {
	const dir = await tempDir();
	git(dir, ['init', '-q']);
	return dir;
}

/** Ticket text long enough that git pairs an unedited move as a rename. */
const ticket = slug => `description: ${slug}\n----\n${`Body line about ${slug}, kept long for rename detection.\n`.repeat(20)}`;

async function put(root, rel, content) {
	await mkdir(dirname(join(root, rel)), { recursive: true });
	await writeFile(join(root, rel), content, 'utf-8');
}

async function move(root, from, to) {
	await mkdir(dirname(join(root, to)), { recursive: true });
	await rename(join(root, from), join(root, to));
}

/** Run `edits`, then commit everything with author and committer time `epoch`. */
async function commitAt(repo, epoch, edits) {
	await edits();
	git(repo, ['add', '-A']);
	const date = `${epoch} +0000`;
	git(repo, ['commit', '-q', '-m', `at ${epoch}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

// ── topLevelArrivals over real history ───────────────────────────────────

test('a ticket added at the top level of backlog/ arrives at its commit time; sub-folders and other stages are not tracked', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, async () => {
		await put(repo, 'tickets/backlog/foo.md', ticket('foo'));
		await put(repo, 'tickets/backlog/GA/later.md', ticket('later'));
		await put(repo, 'tickets/plan/planned.md', ticket('planned'));
	});

	assert.deepEqual(topLevelArrivals(repo), new Map([['foo', T1]]));
});

test('re-sequencing a ticket in place keeps its arrival', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));
	await commitAt(repo, T2, () => move(repo, 'tickets/backlog/foo.md', 'tickets/backlog/3-foo.md'));

	assert.deepEqual(topLevelArrivals(repo), new Map([['foo', T1]]));
});

test('renaming a top-level ticket to another slug carries its arrival to the new slug', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));
	await commitAt(repo, T2, () => move(repo, 'tickets/backlog/foo.md', 'tickets/backlog/bug-foo.md'));

	assert.deepEqual(topLevelArrivals(repo), new Map([['bug-foo', T1]]));
});

test('a re-sequence edited so heavily that git sees a delete and an add still keeps the arrival', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));
	await commitAt(repo, T2, async () => {
		await unlink(join(repo, 'tickets/backlog/foo.md'));
		await put(repo, 'tickets/backlog/3-foo.md', `description: rewritten\n----\n${'Entirely different wording after a merge.\n'.repeat(20)}`);
	});

	// Guard the premise: git must really have printed the add before the delete, not a rename.
	const status = git(repo, ['show', '--name-status', '--format=', 'HEAD']);
	assert.match(status, /^A\ttickets\/backlog\/3-foo\.md$/m);
	assert.match(status, /^D\ttickets\/backlog\/foo\.md$/m);
	assert.deepEqual(topLevelArrivals(repo), new Map([['foo', T1]]));
});

test('a ticket moved up from a sub-folder arrives when it reaches the top level', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/GA/foo.md', ticket('foo')));
	await commitAt(repo, T2, () => move(repo, 'tickets/backlog/GA/foo.md', 'tickets/backlog/foo.md'));

	assert.deepEqual(topLevelArrivals(repo), new Map([['foo', T2]]));
});

test('a ticket moved from the top level into a sub-folder has no arrival', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));
	await commitAt(repo, T2, () => move(repo, 'tickets/backlog/foo.md', 'tickets/backlog/GA/foo.md'));

	assert.deepEqual(topLevelArrivals(repo), new Map());
});

test('a ticket promoted to another stage and parked back arrives again', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));
	await commitAt(repo, T2, () => move(repo, 'tickets/backlog/foo.md', 'tickets/plan/foo.md'));
	await commitAt(repo, T3, () => move(repo, 'tickets/plan/foo.md', 'tickets/backlog/foo.md'));

	assert.deepEqual(topLevelArrivals(repo), new Map([['foo', T3]]));
});

test('a ticket deleted and filed again later arrives at the re-filing', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));
	await commitAt(repo, T2, () => unlink(join(repo, 'tickets/backlog/foo.md')));
	await commitAt(repo, T3, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));

	assert.deepEqual(topLevelArrivals(repo), new Map([['foo', T3]]));
});

test('an uncommitted ticket has no arrival', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/committed.md', ticket('committed')));
	await put(repo, 'tickets/backlog/fresh.md', ticket('fresh'));

	assert.deepEqual(topLevelArrivals(repo), new Map([['committed', T1]]));
});

test('outside a git repository the map is empty and one warning is given', async () => {
	const dir = await tempDir();
	await put(dir, 'tickets/backlog/foo.md', ticket('foo'));
	// Keep git from finding a repository above the temp directory.
	const saved = process.env.GIT_CEILING_DIRECTORIES;
	process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
	try {
		const warnings = [];
		assert.deepEqual(topLevelArrivals(dir, 'tickets', { warn: message => warnings.push(message) }), new Map());
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /^could not read backlog history from git \(.+\) — every backlog ticket's age reads new/);
	} finally {
		if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
		else process.env.GIT_CEILING_DIRECTORIES = saved;
	}
});

test('a repository with no commits yet gives an empty map and one warning', async () => {
	const repo = await makeRepo();
	await put(repo, 'tickets/backlog/foo.md', ticket('foo'));

	const warnings = [];
	assert.deepEqual(topLevelArrivals(repo, 'tickets', { warn: message => warnings.push(message) }), new Map());
	assert.equal(warnings.length, 1);
});

// ── arrivalsFromLog ──────────────────────────────────────────────────────

test('a copy onto the top level arrives, and modifications change nothing', () => {
	const log = [
		'--tess-commit 100',
		'',
		'A\ttickets/backlog/foo.md',
		'--tess-commit 200',
		'',
		'C075\ttickets/backlog/foo.md\ttickets/backlog/bar.md',
		'M\ttickets/backlog/foo.md',
	].join('\n');

	assert.deepEqual(arrivalsFromLog(log), new Map([['foo', 100], ['bar', 200]]));
});

test('paths are matched under the given tickets directory, with CRLF output tolerated', () => {
	const log = '--tess-commit 100\r\n\r\nA\twork/tickets/backlog/foo.md\r\nA\ttickets/backlog/other.md\r\n';

	assert.deepEqual(arrivalsFromLog(log, 'work/tickets'), new Map([['foo', 100]]));
});

// ── ageInDays ────────────────────────────────────────────────────────────

test('age counts whole days and never goes below zero', () => {
	assert.equal(ageInDays(T1, T1 + 60 * DAY - 1), 59);
	assert.equal(ageInDays(T1, T1 + 60 * DAY), 60);
	assert.equal(ageInDays(T1 + DAY, T1), 0);
});
