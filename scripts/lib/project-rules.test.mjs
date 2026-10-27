import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { anchorFieldsOf, anchorsRequiredBy, parseProjectRule, readProjectRules, runnerShardsOf } from './project-rules.mjs';
import { makeBoard } from './test-board.mjs';

const BAD_NAME = 'is not a field name — use a lowercase letter followed by lowercase letters, digits or hyphens';

test('a fenced declaration header is parsed, and the body is everything after its closing fence', () => {
	const text = '---\nanchor-fields: features, aspects\nowner: rubric\n---\nRule text.\n\nMore.\n';

	assert.deepEqual(parseProjectRule('rubric.md', text), {
		rule: { name: 'rubric.md', body: 'Rule text.\n\nMore.\n', anchorFields: ['features', 'aspects'], runnerShards: null },
		errors: [],
	});
});

test('anchor-fields: takes the bracket and list forms; a four-dash fence, CRLF endings and a byte-order mark change nothing', () => {
	const bracket = parseProjectRule('a.md', '﻿----\r\nanchor-fields: [features]\r\n----\r\nBody\r\n');
	const list = parseProjectRule('b.md', '---\nanchor-fields:\n  - features\n  - aspects\n---\nBody\n');

	assert.deepEqual(bracket, { rule: { name: 'a.md', body: 'Body\n', anchorFields: ['features'], runnerShards: null }, errors: [] });
	assert.deepEqual(list.rule.anchorFields, ['features', 'aspects']);
});

test('a file whose first line is not a fence is all body and declares nothing', () => {
	const text = 'anchor-fields: features\n\nProse that happens to start like a field.\n---\nMore prose.\n';

	assert.deepEqual(parseProjectRule('plain.md', text), { rule: { name: 'plain.md', body: text, anchorFields: [], runnerShards: null }, errors: [] });
});

test('an invalid field name is an error naming the file; the valid names still count, tess\'s own architecture among them', () => {
	const { rule, errors } = parseProjectRule('bad.md', '---\nanchor-fields: Features, feat_x, aspects, architecture\n---\nBody\n');

	assert.deepEqual(rule.anchorFields, ['aspects', 'architecture']);
	assert.deepEqual(errors, [
		`tickets/rules/bad.md: anchor-fields: "Features" ${BAD_NAME}`,
		`tickets/rules/bad.md: anchor-fields: "feat_x" ${BAD_NAME}`,
	]);
});

test('an opening fence with no closing fence is an unterminated-header error, and the file appends and declares nothing', () => {
	const { rule, errors } = parseProjectRule('open.md', '---\nanchor-fields: features\nRule text.\n');

	assert.deepEqual(rule, { name: 'open.md', body: '', anchorFields: [], runnerShards: null });
	assert.deepEqual(errors, ['tickets/rules/open.md: unterminated header — line 1 is a fence with no closing fence, so the file appends and declares nothing']);
});

test('readProjectRules reads the .md files directly inside tickets/rules/, in code-unit filename order', async () => {
	// Code-unit order, not natural order: `10-` sorts before `9-`, and uppercase before lowercase.
	const ticketsDir = await makeBoard({
		rules: [['b.md', 'b\n'], ['a.md', 'a\n'], ['Z.md', 'Z\n'], ['9-y.md', '9\n'], ['10-x.md', '10\n'], ['notes.txt', 'ignored\n']],
		'rules/nested': [['deep.md', 'ignored\n']],
	});

	const { rules, errors } = await readProjectRules(ticketsDir);

	assert.deepEqual(rules.map(r => [r.name, r.body]), [['10-x.md', '10\n'], ['9-y.md', '9\n'], ['Z.md', 'Z\n'], ['a.md', 'a\n'], ['b.md', 'b\n']]);
	assert.deepEqual(errors, []);
});

test('readProjectRules collects the errors of every file, in file order', async () => {
	const ticketsDir = await makeBoard({ rules: [['2.md', '---\n'], ['1.md', '---\nanchor-fields: X\n---\n']] });

	const { rules, errors } = await readProjectRules(ticketsDir);

	assert.deepEqual(rules.map(r => r.name), ['1.md', '2.md']);
	assert.deepEqual(errors, [`tickets/rules/1.md: anchor-fields: "X" ${BAD_NAME}`, 'tickets/rules/2.md: unterminated header — line 1 is a fence with no closing fence, so the file appends and declares nothing']);
});

test('no tickets/rules/ means no rules and no errors; a file in its place is an error', async () => {
	const absent = await makeBoard({});
	const asFile = await makeBoard({});
	await writeFile(join(asFile, 'rules'), 'not a folder\n', 'utf-8');

	assert.deepEqual(await readProjectRules(absent), { rules: [], errors: [] });
	assert.deepEqual(await readProjectRules(asFile), { rules: [], errors: ['tickets/rules is a file — project rules are .md files inside a tickets/rules/ folder'] });
});

test('anchorFieldsOf puts architecture first, then the declared fields in file order, each once', () => {
	const rules = [
		{ name: 'a.md', body: '', anchorFields: ['features', 'aspects'] },
		{ name: 'b.md', body: '', anchorFields: ['aspects', 'features', 'risks'] },
	];

	assert.deepEqual(anchorFieldsOf(rules), ['architecture', 'features', 'aspects', 'risks']);
	assert.deepEqual(anchorFieldsOf([]), ['architecture']);
});

test('anchors are required only once an addendum lists a field — architecture alone is enough to opt in', () => {
	const none = { name: 'prose.md', body: 'Rules only.', anchorFields: [] };
	assert.equal(anchorsRequiredBy([]), false);
	assert.equal(anchorsRequiredBy([none]), false);
	assert.equal(anchorsRequiredBy([none, { name: 'a.md', body: '', anchorFields: ['architecture'] }]), true);
	assert.equal(anchorsRequiredBy([{ name: 'r.md', body: '', anchorFields: ['features'] }]), true);
});

test('runner-shards: a whole number of 2 or more declares the count; anything else, or two addenda disagreeing, is an error that declares nothing', () => {
	const NOT_A_COUNT = 'is not a runner count — use a whole number of 2 or more';
	const rows = [
		{ files: [['a.md', 'Prose only.\n']], runnerShards: null, errors: [] },
		{ files: [['a.md', '---\nrunner-shards: 2\n---\n']], runnerShards: { count: 2, declaredIn: ['tickets/rules/a.md'] }, errors: [] },
		{ files: [['a.md', '---\nrunner-shards: 3\n---\n'], ['b.md', '---\nanchor-fields: features\nrunner-shards: 3\n---\nBody\n']], runnerShards: { count: 3, declaredIn: ['tickets/rules/a.md', 'tickets/rules/b.md'] }, errors: [] },
		...['two', '1', '0', '2.5', ''].map(value => ({
			files: [['a.md', `---\nrunner-shards: ${value}\n---\n`]],
			runnerShards: null,
			errors: [`tickets/rules/a.md: runner-shards: "${value}" ${NOT_A_COUNT}`],
		})),
		{
			files: [['a.md', '---\nrunner-shards: 2\n---\n'], ['b.md', '---\nrunner-shards: 3\n---\n']],
			runnerShards: null,
			errors: ['runner-shards: tickets/rules/a.md says 2, tickets/rules/b.md says 3 — declare one count, or the same count everywhere'],
		},
	];

	for (const { files, runnerShards, errors } of rows) {
		const parsed = files.map(([name, text]) => parseProjectRule(name, text));
		const folded = runnerShardsOf(parsed.map(p => p.rule));
		assert.deepEqual({ runnerShards: folded.runnerShards, errors: [...parsed.flatMap(p => p.errors), ...folded.errors] }, { runnerShards, errors }, JSON.stringify(files));
	}
});
