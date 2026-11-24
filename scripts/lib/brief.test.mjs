/**
 * The decision brief (lib/brief.mjs): parsing, what counts as complete, lane
 * assignment, and header rewriting.  agent-rules/tickets.md § *A blocked
 * ticket carries a brief* is the specification these pin.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { briefProblems, destinationFor, laneOf, otherHeaderFields, parseBrief, parseDestination, setHeaderFields } from './brief.mjs';

const DECISION = [
	'description: May a failed read stop a cancellation.',
	'features: SUB-SUB',
	'needs: decision',
	'question: May a failed preview read stop a customer from cancelling?',
	'options:',
	'  - A: Let them confirm anyway; say the check could not run.',
	'  - B: Keep the block, and write it into the spec.',
	'recommend: A — cancelling is the customer\'s way out.',
	'if-nothing: Today\'s block goes live with the next promotion.',
	'reversible: yes — one condition and one sentence.',
	'confidence: high',
	'checked: 2026-11-23',
	'blocks-deploy: false',
	'----',
	'# Body',
	'',
	'question: this body line is not a field',
	'',
].join('\n');

const lane = content => laneOf(parseBrief(content));
const withField = (content, name, value) => setHeaderFields(content, { [name]: value });

test('a brief parses into options with keys, a recommendation and graded fields', () => {
	const brief = parseBrief(DECISION);

	assert.equal(brief.needs, 'decision');
	assert.deepEqual(brief.options, [
		{ key: 'A', text: 'Let them confirm anyway; say the check could not run.', to: null },
		{ key: 'B', text: 'Keep the block, and write it into the spec.', to: null },  // the comma does not split a list item
	]);
	assert.deepEqual(brief.recommend, { key: 'A', why: 'cancelling is the customer\'s way out.' });
	assert.deepEqual(brief.reversible, { level: 'yes', why: 'one condition and one sentence.' });
	assert.deepEqual(brief.confidence, { level: 'high', why: '' });
	assert.equal(brief.decision, null);
	assert.deepEqual(briefProblems(brief), []);
});

test('options written without keys take a letter no other option uses', () => {
	const content = DECISION.replace('  - A: Let', '  - Let').replace('  - B: Keep', '  - Keep');
	assert.deepEqual(parseBrief(content).options.map(o => o.key), ['A', 'B']);

	// A keyed B followed by an unkeyed item: by position the second would be B as well.
	const mixed = setHeaderFields(DECISION, { options: ['B: keep', 'drop it', 'a: something else'] });
	assert.deepEqual(parseBrief(mixed).options.map(o => o.key), ['B', 'C', 'a']);
});

test('in a ticket with no fence, a prose line that begins with a field name is neither read as the answer nor removed', () => {
	const unfenced = ['description: x', 'needs: decision', '', '# Title', '', 'Decision: we should keep it, in my view.', 'Ask: nothing.', ''].join('\n');

	const brief = parseBrief(unfenced);
	assert.deepEqual([brief.needs, brief.decision, brief.ask], ['decision', null, null]);
	assert.equal(laneOf(brief), 'undistilled');

	const answered = setHeaderFields(unfenced, { decision: 'other', ask: null });
	assert.equal(parseBrief(answered).decision, 'other');
	assert.ok(answered.includes('\nDecision: we should keep it, in my view.\nAsk: nothing.\n'), 'the prose is untouched');
});

test('a decision is complete only with options, a recommendation naming one, and both grades', () => {
	assert.deepEqual(briefProblems(parseBrief('description: x\n----\nbody\n')), ['no needs: field', 'no question: field', 'no checked: date']);

	const oneOption = setHeaderFields(DECISION, { options: ['A: only one'], recommend: 'C — not listed', confidence: 'maybe' });
	assert.deepEqual(briefProblems(parseBrief(oneOption)), [
		'a decision needs at least two options:',
		'recommend: C names no option',
		'confidence: maybe is not one of high, low',
	]);
});

test('an option may end with where the ticket goes if it is chosen; the arrow and stage leave its text', () => {
	const routed = setHeaderFields(DECISION, { options: [
		'A: Let them confirm anyway. → implement',
		'B: Keep the block and close this. -> Complete.',
		'C: Defer it. → backlog/GA',
		'D: Send it on → somewhere nobody has heard of',
		'E: No destination given.',
	] });

	assert.deepEqual(parseBrief(routed).options, [
		{ key: 'A', text: 'Let them confirm anyway.', to: 'implement' },
		{ key: 'B', text: 'Keep the block and close this.', to: 'complete' },
		{ key: 'C', text: 'Defer it.', to: 'backlog/GA' },
		{ key: 'D', text: 'Send it on → somewhere nobody has heard of', to: null },  // not a destination: prose
		{ key: 'E', text: 'No destination given.', to: null },
	]);
});

test('an answer\'s destination is the option\'s, else the brief\'s then:, else fix for a bug and plan otherwise', () => {
	const routed = parseBrief(setHeaderFields(DECISION, { options: ['A: Do it. → implement', 'B: Think again.'], then: 'review' }));
	assert.equal(destinationFor(routed, 'a', 'x'), 'implement');
	assert.equal(destinationFor(routed, 'B', 'x'), 'review');
	assert.equal(destinationFor(routed, 'other', 'bug-x'), 'review');

	const plain = parseBrief(DECISION);
	assert.equal(destinationFor(plain, 'A', 'decide-x'), 'plan');
	assert.equal(destinationFor(plain, 'done', 'bug-x'), 'fix');

	// `other` and `done` are answers of their own; an option may not take either as its key, and never captures one.
	const captured = parseBrief(setHeaderFields(DECISION, { options: ['A: Do it.', 'Other: Something else. → backlog'], recommend: 'A — simplest' }));
	assert.equal(destinationFor(captured, 'other', 'x'), 'plan');
	assert.deepEqual(briefProblems(captured), ['option key Other is reserved for an answer that names no option — use a letter']);

	assert.equal(parseDestination('Backlog/GA/'), 'backlog/GA');
	assert.equal(parseDestination('blocked'), null);
	assert.equal(parseDestination('plan/GA'), null);
	assert.deepEqual(briefProblems(parseBrief(setHeaderFields(DECISION, { then: 'later' }))), ['then: later is not one of fix, plan, implement, review, complete, backlog (or backlog/<CODE>)']);
});

test('an action is complete with a question and a date, and needs no options', () => {
	const action = 'needs: action\nquestion: Rotate the live payment keys.\nchecked: 2026-11-23\n----\nSteps\n';
	assert.deepEqual(briefProblems(parseBrief(action)), []);
	assert.equal(lane(action), 'do');
	assert.equal(lane(action.replace('action', 'observation')), 'do');
	assert.equal(lane(action.replace('action', 'upstream')), 'waiting');
});

test('only a reversible, confidently recommended decision is batched; the rest need thought', () => {
	assert.equal(lane(DECISION), 'batch');
	assert.equal(lane(withField(DECISION, 'reversible', 'costly — a migration')), 'think');
	assert.equal(lane(withField(DECISION, 'reversible', 'no')), 'think');
	assert.equal(lane(withField(DECISION, 'confidence', 'low — legal wording')), 'think');
});

test('an incomplete brief is undistilled, and an answered ticket is decided whatever its brief', () => {
	assert.equal(lane(withField(DECISION, 'recommend', null)), 'undistilled');
	assert.equal(lane(withField(DECISION, 'decision', 'B')), 'decided');
	assert.equal(lane('description: x\ndecision: other\n----\nbody\n'), 'decided');
});

test('setting a field replaces it in place, adds a new one to the field run, and removes on null', () => {
	const answered = setHeaderFields(DECISION, { decision: 'B', 'decision-note': 'Paige\nwords it.', decided: 'Nate, 2026-11-23' });
	const lines = answered.split('\n');

	// New fields join the header's field run — above the fence, not in the body.
	assert.deepEqual(lines.slice(13, 17), ['decision: B', 'decision-note: Paige words it.', 'decided: Nate, 2026-11-23', '----']);
	assert.equal(parseBrief(answered).decisionNote, 'Paige words it.');

	const replaced = setHeaderFields(answered, { decision: 'A', options: ['A: one', 'B: two', 'C: three'] });
	assert.equal(replaced.split('\n').filter(line => line.startsWith('decision:')).length, 1);
	assert.deepEqual(parseBrief(replaced).options.map(o => o.text), ['one', 'two', 'three']);  // the old list items went with the field
	assert.equal(replaced.split('\n').indexOf('options:'), 4);                                    // and the new list stands where the old one did

	const withdrawn = setHeaderFields(answered, { decision: null, 'decision-note': null, decided: null });
	assert.equal(withdrawn, DECISION);
});

test('a header rewrite keeps the fence shape, the body and CRLF line endings', () => {
	const yaml = ['---', 'description: x', 'prereq:', '---', '', 'decision: a body line', ''].join('\r\n');
	const out = setHeaderFields(yaml, { decision: 'done' });

	assert.deepEqual(out.split('\r\n'), ['---', 'description: x', 'prereq:', 'decision: done', '---', '', 'decision: a body line', '']);
});

test('a ticket with no fence gets a new field after its leading field run, not at the end of the file', () => {
	const unfenced = ['description: x', 'files:', '  - src/a.ts', '', '# Title', '', 'Prose with a Note: in it.', ''].join('\n');
	assert.deepEqual(setHeaderFields(unfenced, { decision: 'A' }).split('\n').slice(0, 4), ['description: x', 'files:', '  - src/a.ts', 'decision: A']);
});

test('the fields a project keeps beside the brief are reported, the brief and the answer are not', () => {
	const fields = otherHeaderFields(setHeaderFields(DECISION, { decision: 'A', ask: 'why?' }), ['description']);
	assert.deepEqual(fields, { features: 'SUB-SUB', 'blocks-deploy': 'false' });
});
