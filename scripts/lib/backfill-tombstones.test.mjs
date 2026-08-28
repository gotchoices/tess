import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { backfillTombstones } from './backfill-tombstones.mjs';
import { pruneCompletedTickets } from './prune-completed.mjs';
import { TOMBSTONE_FILE, readTombstones } from './tombstones.mjs';

const tempDirs = [];
after(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

const GIT_ENV = { 'user.name': 'tess-test', 'user.email': 'tess@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '' };

function git(cwd, args, extraEnv) {
	const flags = Object.entries(GIT_ENV).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
	return execFileSync('git', [...flags, ...args], { cwd, encoding: 'utf-8', env: { ...process.env, ...extraEnv } });
}

async function makeRepo() {
	const dir = await mkdtemp(join(tmpdir(), 'tess-backfill-test-'));
	tempDirs.push(dir);
	git(dir, ['init', '-q']);
	await mkdir(join(dir, 'tickets', 'complete'), { recursive: true });
	// A tracked placeholder outside complete/ — otherwise `git rm` on the last
	// completed ticket deletes tickets/complete/ (and tickets/ itself) as a
	// side effect of cleaning up now-empty directories, which a real project's
	// tickets/ directory (many other stage folders, the ledger itself) never hits.
	await writeFile(join(dir, 'tickets', '.keep'), '', 'utf-8');
	git(dir, ['add', '-A']);
	git(dir, ['commit', '-q', '-m', 'init tickets dir']);
	return dir;
}

/** Land a completed ticket `daysAgo` days in the past. Returns its landing commit sha. */
async function land(repo, filename, daysAgo) {
	// `git rm` on the last file in tickets/complete/ removes the now-empty directory too
	// (and tickets/ itself, if that was its only child) — recreate before writing.
	await mkdir(join(repo, 'tickets', 'complete'), { recursive: true });
	await writeFile(join(repo, 'tickets', 'complete', filename), `description: done\n----\nbody\n`, 'utf-8');
	git(repo, ['add', '-A']);
	const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
	git(repo, ['commit', '-q', '-m', `land ${filename}`], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
	return git(repo, ['rev-parse', 'HEAD']).trim();
}

/** Simulate a pre-tombstone-era sweep: delete completed tickets with no ledger write. */
async function oldStyleSweep(repo, filenames) {
	for (const f of filenames) git(repo, ['rm', '-q', `tickets/complete/${f}`]);
	git(repo, ['commit', '-q', '-m', `tess: prune ${filenames.length} completed ticket(s) older than 30 days`]);
	return git(repo, ['rev-parse', 'HEAD']).trim();
}

test('backfill reconstructs a tombstone for a ticket pruned before the ledger existed', async () => {
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');
	const sha = await land(repo, '3-session-store.md', 60);
	await oldStyleSweep(repo, ['3-session-store.md']);

	const result = await backfillTombstones(ticketsDir, repo);

	assert.equal(result.sweeps, 1);
	assert.equal(result.added.length, 1);
	const tombstones = await readTombstones(ticketsDir);
	const tomb = tombstones.get('session-store');
	assert.ok(tomb, 'expected a backfilled tombstone keyed by slug, without the sequence prefix');
	assert.equal(tomb.file, '3-session-store.md');
	assert.equal(tomb.commit, sha);
	assert.match(tomb.completedAt, /^\d{4}-\d{2}-\d{2}$/);
	assert.ok(Date.parse(tomb.prunedAt), 'prunedAt should be an ISO timestamp');
});

test('re-running the backfill adds nothing once a sweep is already covered', async () => {
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');
	await land(repo, 'first-ticket.md', 60);
	await oldStyleSweep(repo, ['first-ticket.md']);

	const first = await backfillTombstones(ticketsDir, repo);
	assert.equal(first.added.length, 1);

	const second = await backfillTombstones(ticketsDir, repo);
	assert.equal(second.added.length, 0);

	const raw = await readFile(join(ticketsDir, TOMBSTONE_FILE), 'utf-8');
	assert.equal(raw.trim().split('\n').length, 1);
});

test('a sweep that already wrote a live tombstone is not backfilled again', async () => {
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');
	await land(repo, 'live-ticket.md', 60);
	// A "live" sweep — pruneCompletedTickets writes its own tombstone and commits both.
	await pruneCompletedTickets(ticketsDir, repo, { maxAgeDays: 30 });

	const result = await backfillTombstones(ticketsDir, repo);

	assert.equal(result.added.length, 0, 'the live-written tombstone already covers this deletion');
	const raw = await readFile(join(ticketsDir, TOMBSTONE_FILE), 'utf-8');
	assert.equal(raw.trim().split('\n').length, 1);
});

test('backfilled records land in sweep order, oldest first, across multiple old-style sweeps', async () => {
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');
	await land(repo, 'older.md', 90);
	await oldStyleSweep(repo, ['older.md']);
	await land(repo, 'newer.md', 60);
	await oldStyleSweep(repo, ['newer.md']);

	const result = await backfillTombstones(ticketsDir, repo);

	assert.equal(result.sweeps, 2);
	assert.deepEqual(result.added.map(r => r.slug), ['older', 'newer']);
});

test('dry run reports what would be added without writing the ledger', async () => {
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');
	await land(repo, 'dry-ticket.md', 60);
	await oldStyleSweep(repo, ['dry-ticket.md']);

	const result = await backfillTombstones(ticketsDir, repo, { dryRun: true });

	assert.equal(result.added.length, 1);
	assert.equal((await readTombstones(ticketsDir)).size, 0);
});

test('a slug pruned twice resolves to its newer landing, even though the older record is appended last', async () => {
	// The one ordering hazard the backfill introduces: reconstructed records are
	// historically old but land at the *end* of a ledger that already holds newer
	// live ones, so electing a slug's winner by file position would regress it.
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');

	const firstLanding = await land(repo, 'reopened.md', 90);
	await oldStyleSweep(repo, ['reopened.md']);          // pre-ledger: no tombstone written
	const secondLanding = await land(repo, 'reopened.md', 40);
	await pruneCompletedTickets(ticketsDir, repo, { maxAgeDays: 30 });  // live: tombstones the newer landing

	const result = await backfillTombstones(ticketsDir, repo);
	assert.deepEqual(result.added.map(r => r.commit), [firstLanding], 'only the pre-ledger landing needs reconstructing');

	const raw = await readFile(join(ticketsDir, TOMBSTONE_FILE), 'utf-8');
	const order = raw.trim().split('\n').map(l => JSON.parse(l).commit);
	assert.deepEqual(order, [secondLanding, firstLanding], 'the older record really is the last line');

	const tomb = (await readTombstones(ticketsDir)).get('reopened');
	assert.equal(tomb.commit, secondLanding, 'the most recent landing wins, not the last line');
});

test('two ticket files sharing a slug and a landing collapse into one tombstone', async () => {
	// Sequence prefixes are not part of a ticket's identity, so `3-x.md` and
	// `4-x.md` are one slug.  Pruned together from one landing commit, they
	// resolve identically, and two indistinguishable records would only confuse
	// a reader of the ledger.
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');

	await writeFile(join(repo, 'tickets', 'complete', '3-twin.md'), 'description: done\n----\nbody\n', 'utf-8');
	await writeFile(join(repo, 'tickets', 'complete', '4-twin.md'), 'description: done\n----\nbody\n', 'utf-8');
	git(repo, ['add', '-A']);
	git(repo, ['commit', '-q', '-m', 'land both twins in one commit']);
	const landing = git(repo, ['rev-parse', 'HEAD']).trim();
	await oldStyleSweep(repo, ['3-twin.md', '4-twin.md']);

	const result = await backfillTombstones(ticketsDir, repo);

	assert.deepEqual(result.added.map(r => r.file), ['3-twin.md'], 'one record, keyed by the first file in sweep order');
	assert.equal(result.added[0].commit, landing);
});

test('the CLI rejects an unrecognised argument instead of falling through to a real write', async () => {
	// The default mode writes, so a mistyped --dry-run must not be shrugged off.
	const repo = await makeRepo();
	const ticketsDir = join(repo, 'tickets');
	await land(repo, 'would-be-written.md', 60);
	await oldStyleSweep(repo, ['would-be-written.md']);

	const cli = fileURLToPath(new URL('../backfill-tombstones.mjs', import.meta.url));
	let status = 0;
	let stderr = '';
	try {
		execFileSync(process.execPath, [cli, '--project', repo, '--dryrun'], { encoding: 'utf-8', stdio: 'pipe' });
	} catch (err) {
		status = err.status;
		stderr = err.stderr;
	}

	assert.equal(status, 2);
	assert.match(stderr, /Unrecognised argument: --dryrun/);
	assert.equal((await readTombstones(ticketsDir)).size, 0, 'nothing was appended');
});
