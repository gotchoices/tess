import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { findUnsatisfiedPrereq, indexAllTickets, parseDifficulty, parsePrereqs, prereqNotes, resolvePrereqs } from './tickets.mjs';
import { TOMBSTONE_FILE } from './tombstones.mjs';

const tempDirs = [];
after(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/**
 * A tickets/ tree from a `{ stage: [filename, ...] }` map plus optional
 * tombstone records.  No git: prereq resolution reads the board and the
 * ledger, nothing else.
 */
async function makeBoard(stages = {}, tombstoneRecords = []) {
	const dir = await mkdtemp(join(tmpdir(), 'tess-tickets-test-'));
	tempDirs.push(dir);
	const ticketsDir = join(dir, 'tickets');
	for (const [stage, files] of Object.entries(stages)) {
		await mkdir(join(ticketsDir, stage), { recursive: true });
		for (const file of files) {
			await writeFile(join(ticketsDir, stage, file), 'description: x\n----\nbody\n', 'utf-8');
		}
	}
	await mkdir(ticketsDir, { recursive: true });
	if (tombstoneRecords.length > 0) {
		const lines = tombstoneRecords.map(r => JSON.stringify(r) + '\n').join('');
		await writeFile(join(ticketsDir, TOMBSTONE_FILE), lines, 'utf-8');
	}
	return ticketsDir;
}

const ticket = (slug, stage, prereqs) => ({ slug, stage, prereqs, file: `${slug}.md` });

const TOMB = { slug: 'session-store', file: '3-session-store.md', completedAt: '2026-01-02', commit: 'abcdef1234567890', prunedAt: '2026-02-04T00:00:00.000Z' };

test('a prereq with a tombstone but no ticket file resolves as pruned, not unknown', async () => {
	const ticketsDir = await makeBoard({ implement: ['user-model.md'] }, [TOMB]);
	const index = await indexAllTickets(ticketsDir);

	const [resolution] = resolvePrereqs(ticket('user-model', 'implement', ['session-store']), index);

	assert.equal(resolution.status, 'pruned');
	assert.equal(resolution.completedAt, '2026-01-02');
	assert.equal(resolution.commit, 'abcdef1234567890');
});

test('a tombstoned prereq satisfies its dependent instead of deferring it', async () => {
	const ticketsDir = await makeBoard({ implement: ['user-model.md'] }, [TOMB]);

	const unsatisfied = await findUnsatisfiedPrereq(ticket('user-model', 'implement', ['session-store']), ticketsDir);

	assert.equal(unsatisfied, null);
});

test('the runner reports a tombstoned prereq as completed and pruned', async () => {
	const ticketsDir = await makeBoard({ implement: ['user-model.md'] }, [TOMB]);
	const index = await indexAllTickets(ticketsDir);

	const notes = prereqNotes(resolvePrereqs(ticket('user-model', 'implement', ['session-store']), index));

	assert.deepEqual(notes, ['prereq "session-store": completed 2026-01-02, pruned, commit abcdef12']);
});

test('a slug matching neither the board nor a tombstone stays unknown and stays visible', async () => {
	const ticketsDir = await makeBoard({ implement: ['user-model.md'] }, [TOMB]);
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
	const ticketsDir = await makeBoard({ implement: ['user-model.md'], plan: ['session-store.md'] }, [TOMB]);
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
