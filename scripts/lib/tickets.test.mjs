import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
	deferralReason,
	discoverTickets,
	findTicketBySlug,
	findUnsatisfiedPrereq,
	headerFieldLines,
	indexAllTickets,
	bypassesReview,
	declinesCurrentStage,
	nextStageFor,
	parseDifficulty,
	parseListField,
	parsePrereqs,
	parseReview,
	parseTarget,
	transitionLabel,
	prereqNotes,
	resolvePrereqs,
} from './tickets.mjs';
import { TOMBSTONE_FILE } from './tombstones.mjs';
import { makeBoard, withHeader } from './test-board.mjs';

const ticket = (slug, stage, prereqs) => ({ slug, stage, prereqs, file: `${slug}.md` });

const TOMB = { slug: 'session-store', file: '3-session-store.md', completedAt: '2026-01-02', commit: 'abcdef1234567890', prunedAt: '2026-02-04T00:00:00.000Z' };

test('a prereq with a tombstone but no ticket file resolves as pruned, not unknown', async () => {
	const ticketsDir = await makeBoard({ implement: ['user-model.md'] }, { tombstones: [TOMB] });
	const index = await indexAllTickets(ticketsDir);

	const [resolution] = resolvePrereqs(ticket('user-model', 'implement', ['session-store']), index);

	assert.equal(resolution.status, 'pruned');
	assert.equal(resolution.completedAt, '2026-01-02');
	assert.equal(resolution.commit, 'abcdef1234567890');
});

test('a tombstoned prereq satisfies its dependent instead of deferring it', async () => {
	const ticketsDir = await makeBoard({ implement: ['user-model.md'] }, { tombstones: [TOMB] });

	const unsatisfied = await findUnsatisfiedPrereq(ticket('user-model', 'implement', ['session-store']), ticketsDir);

	assert.equal(unsatisfied, null);
});

test('the runner reports a tombstoned prereq as completed and pruned', async () => {
	const ticketsDir = await makeBoard({ implement: ['user-model.md'] }, { tombstones: [TOMB] });
	const index = await indexAllTickets(ticketsDir);

	const notes = prereqNotes(resolvePrereqs(ticket('user-model', 'implement', ['session-store']), index));

	assert.deepEqual(notes, ['prereq "session-store": completed 2026-01-02, pruned, commit abcdef12']);
});

test('a slug matching neither the board nor a tombstone stays unknown and stays visible', async () => {
	const ticketsDir = await makeBoard({ implement: ['user-model.md'] }, { tombstones: [TOMB] });
	const index = await indexAllTickets(ticketsDir);
	const dependent = ticket('user-model', 'implement', ['never-existed']);

	const [resolution] = resolvePrereqs(dependent, index);

	assert.equal(resolution.status, 'unknown');
	assert.equal(await findUnsatisfiedPrereq(dependent, ticketsDir), null);  // unchanged: assumed complete
	assert.deepEqual(prereqNotes([resolution]), ['prereq "never-existed": not on the board and no tombstone — unknown, assumed complete']);
});

test('a live ticket outranks a stale tombstone for the same slug', async () => {
	// A slug reopened after an earlier completion must resolve to where it now
	// sits, so the dependent still defers on it.
	const ticketsDir = await makeBoard({ implement: ['user-model.md'], plan: ['session-store.md'] }, { tombstones: [TOMB] });
	const index = await indexAllTickets(ticketsDir);

	assert.equal(index.get('session-store').pruned, undefined);
	const unsatisfied = await findUnsatisfiedPrereq(ticket('user-model', 'implement', ['session-store']), ticketsDir, index);
	assert.deepEqual({ slug: unsatisfied?.slug, stage: unsatisfied?.stage }, { slug: 'session-store', stage: 'plan' });
});

test('a prereq resolved on the board produces no note', async () => {
	const ticketsDir = await makeBoard({ implement: ['user-model.md'], complete: ['session-store.md'] });
	const index = await indexAllTickets(ticketsDir);

	const resolutions = resolvePrereqs(ticket('user-model', 'implement', ['session-store']), index);

	assert.deepEqual(resolutions.map(r => r.status), ['satisfied']);
	assert.deepEqual(prereqNotes(resolutions), []);
});

test('a damaged tombstone ledger degrades to skipping bad lines rather than failing the run', async () => {
	const ticketsDir = await makeBoard({ implement: ['user-model.md'] });
	await writeFile(
		join(ticketsDir, TOMBSTONE_FILE),
		`not json at all\n{"slug":"","completedAt":"2026-01-01"}\n${JSON.stringify(TOMB)}\n`,
		'utf-8',
	);
	const index = await indexAllTickets(ticketsDir);

	assert.equal(index.get('session-store').pruned, true);
	assert.equal(index.size, 2);
});

// ── Backlog sub-folders and releases ──────────────────────────────────────

const RELEASES = '# Releases\n\n## BETA\n\n## GA\n\n## V2\n';

/** The fields of an index record that say where it sits. */
const placeOf = record => ({ stage: record.stage, folder: record.folder, releaseRank: record.releaseRank });

test('discovery reads backlog sub-folders only when asked, one level deep, skipping dot-folders and non-.md files', async () => {
	const ticketsDir = await makeBoard({
		backlog: ['top.md', 'notes.txt'],
		'backlog/GA': ['deferred.md', 'readme.txt'],
		'backlog/GA/nested': ['too-deep.md'],
		'backlog/.hidden': ['hidden.md'],
	}, { releases: RELEASES });

	const plain = await discoverTickets(ticketsDir, 'backlog', Infinity);
	const withFolders = await discoverTickets(ticketsDir, 'backlog', Infinity, { includeFolders: true });

	assert.deepEqual(plain.map(t => t.slug), ['top']);
	assert.deepEqual(withFolders.map(t => [t.slug, t.folder, t.releaseRank, t.release]), [['top', null, 0, 'BETA'], ['deferred', 'GA', 1, 'GA']]);
	// Identity is unchanged: the folder is part of the path, not of the file name or slug.
	assert.equal(withFolders[1].file, 'deferred.md');
	assert.equal(withFolders[1].path, join(ticketsDir, 'backlog', 'GA', 'deferred.md'));
});

test('the index always includes backlog folder tickets: top level first, folders in name order', async () => {
	const ticketsDir = await makeBoard({
		backlog: ['shared.md'],
		'backlog/GA': ['shared.md', 'in-both.md'],
		'backlog/V2': ['in-both.md', 'only-v2.md'],
		'backlog/V2/nested': ['too-deep.md'],
	}, { releases: RELEASES, tombstones: [TOMB] });

	const index = await indexAllTickets(ticketsDir);

	assert.deepEqual(placeOf(index.get('shared')), { stage: 'backlog', folder: null, releaseRank: 0 });
	assert.deepEqual(placeOf(index.get('in-both')), { stage: 'backlog', folder: 'GA', releaseRank: 1 });
	assert.deepEqual(placeOf(index.get('only-v2')), { stage: 'backlog', folder: 'V2', releaseRank: 2 });
	assert.deepEqual(placeOf(index.get('session-store')), { stage: 'complete', folder: null, releaseRank: 0 });
	assert.equal(index.has('too-deep'), false);
});

test('findTicketBySlug looks inside backlog folders when backlog is one of the stages searched', async () => {
	const ticketsDir = await makeBoard({ 'backlog/GA': [['2-parked.md', withHeader('target: GA', 'prereq: a')]] }, { releases: RELEASES });

	const found = await findTicketBySlug(ticketsDir, 'parked', ['blocked', 'backlog']);

	assert.deepEqual(
		[found.stage, found.folder, found.file, found.releaseRank, found.target, found.prereqs],
		['backlog', 'GA', '2-parked.md', 1, 'GA', ['a']],
	);
	assert.equal(await findTicketBySlug(ticketsDir, 'parked', ['plan']), null);
});

test('a discovered ticket carries its target: and its header region', async () => {
	const content = '---\ndescription: x\ntarget: GA\n---\n\ntarget: V2 in the body is prose\n';
	const ticketsDir = await makeBoard({ implement: [['x.md', content], 'plain.md'] }, { releases: RELEASES });

	const tickets = await discoverTickets(ticketsDir, 'implement', Infinity);
	const bySlug = Object.fromEntries(tickets.map(t => [t.slug, t]));

	assert.equal(bySlug.x.target, 'GA');
	assert.equal(bySlug.x.header, 'description: x\ntarget: GA');
	assert.equal(bySlug.plain.target, null);
	assert.equal(parseTarget('---\ntarget:\nprereq: a\n---\n'), null);  // an empty field is absent
});

test('a prereq deferred to a later release is release-order: it defers the dependent and says which way to move', async () => {
	const ticketsDir = await makeBoard({
		implement: [['user-model.md', withHeader('prereq: session-store')]],
		'backlog/GA': ['session-store.md'],
	}, { releases: RELEASES });
	const [dependent] = await discoverTickets(ticketsDir, 'implement', Infinity);
	const index = await indexAllTickets(ticketsDir);

	const [resolution] = resolvePrereqs(dependent, index);

	const message = 'prereq "session-store" is deferred to release GA (backlog/GA/) but this ticket is due in BETA — pull the prereq into backlog/ or defer this ticket to backlog/GA/';
	assert.equal(resolution.status, 'release-order');
	assert.equal(resolution.folder, 'GA');
	assert.equal((await findUnsatisfiedPrereq(dependent, ticketsDir, index))?.slug, 'session-store');
	assert.equal(deferralReason(resolution), message);
	assert.deepEqual(prereqNotes([resolution]), [message]);
});

test('a top-level backlog ticket whose prereq sits in a release folder is release-order', async () => {
	// The --stages backlog case: the dependent is current, its prereq is not.
	const ticketsDir = await makeBoard({
		backlog: [['promote-me.md', withHeader('prereq: later')]],
		'backlog/V2': ['later.md'],
	}, { releases: RELEASES });
	const [dependent] = await discoverTickets(ticketsDir, 'backlog', Infinity);

	const [resolution] = resolvePrereqs(dependent, await indexAllTickets(ticketsDir));

	assert.equal(resolution.status, 'release-order');
});

test('without releases.md, a prereq in a curated backlog folder is behind, not unknown', async () => {
	const ticketsDir = await makeBoard({
		implement: [['user-model.md', withHeader('prereq: session-store')]],
		'backlog/post-release-features': ['session-store.md'],
	});
	const [dependent] = await discoverTickets(ticketsDir, 'implement', Infinity);

	const [resolution] = resolvePrereqs(dependent, await indexAllTickets(ticketsDir));

	assert.equal(resolution.status, 'behind');
	assert.equal(deferralReason(resolution), 'prereq "session-store" is in backlog/post-release-features/');
	assert.deepEqual(prereqNotes([resolution]), []);
});

test('a top-level backlog ticket whose prereq sits in a backlog folder is behind: the topo sort never sees folder tickets', async () => {
	// Same stage normally means "the topo sort orders it", but `--stages backlog` snapshots the top
	// level only, so nothing would stop the dependent being promoted ahead of its parked prereq.
	const ticketsDir = await makeBoard({
		backlog: [['promote-me.md', withHeader('prereq: parked, sibling')], 'sibling.md'],
		'backlog/libraries': ['parked.md'],
	});
	const dependent = (await discoverTickets(ticketsDir, 'backlog', Infinity)).find(t => t.slug === 'promote-me');

	const resolutions = resolvePrereqs(dependent, await indexAllTickets(ticketsDir));

	assert.deepEqual(resolutions.map(r => [r.slug, r.status]), [['parked', 'behind'], ['sibling', 'satisfied']]);
});

test('release order only looks forward: a prereq in the same or an earlier release is judged by stage and folder', async () => {
	const ticketsDir = await makeBoard({
		'backlog/V2': [['late.md', withHeader('prereq: early, same, current')], 'same.md'],
		'backlog/GA': ['early.md'],
		plan: ['current.md'],
	}, { releases: RELEASES });
	const late = (await discoverTickets(ticketsDir, 'backlog', Infinity, { includeFolders: true })).find(t => t.slug === 'late');

	const resolutions = resolvePrereqs(late, await indexAllTickets(ticketsDir));

	// None is release-order.  `early` is behind only because it sits in another folder: nothing has promoted it yet.
	assert.deepEqual(resolutions.map(r => [r.slug, r.status]), [['early', 'behind'], ['same', 'satisfied'], ['current', 'satisfied']]);
});

// An empty header field used to swallow the following line, so `prereq:` with
// nothing after it turned the next field's value into bogus prereq slugs — the
// noise the tombstone-aware reporting made visible.
test('an empty prereq: field yields no prereqs instead of consuming the next header line', () => {
	const content = 'description: x\nprereq:\nfiles: packages/a.ts, packages/b.ts\ndifficulty: hard\n----\nbody\n';

	assert.deepEqual(parsePrereqs(content), []);
	assert.equal(parseDifficulty(content), 'hard');
});

test('a populated prereq: field still parses, stripping sequence prefixes and .md', () => {
	const content = 'description: x\nprereq: 3-session-store, user-model.md\nfiles: packages/a.ts\n----\nbody\n';

	assert.deepEqual(parsePrereqs(content), ['session-store', 'user-model']);
});

// ── Header fencing ────────────────────────────────────────────────────────
// The corpus uses three shapes, and the header must be delimited correctly in
// all of them. Census of this repo's 643 tickets at the time of writing: 433
// open with `---`, 56 with `----`, 154 carry no fence at all. Fixtures are
// written as template literals with real newlines rather than '\n' escapes, so
// the fence characters are unambiguous on the page.

const FOUR_DASH = `----
description: x
prereq: session-store, user-model
difficulty: hard
----

## Body

prereq: this-is-prose-not-a-field
`;

const THREE_DASH = `---
description: x
prereq: session-store, user-model
difficulty: hard
---

## Body

prereq: this-is-prose-not-a-field
`;

const UNFENCED = `description: x
prereq: session-store, user-model
difficulty: hard

## Body
`;

test('a four-dash fenced header parses its fields', () => {
	assert.deepEqual(parsePrereqs(FOUR_DASH), ['session-store', 'user-model']);
	assert.equal(parseDifficulty(FOUR_DASH), 'hard');
});

test('a three-dash fenced header parses its fields rather than collapsing to empty', () => {
	// The regression to guard: treating the opening `---` as the *closing*
	// divider empties the header region and silently drops every prereq in the
	// three-dash majority of the corpus.
	assert.deepEqual(parsePrereqs(THREE_DASH), ['session-store', 'user-model']);
	assert.equal(parseDifficulty(THREE_DASH), 'hard');
});

test('an unfenced header parses its fields', () => {
	assert.deepEqual(parsePrereqs(UNFENCED), ['session-store', 'user-model']);
	assert.equal(parseDifficulty(UNFENCED), 'hard');
});

test('a fenced header stops at its closing fence, so body prose is never read as a field', () => {
	for (const [shape, content] of [['four-dash', FOUR_DASH], ['three-dash', THREE_DASH]]) {
		assert.ok(!parsePrereqs(content).includes('this-is-prose-not-a-field'), `${shape} leaked body prose into prereqs`);
	}
});

test('an unfenced header stops at a horizontal rule in the body', () => {
	const content = `description: x
prereq: session-store

---

## Body

prereq: this-is-prose-not-a-field
`;

	assert.deepEqual(parsePrereqs(content), ['session-store']);
});

test('headerFieldLines gives every matching header line with its 1-based line number, and nothing from the body', () => {
	const content = '---\ndescription: x\ntarget: BETA\nTARGET:  GA \n---\ntarget: V2\n';

	assert.deepEqual(headerFieldLines(content, 'target'), [{ line: 3, value: 'BETA' }, { line: 4, value: 'GA' }]);
	assert.deepEqual(headerFieldLines('description: x\r\nprereq:\r\nfiles: a.ts\r\n----\r\n', 'prereq|files'), [
		{ line: 2, value: '' },
		{ line: 3, value: 'a.ts' },
	]);
});

test('an empty field in a three-dash header does not swallow the next line', () => {
	const content = `---
description: x
prereq:
files: packages/a.ts, packages/b.ts
difficulty: easy
---
body
`;

	assert.deepEqual(parsePrereqs(content), []);
	assert.equal(parseDifficulty(content), 'easy');
});

// Regression guard for a subtle escaping trap: the field pattern is assembled
// in a template literal, where `\S` degrades to a bare `S`. Combined with the
// `i` flag that turns `[^\S\r\n]*` into "any char but s", which eats the
// value's leading characters up to its first `s` — `easy` reads as `sy`.
test('a field value keeps its leading characters, including before an "s"', () => {
	const content = `---
difficulty: easy
prereq: session-store, weather-ops-v1, hydrology-erosion-analysis
---
body
`;

	assert.equal(parseDifficulty(content), 'easy');
	assert.deepEqual(parsePrereqs(content), ['session-store', 'weather-ops-v1', 'hydrology-erosion-analysis']);
});

test('a tab after the colon is skipped like a space', () => {
	assert.equal(parseDifficulty('---\ndifficulty:\thard\n---\n'), 'hard');
});

// ── List-valued header fields ─────────────────────────────────────────────

test('parseListField reads the comma, bracket and indented-list forms, dropping quotes', () => {
	const listForm = ['---', 'description: x', 'features:', '  - SIT-BRA', '\t- "SIT-CRT"', 'files:', '  - packages/a.ts', '---', ''].join('\n');

	assert.deepEqual(parseListField('features: SIT-BRA, SIT-CRT\n----\n', 'features'), ['SIT-BRA', 'SIT-CRT']);
	assert.deepEqual(parseListField('features: [ "SIT-BRA", \'SIT-CRT\' ]\n----\n', 'features'), ['SIT-BRA', 'SIT-CRT']);
	assert.deepEqual(parseListField(listForm, 'features'), ['SIT-BRA', 'SIT-CRT']);  // stops at `files:`
});

test('parseListField yields nothing for an absent field, an empty one, or one holding only empty items', () => {
	for (const content of [
		'description: x\n----\n',
		'features:\nfiles: a.ts\n----\n',
		'features: []\n----\n',
		'features: [ ]\n----\n',
		'features: , ""\n----\n',
		'features:\n  -\n  - ""\n----\n',
	]) {
		assert.deepEqual(parseListField(content, 'features'), [], JSON.stringify(content));
	}
});

test('the list form ends at the first line that is not an indented item, and at the end of the header', () => {
	assert.deepEqual(parseListField('features:\n  - A\n\n  - B\n----\n', 'features'), ['A']);  // a blank line ends it
	assert.deepEqual(parseListField('features:\n- A\n----\n', 'features'), []);  // an unindented dash is not an item
	assert.deepEqual(parseListField('features:\n---\n  - A\n', 'features'), []);  // an unfenced header ends at a rule
});

test('parseListField matches the name case-insensitively, reads only the header, and accepts a cut-out header region', async () => {
	const content = '---\ndescription: x\nFeatures: A\n---\n\nfeatures: B is body prose\n';
	const ticketsDir = await makeBoard({ implement: [['x.md', content]] });
	const [ticket] = await discoverTickets(ticketsDir, 'implement', Infinity);

	assert.deepEqual(parseListField(content, 'features'), ['A']);
	assert.deepEqual(parseListField(ticket.header, 'features'), ['A']);
	assert.deepEqual(parseListField(content, 'aspects'), []);
});

// ── `review:` and the per-ticket stage graph ──────────────────────────────

/** The one implement/ ticket of a board whose header holds `lines`. */
async function implementTicket(...lines) {
	const ticketsDir = await makeBoard({ implement: [['x.md', withHeader(...lines)]] });
	const [ticket] = await discoverTickets(ticketsDir, 'implement', Infinity);
	return ticket;
}

test('parseReview reads the field lowercased, and treats an absent or empty one as null', () => {
	assert.equal(parseReview('---\ndescription: x\nreview: skip\n---\n'), 'skip');
	assert.equal(parseReview('---\ndescription: x\nReview: SKIP\n---\n'), 'skip');
	assert.equal(parseReview('---\ndescription: x\nreview:\nfiles: a.ts\n---\n'), null);
	assert.equal(parseReview('---\ndescription: x\n---\n\nreview: skip is body prose\n'), null);
	assert.equal(parseReview(withHeader()), null);
});

test('an implement ticket declaring review: skip advances to complete instead of review', async () => {
	const ticket = await implementTicket('review: skip');

	assert.equal(ticket.review, 'skip');
	assert.equal(bypassesReview(ticket), true);
	assert.equal(nextStageFor(ticket), 'complete');
	assert.equal(transitionLabel(ticket), 'implement → complete (review skipped — review: skip)');
});

test('without the field — or with a value that is not skip — an implement ticket still goes to review', async () => {
	for (const lines of [[], ['review: none'], ['review: false'], ['review: skipped']]) {
		const ticket = await implementTicket(...lines);

		assert.equal(bypassesReview(ticket), false, JSON.stringify(lines));
		assert.equal(nextStageFor(ticket), 'review', JSON.stringify(lines));
		assert.equal(transitionLabel(ticket), 'implement → review', JSON.stringify(lines));
	}
});

test('review: skip is inert outside implement/, and a terminal stage still advances nowhere', async () => {
	const ticketsDir = await makeBoard({
		plan: [['p.md', withHeader('review: skip')]],
		review: [['r.md', withHeader('review: skip')]],
		complete: [['c.md', withHeader('review: skip')]],
	});
	const [plan] = await discoverTickets(ticketsDir, 'plan', Infinity);
	const [review] = await discoverTickets(ticketsDir, 'review', Infinity);
	const [complete] = await discoverTickets(ticketsDir, 'complete', Infinity);

	assert.equal(nextStageFor(plan), 'implement');       // the field names one edge: implement → review
	assert.equal(nextStageFor(review), 'complete');      // not re-read as "skip the complete stage"
	assert.equal(nextStageFor(complete), null);
	assert.equal(declinesCurrentStage(review), true);    // …but it is not ours to work in review/
	assert.equal(declinesCurrentStage(plan), false);
});
