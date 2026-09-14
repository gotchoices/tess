/**
 * Tests for shipping a release: lib/ship.mjs, and the release.mjs command
 * around it.
 *
 * Most cases build a board with `makeBoard`, make its parent directory a git
 * repository with one seed commit, and ship it.  Cases that ship with
 * `noCommit` and move nothing need no repository and skip it.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { commitAll } from './git.mjs';
import { applyShip, planShip } from './ship.mjs';
import { makeBoard, withHeader } from './test-board.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');

const RELEASES = '# Releases\n\nPreamble.\n\n## BETA\ndue: 2026-11-01\n\nBeta exit criteria.\n\n## GA\n\nGA exit criteria.\n\n## V2\n';
const AFTER_BETA = '# Releases\n\nPreamble.\n\n## GA\n\nGA exit criteria.\n\n## V2\n';

/** A `[filename, content]` ticket whose content is unique to its name, so git pairs each move with the right file. */
const ticket = (name, ...lines) => [name, withHeader(`files: ${name}`, ...lines)];

/** The board most cases ship: BETA current; GA's folder holds two tickets and one with a stale `target: BETA`. */
const shipBoard = () => ({
	backlog: [ticket('top.md')],
	'backlog/GA': [ticket('3-sync-ui.md'), ticket('export.md', 'target: GA'), ticket('stale.md', 'target: BETA')],
	'backlog/V2': [ticket('later.md')],
	plan: [ticket('session.md', 'target: BETA')],
	complete: [ticket('archived.md', 'target: BETA')],
});

/** `makeBoard`, in a git repository with one seed commit: `{ repoRoot, ticketsDir, git }`. */
async function makeRepo(places, options) {
	const ticketsDir = await makeBoard(places, options);
	const repoRoot = dirname(ticketsDir);
	const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' });
	git('init', '-q');
	git('config', 'user.email', 'tess@example.invalid');
	git('config', 'user.name', 'tess test');
	git('config', 'commit.gpgsign', 'false');
	git('config', 'core.autocrlf', 'false');  // cases compare bytes
	writeFileSync(join(ticketsDir, '.version'), '2\n');  // current format, so run.mjs has nothing to migrate
	git('add', '-A');
	git('commit', '-q', '-m', 'seed');
	return { repoRoot, ticketsDir, git };
}

const commitCount = repo => Number(repo.git('rev-list', '--count', 'HEAD').trim());
const subject = repo => repo.git('log', '-1', '--format=%s').trim();

/** Every file and directory under `root` except `.git`, as `path → content`; directory keys end in `/`. */
function snapshot(root, rel = '', into = {}) {
	for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
		if (entry.name === '.git') continue;
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			into[`${path}/`] = '';
			snapshot(root, path, into);
		} else {
			into[path] = readFileSync(join(root, path), 'latin1');
		}
	}
	return into;
}

/** Run `fn` with console output captured: `{ value, lines }`. */
async function captured(fn) {
	const lines = [];
	const original = { log: console.log, warn: console.warn, error: console.error };
	console.log = console.warn = console.error = (...args) => { lines.push(args.join(' ')); };
	try {
		return { value: await fn(), lines };
	} finally {
		Object.assign(console, original);
	}
}

/** Plan and apply a ship in `repo`, console captured: `{ plan, result, lines }`. */
async function ship(repo, options = {}) {
	const plan = await planShip(repo.ticketsDir);
	const { value: result, lines } = await captured(() => applyShip(plan, { repoRoot: repo.repoRoot, ...options }));
	return { plan, result, lines };
}

/** Run release.mjs with `cwd` as the project root. */
const release = (cwd, ...args) => spawnSync(process.execPath, [join(SCRIPTS, 'release.mjs'), ...args], { cwd, encoding: 'utf-8' });

// ── shipping ──────────────────────────────────────────────────────────────

test('ship moves the next release up, strips the shipped target:, drops the first entry, commits once, and leaves a board the runner accepts', async () => {
	const repo = await makeRepo(shipBoard(), { releases: RELEASES });
	const before = commitCount(repo);

	const { plan, result } = await ship(repo);

	assert.deepEqual(plan.errors, []);
	assert.equal(plan.shipped, 'BETA');
	assert.equal(plan.next, 'GA');
	assert.deepEqual(plan.moves, [
		{ from: 'backlog/GA/3-sync-ui.md', to: 'backlog/3-sync-ui.md' },
		{ from: 'backlog/GA/export.md', to: 'backlog/export.md' },
		{ from: 'backlog/GA/stale.md', to: 'backlog/stale.md' },
	]);
	assert.equal(plan.removeFolder, 'backlog/GA');
	assert.deepEqual(plan.strips, [{ path: 'backlog/GA/stale.md', line: 4 }, { path: 'plan/session.md', line: 4 }]);
	assert.deepEqual(result, { applied: true, committed: true });

	const tree = snapshot(repo.ticketsDir);
	assert.equal(tree['releases.md'], AFTER_BETA);
	assert.equal(tree['backlog/3-sync-ui.md'], ticket('3-sync-ui.md')[1]);
	assert.equal(tree['backlog/export.md'], ticket('export.md', 'target: GA')[1], 'target: GA names the current release once BETA ships');
	assert.equal(tree['backlog/stale.md'], ticket('stale.md')[1], 'a stale target: BETA in the GA folder is stripped, and the ticket still moves');
	assert.equal(tree['plan/session.md'], ticket('session.md')[1]);
	assert.equal(tree['complete/archived.md'], ticket('archived.md', 'target: BETA')[1], 'complete/ is an archive');
	assert.equal(tree['backlog/V2/later.md'], ticket('later.md')[1]);
	assert.equal(tree['backlog/GA/'], undefined, 'the emptied folder is removed');

	assert.equal(commitCount(repo), before + 1);
	assert.equal(subject(repo), 'tess: ship release BETA');
	assert.equal(repo.git('status', '--porcelain'), '');
	const changes = repo.git('show', '-M', '--name-status', '--format=', 'HEAD').trim().split('\n');
	assert.deepEqual(changes.filter(line => line.startsWith('D')), [], 'moves are committed as renames, not deletions');
	assert.equal(changes.filter(line => line.startsWith('R')).length, 3);

	const runner = spawnSync(process.execPath, [join(SCRIPTS, 'run.mjs'), '--dry-run'], { cwd: repo.repoRoot, encoding: 'utf-8' });
	assert.equal(runner.status, 0, `run.mjs --dry-run exited ${runner.status}:\n${runner.stdout}\n${runner.stderr}`);
	assert.doesNotMatch(runner.stderr, /\[runner\] warning/);
});

test('a ticket that would collide with the top level stops the ship, naming every collision, and changes nothing', async () => {
	const repo = await makeRepo({
		backlog: [ticket('2-sync-ui.md'), ticket('Notes.md')],
		'backlog/GA': [ticket('sync-ui.md'), ticket('notes.md'), ticket('fine.md')],
		plan: [ticket('session.md', 'target: BETA')],
	}, { releases: RELEASES });
	const tree = snapshot(repo.repoRoot);
	const before = commitCount(repo);

	const run = release(repo.repoRoot, 'ship');

	assert.equal(run.status, 1, run.stdout);
	assert.match(run.stderr, /backlog\/GA\/notes\.md would collide with backlog\/Notes\.md/);
	assert.match(run.stderr, /backlog\/GA\/sync-ui\.md would collide with backlog\/2-sync-ui\.md/);
	assert.deepEqual(snapshot(repo.repoRoot), tree);
	assert.equal(commitCount(repo), before);
	assert.equal(repo.git('status', '--porcelain'), '');

	await assert.rejects(applyShip(await planShip(repo.ticketsDir), { repoRoot: repo.repoRoot }), /plan with errors/);
});

test('shipping the only listed release leaves a list with no entries and says every ticket is current', async () => {
	const repo = await makeRepo({ plan: [ticket('session.md', 'target: BETA')] }, { releases: '# Releases\n\n## BETA\n\nCriteria.\n' });

	const run = release(repo.repoRoot, 'ship');

	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /No releases remain — every ticket is current\./);
	assert.match(run.stdout, /Tools that tag other files with release codes should strip BETA now\./);
	assert.equal(readFileSync(join(repo.ticketsDir, 'releases.md'), 'utf-8'), '# Releases\n\n');
	assert.equal(readFileSync(join(repo.ticketsDir, 'plan', 'session.md'), 'utf-8'), ticket('session.md')[1]);
	assert.equal(subject(repo), 'tess: ship release BETA');
});

test('with no folder for the next release there is nothing to move, and the ship still goes ahead', async () => {
	const repo = await makeRepo({ backlog: [ticket('top.md')], 'backlog/V2': [ticket('later.md')] }, { releases: RELEASES });

	const { plan, result } = await ship(repo);

	assert.deepEqual(
		{ next: plan.next, moves: plan.moves, removeFolder: plan.removeFolder, strips: plan.strips, errors: plan.errors },
		{ next: 'GA', moves: [], removeFolder: null, strips: [], errors: [] },
	);
	assert.deepEqual(result, { applied: true, committed: true });
	assert.equal(readFileSync(join(repo.ticketsDir, 'releases.md'), 'utf-8'), AFTER_BETA);
	assert.equal(readFileSync(join(repo.ticketsDir, 'backlog', 'V2', 'later.md'), 'utf-8'), ticket('later.md')[1]);
});

test('no release list, an empty or malformed one, or a folder named after the shipped release is an error', async () => {
	assert.deepEqual((await planShip(await makeBoard())).errors, [
		'no tickets/releases.md — without a release list there is no current release to ship',
	]);
	assert.deepEqual((await planShip(await makeBoard({}, { releases: '# Releases\n\nNothing planned.\n' }))).errors, [
		'nothing to ship — tickets/releases.md lists no releases',
	]);
	assert.deepEqual((await planShip(await makeBoard({ 'backlog/BETA': [ticket('a.md')] }, { releases: '## BETA\n## GA\n## GA\n' }))).errors, [
		'tickets/releases.md:3: release code GA is listed twice (first on line 2)',
		'backlog/BETA/ is named after the release being shipped — current tickets live directly in backlog/, so move them there first',
	]);
});

test('--dry-run prints the plan and changes nothing', async () => {
	const repo = await makeRepo(shipBoard(), { releases: RELEASES });
	const tree = snapshot(repo.repoRoot);
	const before = commitCount(repo);

	const run = release(repo.repoRoot, 'ship', '--dry-run');

	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /Ship release BETA: GA becomes the current release\./);
	assert.match(run.stdout, /backlog\/GA\/export\.md → backlog\/export\.md/);
	assert.match(run.stdout, /plan\/session\.md:4/);
	assert.match(run.stdout, /Dry run — nothing changed\./);
	assert.deepEqual(snapshot(repo.repoRoot), tree);
	assert.equal(commitCount(repo), before);
	assert.equal(repo.git('status', '--porcelain'), '');
});

test('a ship interrupted part-way through its moves, run again, reaches the same board as one that was not', async () => {
	const straight = await makeRepo(shipBoard(), { releases: RELEASES });
	await ship(straight);

	// Two of GA's three tickets are already up, stale.md still unstripped; nothing else has happened.
	const resumed = await makeRepo(shipBoard(), { releases: RELEASES });
	resumed.git('mv', 'tickets/backlog/GA/3-sync-ui.md', 'tickets/backlog/3-sync-ui.md');
	resumed.git('mv', 'tickets/backlog/GA/stale.md', 'tickets/backlog/stale.md');

	// The interruption left the tree dirty, so the re-run is --no-commit.
	const { plan, result } = await ship(resumed, { noCommit: true });

	assert.deepEqual(plan.moves, [{ from: 'backlog/GA/export.md', to: 'backlog/export.md' }]);
	assert.deepEqual(plan.strips, [{ path: 'backlog/stale.md', line: 4 }, { path: 'plan/session.md', line: 4 }]);
	assert.deepEqual(result, { applied: true, committed: false });
	assert.deepEqual(snapshot(resumed.ticketsDir), snapshot(straight.ticketsDir));
});

test('a dirty working tree refuses the ship before anything changes; --no-commit ships without committing', async () => {
	const repo = await makeRepo(shipBoard(), { releases: RELEASES });
	writeFileSync(join(repo.ticketsDir, 'backlog', 'GA', 'new.md'), ticket('new.md')[1]);
	const tree = snapshot(repo.repoRoot);
	const before = commitCount(repo);

	const dryRun = release(repo.repoRoot, 'ship', '--dry-run');
	const refused = await ship(repo);

	assert.equal(dryRun.status, 0, dryRun.stderr);
	assert.match(dryRun.stdout, /a real run would refuse to start \(a ship commits the whole tree\)/, '--dry-run reports the tree a real ship would refuse');
	assert.deepEqual(refused.result, { applied: false, committed: false });
	assert.match(refused.lines.join('\n'), /\?\? tickets\/backlog\/GA\/new\.md/);
	assert.doesNotMatch(refused.lines.join('\n'), /--dirty-tree/, 'release.mjs has no --dirty-tree flag to name');
	assert.deepEqual(snapshot(repo.repoRoot), tree);

	const applied = await ship(repo, { noCommit: true });

	assert.deepEqual(applied.result, { applied: true, committed: false });
	assert.equal(commitCount(repo), before);
	assert.equal(readFileSync(join(repo.ticketsDir, 'releases.md'), 'utf-8'), AFTER_BETA);
	assert.equal(readFileSync(join(repo.ticketsDir, 'backlog', 'new.md'), 'utf-8'), ticket('new.md')[1], 'an untracked ticket moves by plain rename');
	const status = repo.git('status', '--porcelain');
	assert.match(status, /^R  tickets\/backlog\/GA\/export\.md -> tickets\/backlog\/export\.md$/m, 'a tracked ticket moves by git mv, so its rename is staged');
	assert.match(status, /^\?\? tickets\/backlog\/new\.md$/m);
});

test('only a target: line inside the header is stripped, whatever shape the header takes', async () => {
	const ticketsDir = await makeBoard({
		plan: [
			['closing-fence.md', 'description: x\ntarget: BETA\n----\ntarget: BETA\n'],
			['yaml-fence.md', '---\ndescription: x\ntarget: BETA\n---\n\ntarget: BETA\n'],
			['no-fence.md', 'description: x\n\n---\n\ntarget: BETA\n'],
		],
		fix: [['spelling.md', 'Target:   BETA  \ntarget: BETAX\ndescription: x\n----\n']],
	}, { releases: RELEASES });

	const plan = await planShip(ticketsDir);
	await applyShip(plan, { repoRoot: dirname(ticketsDir), noCommit: true });

	assert.deepEqual(plan.strips, [
		{ path: 'fix/spelling.md', line: 1 },
		{ path: 'plan/closing-fence.md', line: 2 },
		{ path: 'plan/yaml-fence.md', line: 3 },
	]);
	const read = path => readFileSync(join(ticketsDir, path), 'utf-8');
	assert.equal(read('plan/closing-fence.md'), 'description: x\n----\ntarget: BETA\n');
	assert.equal(read('plan/yaml-fence.md'), '---\ndescription: x\n---\n\ntarget: BETA\n');
	assert.equal(read('plan/no-fence.md'), 'description: x\n\n---\n\ntarget: BETA\n', 'a rule ends an unfenced header');
	assert.equal(read('fix/spelling.md'), 'target: BETAX\ndescription: x\n----\n', 'field names match ignoring case; codes match exactly');
});

test('CRLF files keep CRLF: the list loses its first entry and a ticket its one line, byte for byte', async () => {
	const crlf = text => text.replace(/\n/g, '\r\n');
	const ticketsDir = await makeBoard({ plan: [['session.md', crlf(ticket('session.md', 'target: BETA')[1])]] }, { releases: crlf(RELEASES) });

	await applyShip(await planShip(ticketsDir), { repoRoot: dirname(ticketsDir), noCommit: true });

	assert.equal(readFileSync(join(ticketsDir, 'releases.md'), 'utf-8'), crlf(AFTER_BETA));
	assert.equal(readFileSync(join(ticketsDir, 'plan', 'session.md'), 'utf-8'), crlf(ticket('session.md')[1]));
});

test('moving more tickets than one git mv batch and the deletion guard allow still commits, because git mv stages renames', async () => {
	const many = Array.from({ length: 101 }, (_, i) => ticket(`t${i}.md`));
	const plain = await makeRepo({ 'backlog/GA': many }, { releases: RELEASES });
	const moved = await makeRepo({ 'backlog/GA': many }, { releases: RELEASES });

	const prior = process.env.TESS_MAX_DELETIONS;
	process.env.TESS_MAX_DELETIONS = '100';  // the default, pinned against the caller's environment
	let control, shipped;
	try {
		// The same moves made with a plain rename read as 101 deletions, which the guard refuses.
		for (const [name] of many) renameSync(join(plain.ticketsDir, 'backlog', 'GA', name), join(plain.ticketsDir, 'backlog', name));
		control = await captured(() => commitAll(plain.repoRoot, 'plain renames'));
		shipped = await ship(moved);
	} finally {
		if (prior === undefined) delete process.env.TESS_MAX_DELETIONS;
		else process.env.TESS_MAX_DELETIONS = prior;
	}

	assert.equal(control.value, false);
	assert.match(control.lines.join('\n'), /101 deletions exceed the safety threshold \(100\)/);
	assert.deepEqual(shipped.result, { applied: true, committed: true });
	assert.equal(moved.git('status', '--porcelain'), '');
	assert.equal(readdirSync(join(moved.ticketsDir, 'backlog')).length, 101, 'every ticket is up, and the folder is gone');
});

test('an entry in the next release folder that is not a ticket stops the ship, since the folder could not be removed', async () => {
	const repo = await makeRepo({
		'backlog/GA': [ticket('a.md'), ['notes.txt', 'notes\n'], ['.gitkeep', '']],
		'backlog/GA/old': [ticket('b.md')],
	}, { releases: RELEASES });
	const tree = snapshot(repo.repoRoot);

	const plan = await planShip(repo.ticketsDir);
	const run = release(repo.repoRoot, 'ship');

	const refusal = entry => `${entry} is not a ticket, so backlog/GA/ could not be removed — move or delete it before shipping`;
	assert.deepEqual(plan.errors, [refusal('backlog/GA/.gitkeep'), refusal('backlog/GA/notes.txt'), refusal('backlog/GA/old/')]);
	assert.equal(run.status, 1, run.stdout);
	assert.match(run.stderr, /backlog\/GA\/old\/ is not a ticket/);
	assert.deepEqual(snapshot(repo.repoRoot), tree);
});

test('a plan gone stale before it is applied is refused: the list moved on, a strip line moved, or a move destination appeared', async () => {
	// No repository, so every move is a plain rename; nothing is committed.
	const board = () => makeBoard({ 'backlog/GA': [ticket('a.md')], plan: [ticket('session.md', 'target: BETA')] }, { releases: RELEASES });
	const options = ticketsDir => ({ repoRoot: dirname(ticketsDir), noCommit: true });
	const read = (ticketsDir, ...path) => readFileSync(join(ticketsDir, ...path), 'utf-8');

	const listMoved = await board();
	const listPlan = await planShip(listMoved);
	writeFileSync(join(listMoved, 'releases.md'), AFTER_BETA);
	await assert.rejects(applyShip(listPlan, options(listMoved)), /first entry is no longer BETA; plan again/);
	assert.equal(read(listMoved, 'plan', 'session.md'), ticket('session.md', 'target: BETA')[1]);

	const lineMoved = await board();
	const linePlan = await planShip(lineMoved);
	const edited = ticket('session.md', 'difficulty: easy', 'target: BETA')[1];
	writeFileSync(join(lineMoved, 'plan', 'session.md'), edited);
	await assert.rejects(applyShip(linePlan, options(lineMoved)), /plan\/session\.md:4 no longer reads target: BETA/);
	assert.equal(read(lineMoved, 'plan', 'session.md'), edited);

	const destinationTaken = await board();
	const takenPlan = await planShip(destinationTaken);
	writeFileSync(join(destinationTaken, 'backlog', 'a.md'), 'someone else\n');
	await assert.rejects(applyShip(takenPlan, options(destinationTaken)), /backlog\/a\.md appeared since the ship was planned/);
	assert.equal(read(destinationTaken, 'backlog', 'a.md'), 'someone else\n');
	assert.equal(read(destinationTaken, 'releases.md'), RELEASES, 'the list is rewritten last, so a stopped ship still names BETA');
});

test('a ship whose commit fails exits 1 and says to commit by hand rather than ship again', async () => {
	const repo = await makeRepo(shipBoard(), { releases: RELEASES });
	const hooks = join(repo.repoRoot, '.git', 'hooks');
	mkdirSync(hooks, { recursive: true });
	writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
	const before = commitCount(repo);

	const run = release(repo.repoRoot, 'ship');

	assert.equal(run.status, 1, run.stdout);
	assert.match(run.stderr, /the commit failed \(see above\) — inspect `git status` and commit it by hand/);
	assert.match(run.stderr, /Do not run ship again to finish it: the list now starts at GA, so that would ship GA too\./);
	assert.equal(commitCount(repo), before);
	assert.equal(readFileSync(join(repo.ticketsDir, 'releases.md'), 'utf-8'), AFTER_BETA);
});

// ── release.mjs arguments ─────────────────────────────────────────────────

test('release.mjs prints usage and exits 1 for no command, an unknown command or option, or a stray argument; --help exits 0', async () => {
	const cwd = dirname(await makeBoard());

	for (const args of [[], ['launch'], ['ship', '--force'], ['ship', 'now']]) {
		const run = release(cwd, ...args);
		assert.equal(run.status, 1, `release.mjs ${args.join(' ')}`);
		assert.match(run.stderr, /Usage: node tess\/scripts\/release\.mjs ship \[--dry-run\] \[--no-commit\]/);
	}

	const help = release(cwd, '--help');
	assert.equal(help.status, 0);
	assert.match(help.stdout, /--no-commit/);
});
