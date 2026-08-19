/**
 * Tests for the clean-working-tree invariant (`inspectWorkingTree` / `reconcileWorkingTree`).
 *
 * Each case builds a throwaway git repo in the OS temp dir, seeds one commit, dirties the tree
 * in a specific shape, and asserts what reconcile did to it.  Run with:
 *
 *   cd tess && node --test scripts/lib/*.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { inspectWorkingTree, reconcileWorkingTree, DIRTY_TREE_MODES } from './git.mjs';

// ── fixtures ────────────────────────────────────────────────────────────────

/** A throwaway repo with one seed commit and a .gitignore covering `*.log` and `tmp/`. */
function makeRepo(t) {
	const dir = mkdtempSync(join(tmpdir(), 'tess-git-'));
	const run = cmd => execSync(cmd, { cwd: dir, encoding: 'utf-8', stdio: 'pipe' });
	run('git init -q');
	run('git config user.email tess@example.invalid');
	run('git config user.name "tess test"');
	run('git config commit.gpgsign false');
	writeFileSync(join(dir, '.gitignore'), '*.log\ntmp/\n');
	writeFileSync(join(dir, 'seed.txt'), 'seed\n');
	writeFileSync(join(dir, 'other.txt'), 'other\n');
	run('git add -A');
	run('git commit -q -m seed');
	t.after(() => {
		try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* windows locks .git objects */ }
	});
	return { dir, run };
}

const commitCount = dir => Number(execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf-8' }).trim());
const subject = dir => execSync('git log -1 --format=%s', { cwd: dir, encoding: 'utf-8' }).trim();
const porcelain = dir => execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' });
const filesInHead = dir => execSync('git show --name-only --format= HEAD', { cwd: dir, encoding: 'utf-8' })
	.split('\n').map(s => s.trim()).filter(Boolean);

/** Run `fn` with console.log/warn/error captured, so tests can assert on the notice. */
function captured(fn) {
	const lines = [];
	const orig = { log: console.log, warn: console.warn, error: console.error };
	const sink = (...args) => { lines.push(args.join(' ')); };
	console.log = sink; console.warn = sink; console.error = sink;
	try {
		return { result: fn(), lines };
	} finally {
		Object.assign(console, orig);
	}
}

const OWNER = { stage: 'implement', slug: '4-debt-promote-value-tree-entry' };

// ── reconcileWorkingTree ────────────────────────────────────────────────────

test('clean tree: no action, no commit, and completely silent', t => {
	const { dir } = makeRepo(t);
	const before = commitCount(dir);

	const { result, lines } = captured(() => reconcileWorkingTree(dir, { owner: OWNER, label: 'this run' }));

	assert.equal(result.action, 'clean');
	assert.deepEqual(result.entries, []);
	assert.equal(commitCount(dir), before);
	assert.deepEqual(lines, [], `expected no output on a clean tree, got:\n${lines.join('\n')}`);
});

test('dirty (modified + untracked) with an owner: salvaged under the ticket name', t => {
	const { dir } = makeRepo(t);
	const before = commitCount(dir);
	writeFileSync(join(dir, 'seed.txt'), 'seed edited\n');
	writeFileSync(join(dir, 'brand-new.json'), '{}\n');

	const { result, lines } = captured(() => reconcileWorkingTree(dir, { owner: OWNER, label: 'this run' }));

	assert.equal(result.action, 'salvaged');
	assert.equal(commitCount(dir), before + 1);
	assert.equal(subject(dir), `ticket(implement): ${OWNER.slug} (partial — salvaged from interrupted run)`);
	assert.equal(porcelain(dir), '', 'tree must be clean after salvage');

	const committed = filesInHead(dir);
	for (const p of ['seed.txt', 'brand-new.json']) {
		assert.ok(committed.includes(p), `${p} missing from salvage commit: ${committed.join(', ')}`);
	}

	const notice = lines.join('\n');
	assert.match(notice, /Working tree dirty before this run — 2 uncommitted path\(s\)/);
	assert.match(notice, /Attributing to interrupted ticket: implement\/4-debt-promote-value-tree-entry/);
});

test('untracked-only dirt is salvaged (the shape the deletion guard never saw)', t => {
	const { dir } = makeRepo(t);
	const before = commitCount(dir);
	mkdirSync(join(dir, 'vectors'));
	writeFileSync(join(dir, 'vectors', 'value-tree-entry.json'), '{}\n');

	const { result } = captured(() => reconcileWorkingTree(dir, { owner: OWNER }));

	assert.equal(result.action, 'salvaged');
	assert.equal(result.entries.length, 1);
	assert.equal(result.entries[0].code, '??');
	assert.equal(commitCount(dir), before + 1);
	assert.ok(filesInHead(dir).includes('vectors/value-tree-entry.json'));
});

test('dirty with no owner: salvaged under the honest no-ticket message', t => {
	const { dir } = makeRepo(t);
	const before = commitCount(dir);
	writeFileSync(join(dir, 'seed.txt'), 'human wip\n');

	const { result, lines } = captured(() => reconcileWorkingTree(dir, { owner: null }));

	assert.equal(result.action, 'salvaged');
	assert.equal(commitCount(dir), before + 1);
	assert.equal(subject(dir), 'tess: salvage uncommitted working tree (no ticket in progress)');
	assert.match(lines.join('\n'), /No ticket in progress/);
});

test('mode abort: no commit, tree left byte-identical', t => {
	const { dir } = makeRepo(t);
	const before = commitCount(dir);
	writeFileSync(join(dir, 'seed.txt'), 'seed edited\n');
	writeFileSync(join(dir, 'brand-new.json'), '{}\n');
	const statusBefore = porcelain(dir);

	const { result, lines } = captured(() => reconcileWorkingTree(dir, { owner: OWNER, mode: 'abort' }));

	assert.equal(result.action, 'abort');
	assert.equal(result.entries.length, 2);
	assert.equal(commitCount(dir), before);
	assert.equal(porcelain(dir), statusBefore);
	const notice = lines.join('\n');
	assert.match(notice, /Refusing to start with a dirty tree/);
	assert.match(notice, /git stash push -u/);
});

test('mode ignore: no commit, tree still dirty, but it says so', t => {
	const { dir } = makeRepo(t);
	const before = commitCount(dir);
	writeFileSync(join(dir, 'seed.txt'), 'seed edited\n');
	const statusBefore = porcelain(dir);

	const { result, lines } = captured(() => reconcileWorkingTree(dir, { owner: OWNER, mode: 'ignore' }));

	assert.equal(result.action, 'ignored');
	assert.equal(commitCount(dir), before);
	assert.equal(porcelain(dir), statusBefore);
	assert.match(lines.join('\n'), /--dirty-tree ignore/);
});

test('noCommit under mode salvage: ignored, nothing committed', t => {
	const { dir } = makeRepo(t);
	const before = commitCount(dir);
	writeFileSync(join(dir, 'seed.txt'), 'seed edited\n');

	const { result, lines } = captured(() => reconcileWorkingTree(dir, { owner: OWNER, noCommit: true }));

	assert.equal(result.action, 'ignored');
	assert.equal(commitCount(dir), before);
	assert.notEqual(porcelain(dir), '');
	assert.match(lines.join('\n'), /--no-commit/);
});

test('noCommit under mode abort: still aborts — the refusal is not a commit', t => {
	const { dir } = makeRepo(t);
	const before = commitCount(dir);
	writeFileSync(join(dir, 'seed.txt'), 'seed edited\n');
	const statusBefore = porcelain(dir);

	const { result, lines } = captured(() =>
		reconcileWorkingTree(dir, { owner: OWNER, mode: 'abort', noCommit: true }));

	assert.equal(result.action, 'abort', '--no-commit must not downgrade an explicit --dirty-tree abort into a proceed');
	assert.equal(commitCount(dir), before);
	assert.equal(porcelain(dir), statusBefore);
	assert.match(lines.join('\n'), /Refusing to start with a dirty tree/);
});

test('dryRun: notice printed, nothing committed', t => {
	const { dir } = makeRepo(t);
	const before = commitCount(dir);
	writeFileSync(join(dir, 'seed.txt'), 'seed edited\n');

	const { result, lines } = captured(() => reconcileWorkingTree(dir, { owner: OWNER, dryRun: true }));

	assert.equal(result.action, 'ignored');
	assert.equal(commitCount(dir), before);
	assert.notEqual(porcelain(dir), '');
	const notice = lines.join('\n');
	assert.match(notice, /--dry-run/);
	assert.match(notice, /would salvage it as: ticket\(implement\)/, 'a preview must name the commit a real run would make');
});

test('dryRun outranks abort: reports the refusal, does not return one', t => {
	const { dir } = makeRepo(t);
	writeFileSync(join(dir, 'seed.txt'), 'seed edited\n');

	const { result, lines } = captured(() =>
		reconcileWorkingTree(dir, { owner: OWNER, mode: 'abort', dryRun: true }));

	assert.equal(result.action, 'ignored', 'a dry run previews; it must not make run.mjs exit 1');
	assert.match(lines.join('\n'), /would refuse to start/);
});

test('deletions under the threshold are salvaged, not blocked', t => {
	const { dir } = makeRepo(t);
	const before = commitCount(dir);
	unlinkSync(join(dir, 'seed.txt'));

	const prior = process.env.TESS_MAX_DELETIONS;
	process.env.TESS_MAX_DELETIONS = '1';
	let result;
	try {
		({ result } = captured(() => reconcileWorkingTree(dir, { owner: OWNER })));
	} finally {
		if (prior === undefined) delete process.env.TESS_MAX_DELETIONS;
		else process.env.TESS_MAX_DELETIONS = prior;
	}

	// The guard is `>`, not `>=`: one deletion at a threshold of one must pass. An inverted or
	// off-by-one guard would refuse every ticket that deletes its own source file — i.e. every
	// stage transition tess performs.
	assert.equal(result.action, 'salvaged');
	assert.equal(commitCount(dir), before + 1);
	assert.equal(porcelain(dir), '');
});

test('the notice truncates long path lists instead of flooding the log', t => {
	const { dir } = makeRepo(t);
	for (let i = 0; i < 55; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x\n');

	const { result, lines } = captured(() => reconcileWorkingTree(dir, { owner: OWNER, mode: 'ignore' }));

	assert.equal(result.entries.length, 55, 'the returned entries are complete even when the notice is not');
	const listed = lines.filter(l => /^\[runner]     \?\? f\d{3}\.txt$/.test(l));
	assert.equal(listed.length, 50);
	assert.ok(lines.some(l => l.includes('… +5 more')), `expected a truncation line, got:\n${lines.join('\n')}`);
});

test('deletion guard trips during salvage: abort, no commit, tree untouched', t => {
	const { dir } = makeRepo(t);
	const before = commitCount(dir);
	unlinkSync(join(dir, 'seed.txt'));
	unlinkSync(join(dir, 'other.txt'));
	const statusBefore = porcelain(dir);

	const prior = process.env.TESS_MAX_DELETIONS;
	process.env.TESS_MAX_DELETIONS = '1';
	let result, lines;
	try {
		({ result, lines } = captured(() => reconcileWorkingTree(dir, { owner: OWNER })));
	} finally {
		if (prior === undefined) delete process.env.TESS_MAX_DELETIONS;
		else process.env.TESS_MAX_DELETIONS = prior;
	}

	assert.equal(result.action, 'abort', 'the two guards must compose — neither may silently defeat the other');
	assert.equal(commitCount(dir), before);
	assert.equal(porcelain(dir), statusBefore);
	assert.match(lines.join('\n'), /deletions exceed the safety threshold/);
});

test('gitignored paths are invisible to salvage', t => {
	const { dir } = makeRepo(t);
	mkdirSync(join(dir, 'tmp'));
	writeFileSync(join(dir, 'tmp', 'scratch.txt'), 'scratch\n');
	writeFileSync(join(dir, 'agent.log'), 'log output\n');
	writeFileSync(join(dir, 'seed.txt'), 'seed edited\n');

	const { result } = captured(() => reconcileWorkingTree(dir, { owner: OWNER }));

	assert.equal(result.action, 'salvaged');
	assert.deepEqual(result.entries.map(e => e.path), ['seed.txt']);
	assert.deepEqual(filesInHead(dir), ['seed.txt']);
});

// ── inspectWorkingTree ──────────────────────────────────────────────────────

test('inspectWorkingTree excludes dirty submodule content', () => {
	let seen = null;
	const exec = cmd => { seen = cmd; return ''; };

	const probe = inspectWorkingTree('/anywhere', { exec });

	assert.match(seen, /--ignore-submodules=dirty/,
		'without this, a repo with a dirty submodule reads as permanently dirty and every run tries a no-op salvage');
	assert.equal(probe.dirty, false);
});

test('inspectWorkingTree parses porcelain codes, paths, and deletions', () => {
	const fixture = [
		' M docs/byte-formats.md',
		'?? packages/lamina-test/src/byte-format/vectors/value-tree-entry.json',
		'D  packages/gone/removed.ts',
		' D packages/gone/also-removed.ts',
		'A  docs/a file with spaces.md',
		'R  docs/old-name.md -> docs/new-name.md',
		'',
	].join('\n');

	const probe = inspectWorkingTree('/anywhere', { exec: () => fixture });

	assert.equal(probe.dirty, true);
	assert.deepEqual(probe.entries, [
		{ code: ' M', path: 'docs/byte-formats.md' },
		{ code: '??', path: 'packages/lamina-test/src/byte-format/vectors/value-tree-entry.json' },
		{ code: 'D ', path: 'packages/gone/removed.ts' },
		{ code: ' D', path: 'packages/gone/also-removed.ts' },
		{ code: 'A ', path: 'docs/a file with spaces.md' },
		{ code: 'R ', path: 'docs/new-name.md' },
	]);
	assert.equal(probe.deletions, 2);
});

test('inspectWorkingTree tolerates CRLF-terminated porcelain output', () => {
	const fixture = ' M docs/byte-formats.md\r\n?? vectors/new.json\r\n';

	const probe = inspectWorkingTree('/anywhere', { exec: () => fixture });

	assert.deepEqual(probe.entries, [
		{ code: ' M', path: 'docs/byte-formats.md' },
		{ code: '??', path: 'vectors/new.json' },
	], 'a stray \\r would ride along on every path and break both the notice and the entry codes');
});

test('inspectWorkingTree treats no output as clean', () => {
	for (const empty of ['', '\n', undefined]) {
		const probe = inspectWorkingTree('/anywhere', { exec: () => empty });
		assert.equal(probe.dirty, false);
		assert.equal(probe.deletions, 0);
	}
});

test('DIRTY_TREE_MODES defaults to salvage first', () => {
	assert.deepEqual(DIRTY_TREE_MODES, ['salvage', 'abort', 'ignore']);
});
