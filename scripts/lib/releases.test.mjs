import assert from 'node:assert/strict';
import { test } from 'node:test';

import { currentRelease, parseReleases, rankOf, readReleases, releasePlacement, serializeReleases } from './releases.mjs';
import { makeBoard } from './test-board.mjs';

const LIST = `# Releases

Preamble prose.

## BETA
due: 2026-11-01

Exit criteria for beta.

## GA

Exit criteria for GA.
`;

test('a release list parses into entries in file order, the first being current', () => {
	const releases = parseReleases(LIST);

	assert.deepEqual(releases.entries.map(e => [e.code, e.due, e.line]), [['BETA', '2026-11-01', 5], ['GA', null, 10]]);
	assert.deepEqual(releases.errors, []);
	assert.equal(releases.preamble, '# Releases\n\nPreamble prose.\n\n');
	assert.equal(currentRelease(releases), 'BETA');
	assert.equal(rankOf(releases, 'GA'), 1);
	assert.equal(rankOf(releases, 'RC'), -1);
});

test('parse then serialize is byte-identical, LF and CRLF alike', () => {
	const crlf = LIST.replace(/\n/g, '\r\n');
	for (const text of [LIST, crlf, LIST.trimEnd(), `﻿${LIST}`, '']) {
		assert.equal(serializeReleases(parseReleases(text)), text);
	}

	const parsed = parseReleases(crlf);
	assert.deepEqual(parsed.entries.map(e => [e.code, e.due]), [['BETA', '2026-11-01'], ['GA', null]]);
	assert.deepEqual(parsed.errors, []);
});

test('each entry keeps its exact source slice, so dropping one leaves the rest byte-identical', () => {
	const releases = parseReleases(LIST.replace(/\n/g, '\r\n'));

	const shipped = serializeReleases({ ...releases, entries: releases.entries.slice(1) });

	assert.equal(shipped, '# Releases\r\n\r\nPreamble prose.\r\n\r\n## GA\r\n\r\nExit criteria for GA.\r\n');
});

test('due: is read only from the first non-blank line after a heading, in any case, and must be a real date', () => {
	const releases = parseReleases([
		'## BETA', '', 'due: 2028-02-29',  // leap day, after a blank line
		'## GA', 'due: 2026-02-30',
		'## RC', 'due: next week',
		'## V2', 'Some prose first.', 'due: 2026-13-01',  // not the first line: exit-criteria text
		'## V3', 'Due: 2027-01-01',
		'',
	].join('\n'));

	assert.deepEqual(releases.entries.map(e => e.due), ['2028-02-29', null, null, null, '2027-01-01']);
	assert.deepEqual(releases.errors, [
		'tickets/releases.md:5: due: 2026-02-30 is not a real calendar date',
		'tickets/releases.md:7: due: "next week" is not a date — write due: YYYY-MM-DD',
	]);
});

test('a release code must be an uppercase letter then 1–7 uppercase letters or digits', () => {
	const releases = parseReleases('## beta\n## GA-1\n## A\n## V2\n## ABCDEFGHI\n');

	assert.deepEqual(releases.errors.map(e => e.split(':')[1]), ['1', '2', '3', '5']);
	assert.equal(releases.errors[0], 'tickets/releases.md:1: "beta" is not a release code — use an uppercase letter followed by 1–7 uppercase letters or digits');
});

test('a code listed twice is an error naming both lines', () => {
	const releases = parseReleases('## BETA\n## GA\n\n## BETA\n');

	assert.deepEqual(releases.errors, ['tickets/releases.md:4: release code BETA is listed twice (first on line 1)']);
});

test('a ## line inside a fenced code block is exit-criteria text, not an entry', () => {
	const text = '# Releases\n\n## BETA\n\n```markdown\n## NOTANENTRY\n```\n\n## GA\n';

	const releases = parseReleases(text);

	assert.deepEqual(releases.entries.map(e => e.code), ['BETA', 'GA']);
	assert.deepEqual(releases.errors, []);
	assert.equal(serializeReleases(releases), text);
});

test('an empty release list is present with no entries — everything is current', async () => {
	const releases = await readReleases(await makeBoard({}, { releases: '' }));

	assert.equal(releases.present, true);
	assert.deepEqual(releases.entries, []);
	assert.equal(currentRelease(releases), null);
	assert.deepEqual(parseReleases('# Releases\n\nNothing planned yet.\n').entries, []);
});

test('an absent release list turns the release model off', async () => {
	const releases = await readReleases(await makeBoard());

	assert.deepEqual(releases, { present: false, preamble: '', entries: [], errors: [] });
});

test('only a folder named after a listed, non-current code places a ticket in a later release', () => {
	const releases = parseReleases(LIST);
	const off = { present: false, preamble: '', entries: [], errors: [] };

	assert.deepEqual(releasePlacement(releases, 'GA'), { releaseRank: 1, release: 'GA' });
	assert.deepEqual(releasePlacement(releases, null), { releaseRank: 0, release: 'BETA' });
	assert.deepEqual(releasePlacement(releases, 'BETA'), { releaseRank: 0, release: 'BETA' });
	assert.deepEqual(releasePlacement(releases, 'sanjay'), { releaseRank: 0, release: 'BETA' });
	assert.deepEqual(releasePlacement(off, 'GA'), { releaseRank: 0, release: null });
});
