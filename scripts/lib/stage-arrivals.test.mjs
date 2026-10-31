import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { arrivalsFromLog, stageArrivals } from './stage-arrivals.mjs';
import { commitAt, git } from './test-board.mjs';

const tempDirs = [];
after(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60;
const T1 = 1_700_000_000;
const T2 = T1 + 10 * DAY;
const T3 = T1 + 20 * DAY;

async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), 'tess-stage-arrivals-test-'));
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

const backlogArrivals = (repo, options) => stageArrivals(join(repo, 'tickets'), 'backlog', options);

// ── stageArrivals over real history ──────────────────────────────────────

test('a ticket added at the top level of a stage arrives at its commit time; sub-folders and other stages are not tracked', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, async () => {
		await put(repo, 'tickets/backlog/foo.md', ticket('foo'));
		await put(repo, 'tickets/backlog/GA/later.md', ticket('later'));
		await put(repo, 'tickets/plan/planned.md', ticket('planned'));
	});

	assert.deepEqual(await backlogArrivals(repo), new Map([['foo', T1]]));
	assert.deepEqual(await stageArrivals(join(repo, 'tickets'), 'plan'), new Map([['planned', T1]]));
});

test('re-sequencing a ticket in place keeps its arrival', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));
	await commitAt(repo, T2, () => move(repo, 'tickets/backlog/foo.md', 'tickets/backlog/3-foo.md'));

	assert.deepEqual(await backlogArrivals(repo), new Map([['foo', T1]]));
});

test('renaming a top-level ticket to another slug carries its arrival to the new slug', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));
	await commitAt(repo, T2, () => move(repo, 'tickets/backlog/foo.md', 'tickets/backlog/bug-foo.md'));

	assert.deepEqual(await backlogArrivals(repo), new Map([['bug-foo', T1]]));
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
	assert.deepEqual(await backlogArrivals(repo), new Map([['foo', T1]]));
});

test('a ticket moved up from a sub-folder arrives when it reaches the top level', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/GA/foo.md', ticket('foo')));
	await commitAt(repo, T2, () => move(repo, 'tickets/backlog/GA/foo.md', 'tickets/backlog/foo.md'));

	assert.deepEqual(await backlogArrivals(repo), new Map([['foo', T2]]));
});

test('a ticket moved from the top level into a sub-folder has no arrival', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));
	await commitAt(repo, T2, () => move(repo, 'tickets/backlog/foo.md', 'tickets/backlog/GA/foo.md'));

	assert.deepEqual(await backlogArrivals(repo), new Map());
});

test('a ticket promoted to another stage and parked back arrives again', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));
	await commitAt(repo, T2, () => move(repo, 'tickets/backlog/foo.md', 'tickets/plan/foo.md'));
	await commitAt(repo, T3, () => move(repo, 'tickets/plan/foo.md', 'tickets/backlog/foo.md'));

	assert.deepEqual(await backlogArrivals(repo), new Map([['foo', T3]]));
});

test('a ticket deleted and filed again later arrives at the re-filing', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));
	await commitAt(repo, T2, () => unlink(join(repo, 'tickets/backlog/foo.md')));
	await commitAt(repo, T3, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));

	assert.deepEqual(await backlogArrivals(repo), new Map([['foo', T3]]));
});

test('an uncommitted ticket has no arrival', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/committed.md', ticket('committed')));
	await put(repo, 'tickets/backlog/fresh.md', ticket('fresh'));

	assert.deepEqual(await backlogArrivals(repo), new Map([['committed', T1]]));
});

test('a tickets directory below the repository top level is read with paths relative to it', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, async () => {
		await put(repo, 'project/tickets/backlog/foo.md', ticket('foo'));
		await put(repo, 'tickets/backlog/outside.md', ticket('outside'));
	});
	await commitAt(repo, T2, () => move(repo, 'project/tickets/backlog/foo.md', 'project/tickets/backlog/3-foo.md'));

	assert.deepEqual(await backlogArrivals(join(repo, 'project')), new Map([['foo', T1]]));
});

test('a ticket added on a merged branch arrives at its own commit, not at the merge', async () => {
	const repo = await makeRepo();
	await commitAt(repo, T1, () => put(repo, 'tickets/backlog/foo.md', ticket('foo')));
	const mainBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
	git(repo, ['checkout', '-q', '-b', 'side']);
	await commitAt(repo, T2, () => put(repo, 'tickets/backlog/bar.md', ticket('bar')));
	git(repo, ['checkout', '-q', mainBranch]);
	await commitAt(repo, T2 + DAY, () => put(repo, 'tickets/backlog/baz.md', ticket('baz')));
	const date = `${T3} +0000`;
	git(repo, ['merge', '-q', '--no-ff', '--no-edit', 'side'], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });

	assert.deepEqual(await backlogArrivals(repo), new Map([['foo', T1], ['bar', T2], ['baz', T2 + DAY]]));
});

test('outside a git repository the map is empty and one warning is given', async () => {
	const dir = await tempDir();
	await put(dir, 'tickets/backlog/foo.md', ticket('foo'));
	// Keep git from finding a repository above the temp directory.
	const saved = process.env.GIT_CEILING_DIRECTORIES;
	process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
	try {
		const warnings = [];
		assert.deepEqual(await backlogArrivals(dir, { warn: message => warnings.push(message) }), new Map());
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /^could not read backlog\/ history from git \(.+\)$/);
	} finally {
		if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
		else process.env.GIT_CEILING_DIRECTORIES = saved;
	}
});

test('a repository with no commits yet gives an empty map and one warning', async () => {
	const repo = await makeRepo();
	await put(repo, 'tickets/backlog/foo.md', ticket('foo'));

	const warnings = [];
	assert.deepEqual(await backlogArrivals(repo, { warn: message => warnings.push(message) }), new Map());
	assert.equal(warnings.length, 1);
});

// ── arrivalsFromLog ──────────────────────────────────────────────────────

test('a copy onto the top level arrives, and modifications change nothing', () => {
	const log = [
		'--tess-commit 100',
		'',
		'A\tbacklog/foo.md',
		'--tess-commit 200',
		'',
		'C075\tbacklog/foo.md\tbacklog/bar.md',
		'M\tbacklog/foo.md',
	].join('\n');

	assert.deepEqual(arrivalsFromLog(log, 'backlog'), new Map([['foo', 100], ['bar', 200]]));
});

test('paths are matched under the given stage, with CRLF output tolerated', () => {
	const log = '--tess-commit 100\r\n\r\nA\timplement/foo.md\r\nA\tbacklog/other.md\r\nA\timplementation/near-miss.md\r\n';

	assert.deepEqual(arrivalsFromLog(log, 'implement'), new Map([['foo', 100]]));
});
