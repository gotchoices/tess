import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { addResumeNote } from './state.mjs';
import { discoverTickets, headerField, parseListField } from './tickets.mjs';
import { readBoardContext, ticketProblems } from './board-check.mjs';
import { makeBoard } from './test-board.mjs';

// `anchor-fields: architecture` turns on the anchor requirement tested below —
// without an addendum, `ticketProblems` never checks for one at all, so a note
// landing inside the header would go unnoticed by this test.
const RULES = ['----', 'anchor-fields: architecture', '----', ''].join('\n');

const BODY = ['# Heading', '', 'Body line one.', 'Body line two.', ''].join('\n');

const FENCE_SHAPES = {
	'opened and closed (--- … ---)': [
		'---',
		'description: x',
		'architecture: docs/example.md',
		'prereq: other-ticket',
		'difficulty: hard',
		'---',
		BODY,
	].join('\n'),
	'closing-fence-only (the ticket template shape)': [
		'description: x',
		'architecture: docs/example.md',
		'prereq: other-ticket',
		'difficulty: hard',
		'---',
		BODY,
	].join('\n'),
	'no fence anywhere': [
		'description: x',
		'architecture: docs/example.md',
		'prereq: other-ticket',
		'difficulty: hard',
		BODY,
	].join('\n'),
};

const PRIOR_RUN_1 = { startedAt: '2026-09-15T05:49:13.784Z', agent: 'claude', logFile: 'tickets/.logs/a.log' };
const PRIOR_RUN_2 = { startedAt: '2026-09-15T09:00:00.000Z', agent: 'claude', logFile: 'tickets/.logs/b.log' };

/** The fields a misplaced note has, historically, corrupted: the parsed header, `prereq:`/`difficulty:`, and runnability. */
async function readFields(ticketsDir) {
	const [ticket] = await discoverTickets(ticketsDir, 'implement', Infinity);
	const context = await readBoardContext(ticketsDir);
	return {
		path: ticket.path,
		description: headerField(ticket.header, 'description'),
		architecture: parseListField(ticket.header, 'architecture'),
		difficulty: ticket.difficulty,
		prereqs: ticket.prereqs,
		problems: ticketProblems(ticket, context),
	};
}

for (const [shape, content] of Object.entries(FENCE_SHAPES)) {
	test(`addResumeNote leaves the header readable — ${shape}`, async () => {
		const ticketsDir = await makeBoard({ implement: [['t.md', content]], rules: [['rubric-anchors.md', RULES]] });

		const before = await readFields(ticketsDir);
		assert.deepEqual(before.problems, [], 'ticket must be runnable before the note is added');
		assert.equal(before.description, 'x');
		assert.deepEqual(before.architecture, ['docs/example.md']);
		assert.equal(before.difficulty, 'hard');
		assert.deepEqual(before.prereqs, ['other-ticket']);

		await addResumeNote(before.path, PRIOR_RUN_1);
		const after = await readFields(ticketsDir);

		assert.deepEqual(after, before);
	});

	test(`addResumeNote replaces rather than stacks a second note — ${shape}`, async () => {
		const ticketsDir = await makeBoard({ implement: [['t.md', content]], rules: [['rubric-anchors.md', RULES]] });
		const before = await readFields(ticketsDir);

		await addResumeNote(before.path, PRIOR_RUN_1);
		await addResumeNote(before.path, PRIOR_RUN_2);

		const raw = await readFile(before.path, 'utf-8');
		assert.equal(raw.split('<!-- resume-note -->').length - 1, 1, 'exactly one note, not stacked');
		assert.match(raw, /Log file: tickets\/\.logs\/b\.log/);
		assert.doesNotMatch(raw, /a\.log/);

		const after = await readFields(ticketsDir);
		assert.deepEqual(after, before);
	});
}
