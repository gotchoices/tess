import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ageInDays } from './backlog-age.mjs';

const DAY = 24 * 60 * 60;
const T1 = 1_700_000_000;

test('age counts whole days and never goes below zero', () => {
	assert.equal(ageInDays(T1, T1 + 60 * DAY - 1), 59);
	assert.equal(ageInDays(T1, T1 + 60 * DAY), 60);
	assert.equal(ageInDays(T1 + DAY, T1), 0);
});
