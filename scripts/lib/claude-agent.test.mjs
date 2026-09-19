/**
 * Tests for the claude adapter's session display name (`--name`).  Run with:
 *
 *   cd tess && node --test scripts/lib/*.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { claude } from './agents/claude.mjs';

const INSTRUCTION_FILE = join('logs', 'some-ticket.implement.2026-09-18T10-00-00.prompt.md');
const RUN_LABEL = 'some-ticket.implement.2026-09-18T10-00-00';

/** Run `fn` with `process.platform` and `TESS_SESSION_NAME_PREFIX` temporarily replaced. */
async function withEnv(t, { platform, prefix }, fn) {
	const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
	const savedPrefix = process.env.TESS_SESSION_NAME_PREFIX;
	Object.defineProperty(process, 'platform', { ...platformDesc, value: platform });
	if (prefix === undefined) delete process.env.TESS_SESSION_NAME_PREFIX;
	else process.env.TESS_SESSION_NAME_PREFIX = prefix;
	t.after(() => {
		Object.defineProperty(process, 'platform', platformDesc);
		if (savedPrefix === undefined) delete process.env.TESS_SESSION_NAME_PREFIX;
		else process.env.TESS_SESSION_NAME_PREFIX = savedPrefix;
	});
	return fn();
}

test('--name uses TESS_SESSION_NAME_PREFIX and precedes --append-system-prompt-file', async t => {
	const { args } = await withEnv(t, { platform: 'linux', prefix: 'sitecad-a' },
		() => claude(INSTRUCTION_FILE, '', { stage: 'implement' }));
	const nameAt = args.indexOf('--name');
	assert.notEqual(nameAt, -1);
	assert.equal(args[nameAt + 1], `tess:sitecad-a:${RUN_LABEL}`);
	assert.ok(nameAt < args.indexOf('--append-system-prompt-file'));
});

test('--name falls back to hostname() when the prefix is unset', async t => {
	const { args } = await withEnv(t, { platform: 'linux', prefix: undefined },
		() => claude(INSTRUCTION_FILE, '', { stage: 'implement' }));
	assert.equal(args[args.indexOf('--name') + 1], `tess:${hostname()}:${RUN_LABEL}`);
});

test('win32 shellCmd quotes --name and its value as separate arguments', async t => {
	const { shellCmd } = await withEnv(t, { platform: 'win32', prefix: 'sitecad-a' },
		() => claude(INSTRUCTION_FILE, '', { stage: 'implement' }));
	assert.match(shellCmd, new RegExp(`"--name" "tess:sitecad-a:${RUN_LABEL.replace(/\./g, '\\.')}" "--append-system-prompt-file"`));
});
