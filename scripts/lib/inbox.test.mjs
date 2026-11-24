/**
 * The human's inbox (lib/inbox.mjs): what `readInbox` derives for each blocked
 * ticket, when the distill pass is due, and the one-file commits an answer
 * makes.  The write tests run git in a temp repository.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { availableDestinations, distillReasons, dueForDistill, pathsChangedSince, readDecided, readInbox, recordAsk, recordDecision, requestDistillStop, takeDistillStop, ticketFilePaths, waitingOnBlocked, withdrawDecision } from './inbox.mjs';
import { discoverTickets, indexAllTickets } from './tickets.mjs';
import { commitAt, git, makeBoard, withHeader } from './test-board.mjs';

const DAY = 24 * 60 * 60;
const NOW = 1_700_000_000;

const BRIEFED = withHeader(
	'needs: decision',
	'question: Keep or drop?',
	'options:',
	'  - A: Keep it.',
	'  - B: Drop it.',
	'recommend: A — nothing depends on dropping it.',
	'if-nothing: It stays.',
	'reversible: yes',
	'confidence: high',
	'checked: 2026-11-01',
	'files: src/a.ts (the parser, ~l.40), docs/a.md',
);

/** A board in a git repository, committed at `NOW - 3 days`, with identity set so plain `git commit` works. */
async function committedBoard(places) {
	const ticketsDir = await makeBoard(places);
	const repo = dirname(ticketsDir);
	git(repo, ['init', '-q']);
	git(repo, ['config', 'user.name', 'Inbox Test']);
	git(repo, ['config', 'user.email', 'inbox@example.invalid']);
	git(repo, ['config', 'commit.gpgsign', 'false']);
	await commitAt(repo, NOW - 3 * DAY, async () => {});
	return { ticketsDir, repo };
}

const subjects = repo => git(repo, ['log', '--format=%s']).trim().split('\n');
/** Every path HEAD's commit touched, a move shown as both its ends. */
const filesOfHead = repo => git(repo, ['show', '--name-only', '--no-renames', '--format=', 'HEAD']).trim().split('\n').sort();

/** `BRIEFED` with a destination on each option: A resumes implementation, B leaves nothing to do. */
const ROUTED = BRIEFED.replace('  - A: Keep it.', '  - A: Keep it. → implement').replace('  - B: Drop it.', '  - B: Drop it and close this. -> complete');
const RELEASES = '# Releases\n\n## BETA\n\n## GA\n';
const ANSWER = { who: 'Nate', date: '2026-11-23', commit: false };
const exists = async path => readFile(path, 'utf-8').then(() => true, () => false);

test('an entry carries its brief, its lane, what waits on it and how long it has sat in blocked/', async () => {
	const { ticketsDir } = await committedBoard({
		blocked: [['keep-or-drop.md', BRIEFED], 'no-brief.md'],
		implement: [['uses-it.md', withHeader('prereq: keep-or-drop')]],
		plan: [['uses-that.md', withHeader('prereq: uses-it')]],
		complete: [['done.md', withHeader('prereq: keep-or-drop')]],
	});

	const [briefed, bare] = await readInbox(ticketsDir, { nowSeconds: NOW });

	assert.equal(briefed.slug, 'keep-or-drop');
	assert.equal(briefed.lane, 'batch');
	assert.equal(briefed.ageDays, 3);
	// Transitive, and without the completed ticket: finished work waits on nothing.
	assert.deepEqual(briefed.waiting.map(w => `${w.stage}/${w.slug}`).sort(), ['implement/uses-it', 'plan/uses-that']);
	assert.deepEqual(briefed.fields, { architecture: 'docs/example.md' });

	assert.equal(bare.lane, 'undistilled');
	assert.deepEqual(bare.waiting, []);
});

test('a blocked ticket waiting on another blocked ticket is listed as waiting on it', async () => {
	const ticketsDir = await makeBoard({ blocked: ['first.md', ['second.md', withHeader('prereq: first')]] });
	const waiting = waitingOnBlocked(await indexAllTickets(ticketsDir, { withPrereqs: true }));
	assert.deepEqual(waiting.get('first'), [{ slug: 'second', stage: 'blocked' }]);
});

test('files: yields paths without the notes written after them', () => {
	assert.deepEqual(ticketFilePaths(BRIEFED), ['src/a.ts', 'docs/a.md']);
	assert.deepEqual(ticketFilePaths('files:\n  - packages/x/src/b.ts (`fn` ~l.3, and more)\n  - README.md   # top\n  - the build output\n----\n'), ['packages/x/src/b.ts', 'README.md']);
});

test('the distill pass is due for a missing brief, a question sent back, or files changed since the check', async () => {
	const { ticketsDir, repo } = await committedBoard({ blocked: [['keep-or-drop.md', BRIEFED], 'no-brief.md'] });
	const [briefed, bare] = await readInbox(ticketsDir);

	assert.deepEqual(distillReasons(briefed), []);
	assert.deepEqual(distillReasons(briefed, { all: true }), ['a full re-check was requested (--all)']);
	assert.match(distillReasons(bare)[0], /^its brief is missing or incomplete: no needs: field/);

	// Nothing the ticket names has been committed since its check.
	assert.deepEqual(pathsChangedSince(repo, ['src/a.ts', 'docs'], '2026-11-01'), []);

	// A commit dated after the check, touching one named file and one file under a named directory.
	const after = Math.floor(Date.parse('2026-11-05T12:00:00Z') / 1000);
	await commitAt(repo, after, async () => {
		await mkdir(join(repo, 'src'), { recursive: true });
		await mkdir(join(repo, 'docs'), { recursive: true });
		await writeFile(join(repo, 'src', 'a.ts'), 'changed');
		await writeFile(join(repo, 'docs', 'b.md'), 'changed');
	});
	const changed = pathsChangedSince(repo, ['src/a.ts', 'docs', 'src/other.ts'], '2026-11-01');
	assert.deepEqual(changed, ['src/a.ts', 'docs']);
	assert.deepEqual(pathsChangedSince(repo, ['src/a.ts'], '2026-11-05'), [], 'a change on the day of the check is not after it');
	assert.match(distillReasons(briefed, { changedPaths: changed })[0], /^files it names changed after it was last checked \(2026-11-01\): src\/a\.ts, docs$/);
});

test('the pass works what is due, most-waited-on first; a named ticket is worked whether due or not; an answered one never', async () => {
	const ticketsDir = await makeBoard({
		blocked: [['current.md', BRIEFED], 'no-brief.md', 'unblocks-two.md', ['answered-by-hand.md', withHeader('decision: other')]],
		implement: [['x.md', withHeader('prereq: unblocks-two')], ['y.md', withHeader('prereq: unblocks-two')]],
	});
	const slugs = async options => (await dueForDistill(ticketsDir, options)).map(d => d.entry.slug);

	assert.deepEqual(await slugs(), ['unblocks-two', 'no-brief']);
	assert.deepEqual(await slugs({ all: true }), ['unblocks-two', 'current', 'no-brief']);
	assert.deepEqual(await slugs({ only: new Set(['current', 'answered-by-hand']) }), ['current']);
});

test('the pass has a stop request of its own, taken once, and leaves the runner\'s stop file alone', async () => {
	const ticketsDir = await makeBoard({ blocked: [] });
	await writeFile(join(ticketsDir, '.stop'), '');

	assert.equal(await takeDistillStop(ticketsDir), false);
	await requestDistillStop(ticketsDir);
	assert.equal(await takeDistillStop(ticketsDir), true);
	assert.equal(await takeDistillStop(ticketsDir), false);
	assert.ok(await exists(join(ticketsDir, '.stop')), 'tickets/.stop is the runner\'s to consume');
});

test('an answer moves the ticket out of blocked/ in one commit that touches nothing else, and the runner finds it as an ordinary ticket', async () => {
	const { ticketsDir, repo } = await committedBoard({ blocked: [['keep-or-drop.md', BRIEFED]], implement: ['other.md'] });
	const other = join(ticketsDir, 'implement', 'other.md');
	await writeFile(other, withHeader('difficulty: hard'));  // someone else's uncommitted edit
	await writeFile(join(repo, 'stray.txt'), 'untracked');

	const result = await recordDecision(ticketsDir, 'keep-or-drop.md', { decision: 'B', note: ' not worth keeping ', who: 'Nate', date: '2026-11-23' });

	// No destination on the option or the brief, and not a bug: it goes to plan/.
	assert.deepEqual({ changed: result.changed, movedTo: result.movedTo, committed: result.committed, error: result.error }, { changed: true, movedTo: 'plan', committed: true, error: null });
	assert.equal(subjects(repo)[0], 'decision: keep-or-drop — B → plan');
	assert.deepEqual(filesOfHead(repo), ['tickets/blocked/keep-or-drop.md', 'tickets/plan/keep-or-drop.md']);
	assert.match(git(repo, ['status', '--porcelain']), /^ M tickets\/implement\/other\.md\n\?\? stray\.txt\n$/);

	// blocked/ holds only what still waits on a human; the answered ticket is listed from where it went.
	assert.deepEqual(await readInbox(ticketsDir), []);
	const [decided] = await readDecided(ticketsDir);
	assert.deepEqual([decided.stage, decided.lane, decided.brief.decision, decided.brief.decisionNote, decided.brief.decided], ['plan', 'decided', 'B', 'not worth keeping', 'Nate, 2026-11-23']);

	// The runner needs no notion of an answered blocked ticket: it is a plan ticket that carries the answer.
	const [ticket] = await discoverTickets(ticketsDir, 'plan', Infinity);
	assert.deepEqual([ticket.slug, ticket.decision], ['keep-or-drop', 'B']);
});

test('where an answer sends the ticket: the option\'s own stage, else the brief\'s then:, else fix/ for a bug and plan/ otherwise — unless the human says', async () => {
	const withThen = BRIEFED.replace('checked:', 'then: review\nchecked:');
	const ticketsDir = await makeBoard({
		blocked: [['resume.md', ROUTED], ['close.md', ROUTED], ['after.md', withThen], ['bug-wrong-total.md', BRIEFED], ['later.md', ROUTED], ['override.md', ROUTED]],
	}, { releases: RELEASES });
	const sent = async (file, decision, to) => (await recordDecision(ticketsDir, file, { ...ANSWER, decision, note: 'n', to })).movedTo;

	assert.equal(await sent('resume.md', 'A'), 'implement');
	assert.equal(await sent('close.md', 'B'), 'complete');
	assert.equal(await sent('after.md', 'A'), 'review');
	assert.equal(await sent('bug-wrong-total.md', 'other'), 'fix');
	assert.equal(await sent('override.md', 'A', 'plan'), 'plan');
	assert.equal(await sent('later.md', 'B', 'backlog/GA'), 'backlog/GA');
	assert.ok(await exists(join(ticketsDir, 'backlog', 'GA', 'later.md')));
	assert.ok(await exists(join(ticketsDir, 'complete', 'close.md')));
	assert.ok(!await exists(join(ticketsDir, 'blocked', 'close.md')));

	assert.deepEqual(await availableDestinations(ticketsDir), ['fix', 'plan', 'implement', 'review', 'complete', 'backlog', 'backlog/GA']);
});

test('an answer is refused, and the ticket left where it is, for a stage that is not a destination, an unlisted release, or a name already taken there', async () => {
	const ticketsDir = await makeBoard({ blocked: [['a.md', ROUTED], ['clash.md', ROUTED]], review: ['clash.md'] }, { releases: RELEASES });

	await assert.rejects(recordDecision(ticketsDir, 'a.md', { ...ANSWER, decision: 'A', to: 'blocked' }), /"blocked" is not a stage an answered ticket can go to/);
	await assert.rejects(recordDecision(ticketsDir, 'a.md', { ...ANSWER, decision: 'A', to: 'backlog/BETA' }), /backlog\/BETA is not a later release/);   // the current release
	await assert.rejects(recordDecision(ticketsDir, 'a.md', { ...ANSWER, decision: 'A', to: 'backlog/V9' }), /backlog\/V9 is not a later release/);
	// The same slug already sits further along the board: answering would make a second copy.
	await assert.rejects(recordDecision(ticketsDir, 'clash.md', { ...ANSWER, decision: 'A' }), /clash is also filed in review\//);

	assert.equal(await readFile(join(ticketsDir, 'blocked', 'a.md'), 'utf-8'), ROUTED);
});

test('withdrawing an answer brings the ticket back to blocked/ byte for byte, from wherever it was sent; a question sent back stays put', async () => {
	const { ticketsDir, repo } = await committedBoard({ blocked: [['keep-or-drop.md', ROUTED]] });
	const path = join(ticketsDir, 'blocked', 'keep-or-drop.md');

	const asked = await recordAsk(ticketsDir, 'keep-or-drop.md', { question: 'What does dropping it cost?' });
	assert.equal(asked.movedTo, null);
	assert.equal((await readInbox(ticketsDir))[0].brief.ask, 'What does dropping it cost?');
	assert.equal(subjects(repo)[0], 'ask: keep-or-drop');

	// An answer supersedes the open question, and this one closes the ticket.
	await recordDecision(ticketsDir, 'keep-or-drop.md', { decision: 'B', who: 'Nate', date: '2026-11-23' });
	const [closed] = await readDecided(ticketsDir, { nowSeconds: Date.parse('2026-11-25T00:00:00Z') / 1000 });
	assert.deepEqual([closed.stage, closed.brief.ask], ['complete', null]);
	// A closed ticket keeps its answer for good, so it is listed for a week and no longer.
	assert.deepEqual(await readDecided(ticketsDir, { nowSeconds: Date.parse('2026-12-05T00:00:00Z') / 1000 }), []);

	const back = await withdrawDecision(ticketsDir, 'keep-or-drop.md');
	assert.deepEqual({ movedTo: back.movedTo, committed: back.committed }, { movedTo: 'blocked', committed: true });
	assert.equal(await readFile(path, 'utf-8'), ROUTED);
	assert.equal(subjects(repo)[0], 'decision: keep-or-drop — withdrawn');
	assert.deepEqual(filesOfHead(repo), ['tickets/blocked/keep-or-drop.md', 'tickets/complete/keep-or-drop.md']);
	assert.equal(git(repo, ['status', '--porcelain']), '');
});

test('a withdrawal whose commit failed is committed when the ticket is withdrawn again', async () => {
	const { ticketsDir, repo } = await committedBoard({ blocked: [['keep-or-drop.md', ROUTED]] });
	await recordDecision(ticketsDir, 'keep-or-drop.md', { decision: 'A', who: 'Nate', date: '2026-11-23' });

	// The move back lands; the commit is skipped, as when git could not take its lock.
	await withdrawDecision(ticketsDir, 'keep-or-drop.md', { commit: false });
	assert.match(git(repo, ['status', '--porcelain']), /^ D tickets\/implement\/keep-or-drop\.md\n\?\? tickets\/blocked\/$/m);

	const retried = await withdrawDecision(ticketsDir, 'keep-or-drop.md');
	assert.deepEqual({ changed: retried.changed, movedTo: retried.movedTo, committed: retried.committed, error: retried.error }, { changed: false, movedTo: 'blocked', committed: true, error: null });
	assert.equal(subjects(repo)[0], 'decision: keep-or-drop — withdrawn');
	assert.equal(git(repo, ['status', '--porcelain']), '');

	// With nothing left to commit, it is what it looks like: a ticket nobody has answered.
	await assert.rejects(withdrawDecision(ticketsDir, 'keep-or-drop.md'), /carries no decision:/);
});

test('an answer an agent has already applied cannot be withdrawn, nor one the runner is working right now', async () => {
	const ticketsDir = await makeBoard({ blocked: [['keep-or-drop.md', ROUTED]], plan: ['applied.md'] });

	await assert.rejects(withdrawDecision(ticketsDir, 'applied.md', { commit: false }), /applied \(plan\/\) carries no decision:/);
	await assert.rejects(withdrawDecision(ticketsDir, 'never-existed.md', { commit: false }), /no ticket "never-existed" on the board/);

	await recordDecision(ticketsDir, 'keep-or-drop.md', { ...ANSWER, decision: 'A' });
	await writeFile(join(ticketsDir, '.in-progress'), JSON.stringify({ slug: 'keep-or-drop', stage: 'implement', file: 'keep-or-drop.md' }));
	await assert.rejects(withdrawDecision(ticketsDir, 'keep-or-drop.md', { commit: false }), /being worked by the runner right now/);
	assert.ok(await exists(join(ticketsDir, 'implement', 'keep-or-drop.md')));
});

test('a board that declares done-field: gets it written with a done answer, removed on withdrawal, and never with any other answer', async () => {
	const step = 'needs: action\nquestion: Rotate the keys.\nchecked: 2026-11-01\nblocks-deploy: true\n----\nSteps\n';
	const ticketsDir = await makeBoard({
		blocked: [['rotate-keys.md', step], ['keep-or-drop.md', BRIEFED]],
		rules: [['project.md', '---\ndone-field: step-performed\n---\n']],
	});
	const read = async (stage, file) => readFile(join(ticketsDir, stage, file), 'utf-8');

	await recordDecision(ticketsDir, 'rotate-keys.md', { ...ANSWER, decision: 'done', note: 'Both backends.' });
	assert.match(await read('plan', 'rotate-keys.md'), /^step-performed: Nate, 2026-11-23$/m);
	// The project's field is the project's: it is reported beside the brief, not hidden as part of the answer.
	assert.equal((await readDecided(ticketsDir)).find(e => e.slug === 'rotate-keys').fields['step-performed'], 'Nate, 2026-11-23');

	await withdrawDecision(ticketsDir, 'rotate-keys.md', { commit: false });
	assert.equal(await read('blocked', 'rotate-keys.md'), step);

	await recordDecision(ticketsDir, 'keep-or-drop.md', { ...ANSWER, decision: 'A' });
	assert.doesNotMatch(await read('plan', 'keep-or-drop.md'), /step-performed/);
});

test('a write names a ticket in blocked/ by bare file name, and nothing else', async () => {
	const ticketsDir = await makeBoard({ blocked: ['a.md'], implement: ['b.md'] });
	const answer = { decision: 'other', note: 'Do neither.', who: 'Nate', commit: false };

	await assert.rejects(recordDecision(ticketsDir, '../implement/b.md', answer), /not a ticket file name/);
	await assert.rejects(recordDecision(ticketsDir, 'missing.md', answer), /no longer in blocked/);
	await assert.rejects(recordDecision(ticketsDir, 'a.md', { ...answer, decision: '  ' }), /needs a value/);

	const result = await recordDecision(ticketsDir, 'a.md', answer);
	assert.deepEqual({ changed: result.changed, movedTo: result.movedTo, committed: result.committed }, { changed: true, movedTo: 'plan', committed: false });
});

test('an answer naming an option the ticket does not have is refused, so a stale page cannot record one', async () => {
	const ticketsDir = await makeBoard({ blocked: [['keep-or-drop.md', BRIEFED], 'no-brief.md'] });
	const answer = { who: 'Nate', commit: false };

	await assert.rejects(recordDecision(ticketsDir, 'keep-or-drop.md', { ...answer, decision: 'C' }), /"C" is not one of this ticket's options \(A, B\)/);
	await assert.rejects(recordDecision(ticketsDir, 'no-brief.md', { ...answer, decision: 'A' }), /options \(none\)/);
	assert.equal(await readFile(join(ticketsDir, 'blocked', 'keep-or-drop.md'), 'utf-8'), BRIEFED);

	await recordDecision(ticketsDir, 'keep-or-drop.md', { ...answer, decision: 'b' });  // keys compare without case
	assert.equal((await readDecided(ticketsDir))[0].brief.decision, 'b');
});

test('an answer whose commit failed is committed when the same answer is given again', async () => {
	const { ticketsDir, repo } = await committedBoard({ blocked: [['keep-or-drop.md', ROUTED]] });
	const answer = { decision: 'A', who: 'Nate', date: '2026-11-23' };

	// The move lands; the commit is skipped, as when git could not take its lock.
	await recordDecision(ticketsDir, 'keep-or-drop.md', { ...answer, commit: false });
	assert.match(git(repo, ['status', '--porcelain']), /^ D tickets\/blocked\/keep-or-drop\.md/);

	const retried = await recordDecision(ticketsDir, 'keep-or-drop.md', answer);
	assert.deepEqual({ changed: retried.changed, movedTo: retried.movedTo, committed: retried.committed, error: retried.error }, { changed: false, movedTo: 'implement', committed: true, error: null });
	assert.equal(subjects(repo)[0], 'decision: keep-or-drop — A → implement');
	assert.equal(git(repo, ['status', '--porcelain']), '');

	// Once it is in, giving it a third time is a no-op, not an error; a different answer is told the ticket has gone.
	const again = await recordDecision(ticketsDir, 'keep-or-drop.md', answer);
	assert.deepEqual({ changed: again.changed, committed: again.committed, error: again.error }, { changed: false, committed: false, error: null });
	await assert.rejects(recordDecision(ticketsDir, 'keep-or-drop.md', { ...answer, decision: 'B' }), /no longer in blocked/);
});
